"""
N26 web-app PDF parser.

N26 lets users print transaction-search results (app.n26.com/transactions/search)
as a PDF from the browser. This is NOT a proper bank statement PDF — it is a
browser-print of the web UI. pdfplumber extracts it as an unstructured text
stream without column or table information.

Parsing strategy
────────────────
Primary:  pdfplumber word-position extraction.
          Words are sorted by y-coordinate → grouped into visual lines.
          Lines that match WEEKDAY + DAY + MONTH are treated as date headers.
          Lines that end with a (-)€amount token are transactions.
          Lines in between build up the merchant description.

Fallback: full-text regex walk.
          If the word-extraction pass yields 0 results (e.g. text-only PDF
          or unexpected layout), we fall through to a regex walk over the
          concatenated text, using the amount pattern as an anchor and
          German date headers as date setters.

Date handling
─────────────
N26 date headers show only WEEKDAY + DAY + MONTH (no year).
The year is inferred from the summary line that appears on page 1:
  "138 Transaktionen 01.10.25 - 01.04.26 €9,670.01"
Month numbers from start_month onwards belong to start_year; months before
start_month belong to end_year.

Declined transactions
─────────────────────
Rows labelled "Abgelehnt" are rejected card attempts that never settled.
They are always skipped.

Detection signature
───────────────────
  • text contains "app.n26.com"
  • OR text starts with "SuchergebnisseSuchen"
"""
from __future__ import annotations

import re
from datetime import date, datetime
from typing import List, Optional, Tuple


# ── German calendar maps ─────────────────────────────────────

GERMAN_MONTHS: dict[str, int] = {
    "JANUAR": 1, "FEBRUAR": 2, "MÄRZ": 3, "APRIL": 4,
    "MAI": 5, "JUNI": 6, "JULI": 7, "AUGUST": 8,
    "SEPTEMBER": 9, "OKTOBER": 10, "NOVEMBER": 11, "DEZEMBER": 12,
}
GERMAN_WEEKDAYS: set[str] = {
    "MONTAG", "DIENSTAG", "MITTWOCH", "DONNERSTAG",
    "FREITAG", "SAMSTAG", "SONNTAG",
}

# ── Regex patterns ────────────────────────────────────────────

# e.g. "01.10.25 - 01.04.26" or "01.10.2025 - 01.04.2026"
_DATE_RANGE_RE = re.compile(
    r"(\d{2})\.(\d{2})\.(\d{2,4})\s*[-–]\s*(\d{2})\.(\d{2})\.(\d{2,4})"
)
# A single amount token: optional minus + € + digits (comma sep) + optional .cents
# e.g. "-€132.94", "€20,000.00", "€1.52"
_AMOUNT_WORD_RE = re.compile(r"^(-?)€([\d,]+)(?:\.(\d{2}))?$")
# Same but for scanning a text stream
_AMOUNT_TEXT_RE = re.compile(r"(-?)€([\d,]+(?:\.\d{1,2})?)")

# Skip pure UI chrome tokens
_UI_SKIP_RE = re.compile(
    r"^(Suchergebnisse|SuchergebnisseSuchen|Suchen?|Suche\s+nach\s+Transaktionen)$",
    re.IGNORECASE,
)
# Footer: "CM10.04.26, 17:46 …"
_FOOTER_RE = re.compile(r"^CM\d{2}\.\d{2}\.")
# Summary: "138 Transaktionen01.10.25 …"
_SUMMARY_RE = re.compile(r"^\d+\s*Transaktionen")
# Page number: "1/14"
_PAGE_NUM_RE = re.compile(r"^\d+/\d+$")
# Declined transactions
_DECLINED_RE = re.compile(r"\bAbgelehnt\b", re.IGNORECASE)
# Refund label (informational, keep the transaction)
_REFUND_RE = re.compile(r"R[üu]ckerstattung", re.IGNORECASE)


# ── Public API ────────────────────────────────────────────────

def is_n26_web_pdf(text: str) -> bool:
    """Return True when the text looks like an N26 web-app browser-print PDF."""
    return "app.n26.com" in text or "SuchergebnisseSuchen" in text


def parse_n26_web_pdf(pdf) -> List[dict]:
    """
    Parse an N26 web-app PDF using pdfplumber.
    Returns list of dicts: {date, description, amount, currency}.
    Tries the word-position strategy first; falls back to full-text regex.
    """
    # Collect full text for year inference and fallback
    pages_text: List[str] = []
    for page in pdf.pages:
        t = page.extract_text() or ""
        pages_text.append(t)
    full_text = "\n".join(pages_text)

    start_year, start_month, end_year, _end_month = _parse_year_range(full_text)

    # ── Primary: word-position pass ───────────────────────────
    results = _parse_by_word_positions(pdf, start_year, start_month, end_year)
    if results:
        return results

    # ── Fallback: text stream regex ───────────────────────────
    return _parse_by_text(full_text, start_year, start_month, end_year)


# ── Year/date range helpers ───────────────────────────────────

