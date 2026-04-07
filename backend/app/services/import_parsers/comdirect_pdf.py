"""
comdirect PDF parser — two-section statement format.

Layout per section
──────────────────
  Girokonto :  Buchungstag | Valuta | Vorgang/Referenz | Auftraggeber/Empfänger | Buchungstext | Ausgang | Eingang
  Visa Karte:  Buchungstag | Valuta | Vorgang/Referenz | Buchungstext            | Ausgang     | Eingang

Sign convention (already in PDF):
  Ausgang column → money leaving  → stored as negative.
  Eingang column → money entering → stored as positive.
  In the merged "Ausgang Eingang" column negative values are Ausgänge.

Filters:
  • "Visa-Kartenabrechnung" rows are inter-account transfers → always removed.

Parser priority:
  1. parse_comdirect_pdf_tables  — pdfplumber structured table extraction
  2. parse_comdirect_pdf_words   — word-position-based (x-coordinate column detection)
  3. parse_comdirect_pdf_text    — regex text fallback (legacy)
"""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime
from typing import Dict, List, Optional, Tuple

# ── Constants ──────────────────────────────────────────────────

DATE_FMT = "%d.%m.%Y"
DATE_RE = re.compile(r"^(\d{2}\.\d{2}\.\d{4})$")

# Row descriptions that represent internal account-to-account transfers
_INTERNAL_RE = re.compile(
    r"visa.{0,4}karten.{0,4}abrechnung|"
    r"kartenabrechnung|"
    r"visa\s+card\s+settlement",
    re.IGNORECASE,
)

# X-coordinate threshold — words to the right of this are in the amount column.
# Words to the left are dates or description text and must NOT be parsed as amounts.
_AMT_X_THRESHOLD = 480

# Header/footer keywords — lines containing these (without a date) are skipped.
# Also covers AlterSaldo/NeuerSaldo (account balance rows, not transactions).
_HEADER_KEYWORDS = re.compile(
    r"^\s*(buchungstag|valuta|vorgang|auftraggeber|buchungstext|"
    r"ausgang|eingang|seite\s+\d|iban|bic|saldo|alter\s*saldo|neuer\s*saldo|"
    r"altersaldo|neuersaldo|kontoübersicht|finanzreport|"
    r"kontonummer|blz|bic\/swift|kundennummer|dispositionskredit|"
    r"visalimit|verfügungslimit)\b",
    re.IGNORECASE,
)

# DEPOTBESTAND / depot-value lines — these appear in Buchungstext column and
# contain numbers (share counts) that must NOT be treated as transaction amounts.
_DEPOTBESTAND_RE = re.compile(r"DEPOTBESTAND", re.IGNORECASE)

# Section heading detection — these patterns, when matched against a description-only
# line (no date, no amount), identify the start of a new account section.
# mapped to: ('girokonto' | 'visa' | 'skip')
_SECTION_HEADING_PATTERNS = [
    # Girokonto section — may appear as "Girokonto" or "Girokonto DE0620…"
    (re.compile(r"^Girokonto\b", re.IGNORECASE), "girokonto"),
    # Visa card section — e.g. "Visa-Karte2501" or "Visa Karte 4871…"
    (re.compile(r"^Visa[-\s]?Karte\s*\d+", re.IGNORECASE), "visa"),
    # Savings / Tagesgeld section — skip (internal transfer mirror)
    (re.compile(r"^Tagesgeld\b|^TagesgeldPLUS\b|^Festgeld\b", re.IGNORECASE), "skip"),
    # Depot / investment section — skip (no spendable transactions)
    (re.compile(r"^Depot\b|^Depotbestand\b", re.IGNORECASE), "skip"),
]

# Row description patterns that are account balance rows, not spendable transactions
_BALANCE_ROW_RE = re.compile(
    r"^\s*(Alter\s*Saldo|Neuer\s*Saldo|AlterSaldo|NeuerSaldo)\b",
    re.IGNORECASE,
)

# ── Comdirect detection ────────────────────────────────────────

def is_comdirect_pdf(text: str) -> bool:
    """Return True if extracted PDF text looks like a comdirect statement."""
    lower = text.lower()
    return (
        "comdirect" in lower
        or (
            "girokonto" in lower
            and "buchungstag" in lower
            and ("ausgang" in lower or "eingang" in lower)
        )
    )

# ── Amount parsing ─────────────────────────────────────────────

