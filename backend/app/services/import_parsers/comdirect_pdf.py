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
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Dict, List, Optional, Tuple

# ── Constants ──────────────────────────────────────────────────

DATE_FMT = "%d.%m.%Y"
DATE_RE = re.compile(r"\b(\d{2}\.\d{2}\.\d{4})\b")

# Row descriptions that represent internal account-to-account transfers
_INTERNAL_RE = re.compile(
    r"visa.{0,4}karten.{0,4}abrechnung|"
    r"kartenabrechnung|"
    r"visa\s+card\s+settlement",
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
    """Parse German-format amounts (1.234,56 → 1234.56, -1.234,56 → -1234.56)."""
    s = s.strip().replace("\xa0", "").replace(" ", "")
    if not s or s in ("-", "–", "+"):
        return None
    negative = s.startswith("-")
    clean = s.lstrip("+-").strip()
    # German format: period = thousands sep, comma = decimal sep
    if "," in clean:
        clean = clean.replace(".", "").replace(",", ".")
    else:
        # No comma — could be integer or period-decimal
        # If the last segment after period has exactly 2 digits → decimal point
        if re.search(r"\.\d{2}$", clean):
            # period is decimal, remove any other periods (shouldn't exist)
            pass
        else:
            clean = clean.replace(".", "")  # period is thousands sep
    try:
        val = float(clean)
        return -val if negative else val
    except ValueError:
        return None

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


# ── Text-based parsing (fallback) ─────────────────────────────

# Matches a line starting with (optionally) a Buchungstag date followed by
# a Valuta date, then description tokens, and ending with one or two amounts.
#   Group 1 = Buchungstag (optional)
#   Group 2 = Valuta date
#   Group 3 = text between dates and amounts
#   Group 4 = amount 1 (Ausgang or combined)
#   Group 5 = amount 2 (Eingang, optional)
_TXN_LINE_RE = re.compile(
    r"(?:(\d{2}\.\d{2}\.\d{4})\s+)?"          # optional Buchungstag
    r"(\d{2}\.\d{2}\.\d{4})\s+"               # Valuta date
    r"(.+?)\s+"                                # description / middle
    r"(-?[\d.,]+)\s*"                          # amount 1
    r"(-?[\d.,]+)?"                            # amount 2 (optional)
    r"\s*$",
    re.VERBOSE,
)

_SECTION_RE = re.compile(
    r"^(girokonto|visa.{0,10}karte|visa\s+card|kreditkarte)\b",
    re.IGNORECASE | re.MULTILINE,
)


def parse_comdirect_pdf_text(full_text: str) -> List[dict]:
    """
    Fallback text-based parser for comdirect PDF statements.

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

            buch_str  = m.group(1) or ""
            valuta_str = m.group(2)
            desc_raw   = m.group(3).strip()
            amt_str1   = m.group(4) or ""
            amt_str2   = m.group(5) or ""

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

            # Parse amounts — two-column: amt1=Ausgang, amt2=Eingang
            # Single-column: amt1 is signed
            amt1 = _parse_amt(amt_str1)
            amt2 = _parse_amt(amt_str2)

            if amt2 is not None and abs(amt2) > 0:
                # Two populated amounts → treat amt1 as Ausgang, amt2 as Eingang
                amount = abs(amt2)
            elif amt1 is not None:
                if amt1 < 0:
                    amount = amt1          # signed negative → expense
                elif amt2 is None and amt1 > 0:
                    # Ambiguous: single positive — check context
                    # If column position suggests Ausgang, negate; else keep positive
                    # Without column position info, keep as-is (user can adjust in preview)
                    amount = amt1
                else:
                    amount = -abs(amt1)    # Ausgang column → negate
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