def _parse_year_range(text: str) -> Tuple[int, int, int, int]:
    """
    Extract (start_year, start_month, end_year, end_month) from the summary line.
    Falls back to current year if not found.
    """
    m = _DATE_RANGE_RE.search(text)
    if not m:
        y = datetime.now().year
        return y, 1, y, 12

    _sd, sm, sy, _ed, em, ey = m.group(1, 2, 3, 4, 5, 6)
    sm, em = int(sm), int(em)
    sy = int(sy) + (2000 if int(sy) < 100 else 0)
    ey = int(ey) + (2000 if int(ey) < 100 else 0)
    return sy, sm, ey, em


def _year_for_month(month: int, start_year: int, start_month: int, end_year: int) -> int:
    """
    Assign a calendar year to a given month number.
    Months >= start_month belong to start_year; earlier months to end_year.
    Trivial when start_year == end_year.
    """
    if start_year == end_year:
        return start_year
    if month >= start_month:
        return start_year
    return end_year


# ── Amount parsing ────────────────────────────────────────────

def _parse_amount_token(token: str) -> Optional[float]:
    """
    Parse a single amount token like '-€132.94' or '€20,000.00'.
    Returns float or None.
    """
    m = _AMOUNT_WORD_RE.match(token)
    if not m:
        return None
    sign = -1 if m.group(1) == "-" else 1
    # Strip thousands-separator commas; cents already covered by group(3)
    integer_part = m.group(2).replace(",", "")
    cents_part = m.group(3) or "00"
    try:
        return sign * float(f"{integer_part}.{cents_part}")
    except ValueError:
        return None


def _parse_amount_text(raw: str) -> Optional[float]:
    """Scan a text fragment for the first amount pattern."""
    m = _AMOUNT_TEXT_RE.search(raw)
    if not m:
        return None
    sign = -1 if m.group(1) == "-" else 1
    digits = m.group(2).replace(",", "")
    try:
        return sign * float(digits)
    except ValueError:
        return None


# ── Date header detection ─────────────────────────────────────

def _extract_date_from_tokens(
    tokens: List[str],
    start_year: int,
    start_month: int,
    end_year: int,
) -> Optional[date]:
    """
    Look for the pattern [WEEKDAY] [DAY] [MONTH_NAME] anywhere in a token list.
    Returns a date object or None.
    """
    for i in range(len(tokens) - 2):
        wday = tokens[i].upper().strip(".,")
        day_s = tokens[i + 1].strip(".,")
        mon_s = tokens[i + 2].upper().strip(".,")
        if (
            wday in GERMAN_WEEKDAYS
            and day_s.isdigit()
            and mon_s in GERMAN_MONTHS
        ):
            day = int(day_s)
            month = GERMAN_MONTHS[mon_s]
            year = _year_for_month(month, start_year, start_month, end_year)
            try:
                return date(year, month, day)
            except ValueError:
                pass
    return None


def _is_ui_chrome(line: str) -> bool:
    """True for page headers / footers / summary lines to skip."""
    ls = line.strip()
    if _UI_SKIP_RE.match(ls):
        return True
    if _FOOTER_RE.match(ls):
        return True
    if _SUMMARY_RE.match(ls):
        return True
    if _PAGE_NUM_RE.match(ls):
        return True
    # URL lines (page footer)
    if ls.startswith("https://"):
        return True
    # Footer line like "10.04.26, 17:46 Suchergebnisse für" (CM initials may be dropped by pdfplumber)
    if "Suchergebnisse" in ls:
        return True
    return False


# ── Primary parser: word-position ────────────────────────────