def _parse_amt(s: str) -> Optional[float]:
    """
    Parse German-format amounts: 1.234,56 → 1234.56, -1.234,56 → -1234.56.
    Handles explicit '+' and '-' prefixes.
    """
    s = s.strip().replace("\xa0", "").replace(" ", "")
    if not s or s in ("-", "–", "+"):
        return None
    negative = s.startswith("-")
    # Strip leading sign
    clean = s.lstrip("+-").strip()
    # German format: period = thousands sep, comma = decimal sep
    if "," in clean:
        clean = clean.replace(".", "").replace(",", ".")
    else:
        # No comma — could be integer or period-as-decimal
        if re.search(r"\.\d{2}$", clean):
            pass  # period is decimal separator — keep as-is
        else:
            clean = clean.replace(".", "")  # period is thousands separator
    try:
        val = float(clean)
        return -val if negative else val
    except ValueError:
        return None


def _looks_like_amount(text: str) -> bool:
    """Return True if the text could be a monetary amount (e.g. '1.234,56', '+8,03')."""
    return bool(re.match(r"^[+-]?\d[\d.,]*$", text.strip()))

# ── Column header sets ─────────────────────────────────────────

_BUCHUNGSTAG_H = {"buchungstag", "buchungs-\ntag", "buchungs-tag", "buchtag", "datum"}
_VALUTA_H      = {"valuta", "wertstellung", "wertst.", "valutadatum"}
_VORGANG_H     = {
    "vorgang", "vorgang/referenz", "vorgang /\nreferenz",
    "vorgang/\nreferenz", "art", "buchungsart",
}
_PAYEE_H       = {
    "auftraggeber/empfänger", "auftraggeber / empfänger",
    "auftraggeber/\nempfänger", "auftraggeber /\nempfänger",
    "empfänger/auftraggeber", "zahlungsbeteiligter",
}
_TEXT_H        = {
    "buchungstext", "buchungs-\ntext", "verwendungszweck",
    "text", "beschreibung", "referenz",
}
_AUSGANG_H     = {"ausgang", "ausgang (eur)", "ausgänge", "belastung", "debit", "ausgabe"}
_EINGANG_H     = {"eingang", "eingang (eur)", "eingänge", "gutschrift", "kredit", "einnahme"}

# ── Table-based parsing (primary) ─────────────────────────────

def parse_comdirect_pdf_tables(pdf) -> List[dict]:
    """
    Extract comdirect transactions via pdfplumber table extraction.

    Handles both sections (Girokonto + Visa Karte) automatically.
    Returns [] if no recognisable comdirect table is found.
    """
    rows: List[dict] = []
    current_section: Optional[str] = None  # "girokonto" | "visa"

    for page in pdf.pages:
        # Update section from page text
        page_text = (page.extract_text() or "").lower()
        if "girokonto" in page_text:
            current_section = "girokonto"
        if "visa" in page_text and ("karte" in page_text or "card" in page_text):
            current_section = "visa"

        tables = page.extract_tables()
        for table in tables:
            if not table or len(table) < 2:
                continue

            # Find a header row that looks comdirect-ish
            hdr_idx, col_map = _detect_comdirect_header(table)
            if hdr_idx is None:
                continue

            # Infer section from column map: Girokonto has payee column
            section = current_section
            if col_map.get("payee") is not None:
                section = "girokonto"
            elif col_map.get("payee") is None and col_map.get("text") is not None:
                if section is None:
                    section = "visa"

            # Accumulator for pending (possibly multi-line) row
            pending: Optional[dict] = None

            for raw_row in table[hdr_idx + 1:]:
                result = _parse_table_row(raw_row, col_map, section or "girokonto")
                if result is None:
                    # Possible continuation line — append text to pending
                    if pending is not None:
                        extra = _extract_text_from_row(raw_row, col_map)
                        if extra:
                            pending["description"] = (pending["description"] + " " + extra).strip()
                    continue

                if pending is not None:
                    rows.append(pending)
                pending = result

            if pending is not None:
                rows.append(pending)

    # Filter internal transfers
    return [r for r in rows if not _INTERNAL_RE.search(r.get("description", ""))]


def _detect_comdirect_header(
    table: list,
) -> Tuple[Optional[int], Dict[str, Optional[int]]]:
    """
    Scan table rows for a comdirect-style header.
    Returns (header_row_index, column_map) or (None, {}).
    """
    for idx, row in enumerate(table):
        if not row:
            continue
        normalized = [str(c or "").lower().strip() for c in row]

        has_buchungstag = any(h in _BUCHUNGSTAG_H for h in normalized)
        has_amount = any(
            h in _AUSGANG_H | _EINGANG_H for h in normalized
        )
        if not (has_buchungstag and has_amount):
            continue

        def _find(candidates: set) -> Optional[int]:
            for i, h in enumerate(normalized):
                if h in candidates:
                    return i
            return None

        col_map: Dict[str, Optional[int]] = {
            "buchungstag": _find(_BUCHUNGSTAG_H),
            "valuta":      _find(_VALUTA_H),
            "vorgang":     _find(_VORGANG_H),
            "payee":       _find(_PAYEE_H),
            "text":        _find(_TEXT_H),
            "ausgang":     _find(_AUSGANG_H),
            "eingang":     _find(_EINGANG_H),
        }
        return idx, col_map

    return None, {}


def _cell(row: list, idx: Optional[int]) -> str:
    if idx is None or idx >= len(row):
        return ""
    return str(row[idx] or "").strip()


def _extract_text_from_row(row: list, col_map: Dict[str, Optional[int]]) -> str:
    """Pull any non-empty text cell for a continuation row."""
    parts = []
    for key in ("vorgang", "payee", "text"):
        v = _cell(row, col_map.get(key))
        if v:
            parts.append(v)
    return " ".join(parts)


def _parse_table_row(
    row: list,
    col_map: Dict[str, Optional[int]],
    section: str,
) -> Optional[dict]:
    """
    Parse one table data row.
    Returns a transaction dict or None if this row is not a valid transaction.
    """
    # ── Date ──────────────────────────────────────────────────
    buchungstag_str = _cell(row, col_map.get("buchungstag"))
    valuta_str      = _cell(row, col_map.get("valuta"))

    # Use Valuta date when available, fall back to Buchungstag
    dt: Optional[datetime] = None
    for ds in (valuta_str, buchungstag_str):
        if ds:
            try:
                dt = datetime.strptime(ds, DATE_FMT)
                break
            except ValueError:
                pass

    if dt is None:
        return None  # Not a data row

    # ── Description ───────────────────────────────────────────
    vorgang = _cell(row, col_map.get("vorgang"))
    payee   = _cell(row, col_map.get("payee")) if section == "girokonto" else ""
    text    = _cell(row, col_map.get("text"))

    desc_parts = [p for p in [payee, text, vorgang] if p]
    description = " — ".join(desc_parts) if desc_parts else (vorgang or "comdirect")

    # ── Amount ────────────────────────────────────────────────
    ausgang_str = _cell(row, col_map.get("ausgang"))
    eingang_str = _cell(row, col_map.get("eingang"))

    ausgang = _parse_amt(ausgang_str) if ausgang_str else None
    eingang = _parse_amt(eingang_str) if eingang_str else None

    if ausgang is not None and abs(ausgang) > 0:
        amount = -abs(ausgang)   # Ausgang → always negative
    elif eingang is not None and abs(eingang) > 0:
        amount = abs(eingang)    # Eingang → always positive
    else:
        return None  # No amount → probably a header or summary row

    return {
        "date":        dt,
        "description": description.strip(),
        "amount":      round(amount, 2),
        "currency":    "EUR",
        "section":     section,
    }


# ── Word-position-based parsing (robust fallback) ─────────────