def _parse_by_word_positions(
    pdf,
    start_year: int,
    start_month: int,
    end_year: int,
) -> List[dict]:
    """
    Extract transactions by grouping pdfplumber words into visual lines
    (sorted by y-coordinate), then walking date headers → description → amount.
    """
    transactions: List[dict] = []

    # current_date persists across pages so that transactions appearing before
    # the first date header on a new page still get the correct date.
    current_date: Optional[date] = None

    for page in pdf.pages:
        words = page.extract_words(x_tolerance=5, y_tolerance=3)
        if not words:
            continue

        # Sort top-to-bottom, left-to-right
        words.sort(key=lambda w: (w["top"], w["x0"]))

        # Group into visual lines: words within 5 px vertically
        lines: List[List[str]] = []
        cur_tokens: List[str] = []
        cur_y: Optional[float] = None

        for word in words:
            y = word["top"]
            if cur_y is None or abs(y - cur_y) <= 5:
                cur_tokens.append(word["text"])
                if cur_y is None:
                    cur_y = y
            else:
                if cur_tokens:
                    lines.append(cur_tokens)
                cur_tokens = [word["text"]]
                cur_y = y
        if cur_tokens:
            lines.append(cur_tokens)

        # Walk lines
        pending: List[str] = []  # description words accumulating before an amount
        just_emitted_tx = False  # True right after we emit a transaction

        for i, tokens in enumerate(lines):
            line_str = " ".join(tokens)

            # Skip UI chrome
            if _is_ui_chrome(line_str):
                pending = []
                just_emitted_tx = False
                continue

            # Check for a date header in this line
            dt = _extract_date_from_tokens(tokens, start_year, start_month, end_year)
            if dt is not None:
                pending = []
                just_emitted_tx = False
                current_date = dt
                continue

            # Check if the last token is an amount
            amount = _parse_amount_token(tokens[-1]) if tokens else None
            if amount is not None:
                desc_tokens = pending + tokens[:-1]
                desc = " ".join(t for t in desc_tokens if t).strip()
                pending = []
                just_emitted_tx = True

                # Determine if this is a declined transaction:
                # (a) description already contains "Abgelehnt", or
                # (b) the next non-chrome line contains "Abgelehnt"
                #     (N26 shows "Abgelehnt" *below* the amount row).
                declined = bool(_DECLINED_RE.search(desc))
                if not declined:
                    next_idx = i + 1
                    while next_idx < len(lines):
                        nxt = " ".join(lines[next_idx])
                        if _is_ui_chrome(nxt):
                            next_idx += 1
                            continue
                        if _DECLINED_RE.search(nxt):
                            declined = True
                        break

                if declined:
                    pending = []
                    continue

                # Remove refund label from description
                desc = _REFUND_RE.sub("", desc).strip()
                desc = desc.strip(" |,")

                if current_date and desc:
                    # If a fragment ending with "…" appears before the main text
                    # (pdfplumber ordering quirk with truncated contact names),
                    # move it to the end: "Me… Alois und Elfriede" → "Alois und Elfriede Me…"
                    parts = desc.split()
                    if parts and parts[0].endswith("…") and len(parts) > 1:
                        desc = " ".join(parts[1:] + [parts[0]])

                    transactions.append({
                        "date": current_date.strftime("%Y-%m-%d"),
                        "description": desc,
                        "amount": amount,
                        "currency": "EUR",
                    })
            else:
                # Not an amount line.
                # Right after a transaction, short lines (≤ 2 words) are location
                # labels (e.g. "Konstanz", "Online", "Stuttgart") belonging to the
                # previous transaction — skip them to avoid polluting the next one.
                if just_emitted_tx and len(tokens) <= 2:
                    just_emitted_tx = False
                    continue
                just_emitted_tx = False

                clean = line_str.strip()
                if clean and not _is_ui_chrome(clean):
                    pending.append(clean)

    return transactions


# ── Fallback parser: full-text regex ─────────────────────────

def _parse_by_text(
    full_text: str,
    start_year: int,
    start_month: int,
    end_year: int,
) -> List[dict]:
    """
    Regex-based fallback: uses the amount pattern as an anchor to split
    the concatenated text stream into (description, amount) pairs.
    Date headers are detected inline and used to tag subsequent transactions.
    """
    # Remove page footers (CM + date + URL block)
    text = re.sub(
        r"CM\d{2}\.\d{2}\..*?(?=MONTAG|DIENSTAG|MITTWOCH|DONNERSTAG|FREITAG|SAMSTAG|SONNTAG|\Z)",
        " ",
        full_text,
        flags=re.DOTALL | re.IGNORECASE,
    )
    # Remove page header
    text = re.sub(r"SuchergebnisseSuchen", " ", text)
    text = re.sub(r"Suche\s+nach\s+Transaktionen", " ", text)
    # Remove summary line
    text = re.sub(r"\d+\s*Transaktionen.*?€[\d,.]+", " ", text)
    # Remove page numbers
    text = re.sub(r"\b\d{1,2}/\d{1,2}\b", " ", text)

    transactions: List[dict] = []
    current_date: Optional[date] = None

    # Split on amount tokens — each split gives us the preceding description
    # Pattern: everything up to and including the next amount
    parts = re.split(r"(-?€[\d,]+(?:\.\d{1,2})?)", text)

    desc_buf = ""
    for i, part in enumerate(parts):
        # Even indices: text segments; Odd indices: amount tokens
        if i % 2 == 0:
            # Check for date headers in this text segment
            words = part.split()
            for j in range(len(words) - 2):
                dt = _extract_date_from_tokens(
                    words[j : j + 3], start_year, start_month, end_year
                )
                if dt is not None:
                    current_date = dt
                    # Split description at the date header
                    wpos = part.find(words[j])
                    desc_buf = part[wpos + len(words[j]) + len(words[j + 1]) + len(words[j + 2]) + 2:]
                    break
            else:
                desc_buf += " " + part
        else:
            # This is an amount token
            amount = _parse_amount_text(part)
            if amount is None:
                desc_buf = ""
                continue

            desc = desc_buf.strip()
            desc_buf = ""

            if not desc or _DECLINED_RE.search(desc):
                continue

            desc = _REFUND_RE.sub("", desc).strip()
            desc = re.sub(r"\s{2,}", " ", desc).strip(" |,")

            if current_date and desc:
                transactions.append({
                    "date": current_date.strftime("%Y-%m-%d"),
                    "description": desc,
                    "amount": amount,
                    "currency": "EUR",
                })

    return transactions