def parse_comdirect_pdf_words(pdf) -> List[dict]:
    """
    Word-position-based comdirect parser using pdfplumber extract_words().

    Column detection by x-coordinate:
      x < _AMT_X_THRESHOLD  → dates + description (Buchungstext numbers ignored)
      x >= _AMT_X_THRESHOLD → amount column only

    Section tracking:
      Section headings (e.g. "TagesgeldPLUS-Konto", "Visa-Karte2501") are detected
      inline from word positions.  "girokonto" and "visa" sections produce transactions;
      "skip" sections (Tagesgeld, Depot) are silently ignored.

    Fixes over the text-based parser:
      • Positive '+' prefixed amounts (Eingang / Gutschrift) are correctly parsed.
      • DEPOTBESTAND share-count numbers (x≈405, below threshold) are never misread.
      • AlterSaldo / NeuerSaldo balance rows are filtered out.
      • Tagesgeld mirror transactions (would duplicate Girokonto entries) are skipped.
    """
    rows: List[dict] = []
    # Default to girokonto; updated inline when section headings are detected.
    current_section = "girokonto"
    pending: Optional[dict] = None
    # Flag: previous line was a balance-row keyword (AlterSaldo/NeuerSaldo may be
    # split across two PDF lines where the keyword is on line N and date+amount
    # on line N+1 — we must skip line N+1 in that case).
    _skip_next_balance_tail = False

    for page in pdf.pages:
        words = page.extract_words(x_tolerance=3, y_tolerance=3)
        if not words:
            continue

        # ── Group words into visual lines by y-coordinate ─────
        line_map: Dict[int, list] = defaultdict(list)
        for w in words:
            y_key = round(float(w["top"]) / 3) * 3
            line_map[y_key].append(w)

        for y_key in sorted(line_map.keys()):
            line_words = sorted(line_map[y_key], key=lambda w: float(w["x0"]))

            # Partition into description zone and amount zone
            desc_words = [w for w in line_words if float(w["x0"]) < _AMT_X_THRESHOLD]
            amt_words  = [w for w in line_words if float(w["x0"]) >= _AMT_X_THRESHOLD]

            # ── Detect dates in description zone ──────────────
            dates_in_line: List[datetime] = []
            non_date_desc_words: List[dict] = []
            for w in desc_words:
                txt = w["text"].strip()
                if DATE_RE.match(txt):
                    try:
                        dates_in_line.append(datetime.strptime(txt, DATE_FMT))
                    except ValueError:
                        non_date_desc_words.append(w)
                else:
                    non_date_desc_words.append(w)

            desc = " ".join(w["text"] for w in non_date_desc_words).strip()

            # ── Parse amount from right-zone words only ────────
            parsed_amts: List[float] = []
            for token in " ".join(w["text"] for w in amt_words).split():
                a = _parse_amt(token)
                if a is not None:
                    parsed_amts.append(a)

            amount: Optional[float] = None
            if parsed_amts:
                # Pick the last non-zero amount (handles Ausgang + Eingang side-by-side)
                for a in reversed(parsed_amts):
                    if a != 0.0:
                        amount = a
                        break
                if amount is None:
                    amount = parsed_amts[-1]

            # ── Section heading detection (no date, no amount) ─
            # Runs regardless of current_section so we can exit "skip" mode.
            if not dates_in_line and not parsed_amts and desc:
                for pattern, new_section in _SECTION_HEADING_PATTERNS:
                    if pattern.match(desc):
                        if pending and pending.get("amount") is not None:
                            rows.append(pending)
                        pending = None
                        current_section = new_section
                        _skip_next_balance_tail = False
                        break

            # ── Skip non-transaction sections (Tagesgeld, Depot…) ──
            if current_section == "skip":
                continue

            # ── Skip header / footer / balance rows ───────────
            # AlterSaldo / NeuerSaldo may span two PDF lines:
            #   line N   → "AlterSaldo"                (keyword, no date)
            #   line N+1 → "31.12.2025  +3.841,66"     (date + amount, no desc)
            # We set _skip_next_balance_tail on line N and skip line N+1.
            is_balance_row = _BALANCE_ROW_RE.match(desc) or re.search(
                r"\bAlterSaldo\b|\bNeuerSaldo\b", desc, re.IGNORECASE
            )
            is_header_row = _HEADER_KEYWORDS.search(desc)

            if is_balance_row or (is_header_row and not dates_in_line):
                _skip_next_balance_tail = True
                if pending and pending.get("amount") is not None and not dates_in_line:
                    rows.append(pending)
                    pending = None
                continue

            # Skip the orphaned date+amount tail of a split balance row
            if _skip_next_balance_tail and dates_in_line and not desc:
                _skip_next_balance_tail = False
                continue
            _skip_next_balance_tail = False

            # ── Skip cover-page / non-transaction rows ────────
            # Rows whose description starts with document-level keywords that
            # survived the header filter (e.g. "FinanzreportNr.1per02.02.2026").
            if re.match(r"^Finanzreport", desc, re.IGNORECASE):
                continue

            # ── Skip rows with no useful content ─────────────
            if not dates_in_line and not desc and not amt_words:
                continue

            # ── New transaction row (has at least one date) ───
            if dates_in_line:
                # Flush previous pending
                if pending is not None and pending.get("amount") is not None:
                    rows.append(pending)

                # Use last date on line (Valuta follows Buchungstag in left zone)
                dt = dates_in_line[-1]

                pending = {
                    "date":        dt,
                    "description": desc,
                    "amount":      round(amount, 2) if amount is not None else None,
                    "currency":    "EUR",
                    "section":     current_section,
                }

            else:
                # Continuation line — extend pending description; backfill amount
                if pending is not None:
                    if desc:
                        pending["description"] = (pending["description"] + " " + desc).strip()
                    if amount is not None and pending.get("amount") is None:
                        pending["amount"] = round(amount, 2)

    # Flush final pending
    if pending is not None and pending.get("amount") is not None:
        rows.append(pending)

    # Drop rows without an amount and internal account-to-account transfers
    rows = [r for r in rows if r.get("amount") is not None]
    rows = [r for r in rows if not _INTERNAL_RE.search(r.get("description", ""))]
    return rows


# ── Text-based parsing (last-resort fallback) ─────────────────

# Matches a line starting with (optionally) a Buchungstag date followed by
# a Valuta date, then description tokens, and ending with one or two amounts.
#   Group 1 = Buchungstag (optional)
#   Group 2 = Valuta date
#   Group 3 = text between dates and amounts
#   Group 4 = amount 1 (Ausgang or combined — may have leading +/-)
#   Group 5 = amount 2 (Eingang, optional)
_TXN_LINE_RE = re.compile(
    r"(?:(\d{2}\.\d{2}\.\d{4})\s+)?"           # optional Buchungstag
    r"(\d{2}\.\d{2}\.\d{4})\s+"                # Valuta date
    r"(.+?)\s+"                                 # description / middle
    r"([+-]?[\d.,]+)\s*"                        # amount 1 (fixed: now accepts '+' prefix)
    r"([+-]?[\d.,]+)?"                          # amount 2 (optional)
    r"\s*$",
    re.VERBOSE,
)

_SECTION_RE = re.compile(
    r"^(girokonto|visa.{0,10}karte|visa\s+card|kreditkarte)\b",
    re.IGNORECASE | re.MULTILINE,
)


def parse_comdirect_pdf_text(full_text: str) -> List[dict]:
    """
    Last-resort text-based parser for comdirect PDF statements.

    Splits on section headers (Girokonto / Visa Karte) and processes
    each line that begins with a date pair.
    """
    rows: List[dict] = []

    # ── Split text into sections ───────────────────────────────
    sections: List[Tuple[str, str]] = []  # [(section_name, section_text)]
    current_name = "girokonto"
    current_start = 0

    for m in _SECTION_RE.finditer(full_text):
        if m.start() > current_start:
            sections.append((current_name, full_text[current_start: m.start()]))
        current_name = "visa" if "visa" in m.group(1).lower() else "girokonto"
        current_start = m.end()

    sections.append((current_name, full_text[current_start:]))

    for section_name, section_text in sections:
        pending: Optional[dict] = None

        for raw_line in section_text.split("\n"):
            line = raw_line.strip()
            if not line:
                continue

            # Skip DEPOTBESTAND lines — these are bond/share holding lines within
            # Kupon transaction descriptions and their numbers are NOT amounts.
            if _DEPOTBESTAND_RE.search(line):
                if pending:
                    pending["description"] = (pending["description"] + " " + line).strip()
                continue

            # Skip obvious header/footer lines
            if re.match(
                r"^(Buchungstag|Valuta|Vorgang|Auftraggeber|Buchungstext|"
                r"Ausgang|Eingang|Seite\s+\d|IBAN|BIC|Saldo|Alter|Neuer)",
                line,
                re.IGNORECASE,
            ):
                if pending:
                    rows.append(pending)
                    pending = None
                continue

            m = _TXN_LINE_RE.match(line)
            if not m:
                # Continuation line
                if pending:
                    pending["description"] = (pending["description"] + " " + line).strip()
                continue

            # Flush pending
            if pending:
                rows.append(pending)

            buch_str   = m.group(1) or ""
            valuta_str = m.group(2)
            desc_raw   = m.group(3).strip()
            amt_str1   = m.group(4) or ""
            amt_str2   = m.group(5) or ""

            # Skip DEPOTBESTAND continuation lines that happen to match the regex
            if _DEPOTBESTAND_RE.search(desc_raw):
                pending = None
                continue

            # Parse date — prefer Valuta
            dt: Optional[datetime] = None
            for ds in (valuta_str, buch_str):
                if ds:
                    try:
                        dt = datetime.strptime(ds, DATE_FMT)
                        break
                    except ValueError:
                        pass
            if dt is None:
                pending = None
                continue

            # Parse amounts
            # amt_str1 has explicit sign from PDF → trust the sign directly
            amt1 = _parse_amt(amt_str1)
            amt2 = _parse_amt(amt_str2)

            if amt2 is not None and abs(amt2) > 0:
                # Two populated amounts → amt1=Ausgang (negate), amt2=Eingang (keep)
                amount = abs(amt2)
            elif amt1 is not None:
                # Single amount — sign is explicit in the PDF text (+/-)
                amount = amt1
            else:
                pending = None
                continue

            pending = {
                "date":        dt,
                "description": desc_raw,
                "amount":      round(amount, 2),
                "currency":    "EUR",
                "section":     section_name,
            }

        if pending:
            rows.append(pending)

    # Filter internal transfers
    return [r for r in rows if not _INTERNAL_RE.search(r.get("description", ""))]
