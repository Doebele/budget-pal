"""
Tests for the UBS PDF transaction line parser.

Extracted standalone so they can run without FastAPI / SQLAlchemy deps.

Key regression: the old regex grabbed the LAST number on each line
(= the running Saldo) instead of the transaction Betrag.  The fix
uses a two-date pattern so the amount that sits *before* the Valuta
date is captured and the trailing Saldo is discarded.
"""
import re
from datetime import datetime
from typing import List, Optional

# ── Inline copy of the fixed parser so tests run without FastAPI ─────────────


def _parse_pdf_text(text: str, bank: str) -> List[dict]:
    """
    Robust line parser for UBS PDF statement text.

    Strategy — two-date anchor:
    1. Find the first and second DD.MM.YYYY on the line.
    2. Everything between them is "Description + Betrag".
    3. The LAST amount-like number in that section is the Betrag.
    4. Everything before it is the description.
    5. The trailing number after the Valuta date (Saldo) is discarded.

    Works even when pdfplumber collapses all whitespace between columns.
    """
    _DATE_RE = re.compile(r"\d{2}\.\d{2}\.\d{4}")
    _AMT_RE  = re.compile(r"[+-]?[\d']+[.,]\d{2}")

    _SKIP_RE = re.compile(
        r"^(Seite\s+\d|Saldo\s|Datum\s|Buchungsdatum|Valuta|IBAN\s|BIC\s|"
        r"Kontonummer|Konto\s|Total\s|Page\s+\d|\d+\s*$)",
        re.IGNORECASE,
    )

    def _parse_ubs_line(line: str) -> Optional[dict]:
        dates = list(_DATE_RE.finditer(line))
        if len(dates) < 2:
            return None
        buch_m, valuta_m = dates[0], dates[1]
        middle = line[buch_m.end(): valuta_m.start()].strip()
        if not middle:
            return None
        amounts = list(_AMT_RE.finditer(middle))
        if not amounts:
            return None
        betrag_m = amounts[-1]
        desc = middle[: betrag_m.start()].strip()
        if not desc:
            return None
        amount_str = betrag_m.group().replace("'", "").replace(",", ".")
        try:
            dt = datetime.strptime(buch_m.group(), "%d.%m.%Y")
            return {"date": dt, "description": desc, "amount": float(amount_str), "currency": "CHF"}
        except ValueError:
            return None

    _SIMPLE_RE = re.compile(
        r"^(\d{2}\.\d{2}\.\d{4})\s+(.+?)\s+"
        r"([+-]?\d{1,3}(?:[',]\d{3})*(?:[',\.]\d{2}))\s*$"
    )

    rows: list = []
    pending: Optional[dict] = None

    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line:
            continue

        parsed = _parse_ubs_line(line)
        if parsed:
            if pending and pending.get("description"):
                rows.append(pending)
            pending = parsed
            continue

        m2 = _SIMPLE_RE.match(line)
        if m2:
            if pending and pending.get("description"):
                rows.append(pending)
            date_str, desc, amount_str = m2.groups()
            try:
                dt = datetime.strptime(date_str, "%d.%m.%Y")
                amount_clean = amount_str.replace("'", "").replace(",", ".")
                pending = {"date": dt, "description": desc.strip(), "amount": float(amount_clean), "currency": "CHF"}
            except ValueError:
                pass
            continue

        if pending and not _DATE_RE.fullmatch(line) and not _SKIP_RE.match(line):
            pending["description"] = (pending["description"] + " " + line).strip()

    if pending and pending.get("description"):
        rows.append(pending)

    return rows


# ── Fixtures ──────────────────────────────────────────────────────────────────

UBS_SINGLE_LINE = "01.04.2026 Migros Bank AG -649.00 01.04.2026 3'437.09"

UBS_MULTI_LINE = """\
01.04.2026 Migros Bank AG -649.00 01.04.2026 3'437.09
28.03.2026 TESLA LEASING; Dauerauftrag -500.00 28.03.2026 4'086.09
"""

UBS_MULTILINE_DESCRIPTION = """\
01.04.2026 Steuerverwaltung des Kantons -1'955.00 26.03.2026 6'975.84
Thurgau
"""

UBS_CREDIT = "31.03.2026 Gehalt Muster AG 5'200.00 31.03.2026 8'930.84"

UBS_MIXED = """\
31.03.2026 Gehalt Muster AG 5'200.00 31.03.2026 8'930.84
01.04.2026 Migros Bank AG -649.00 01.04.2026 3'437.09
"""

UBS_WITH_NOISE = """\
Buchungsdatum Buchungstext Betrag Valuta Saldo
Seite 1
01.04.2026 Migros Bank AG -649.00 01.04.2026 3'437.09
123
"""

# pdfplumber sometimes collapses whitespace between PDF cells
UBS_COLLAPSED_SPACES = "01.04.2026MigrosBankAG-649.0001.04.20263'437.09"
UBS_PARTIAL_SPACES   = "01.04.2026 MigrosBankAG -649.00 01.04.2026 3437.09"


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_single_transaction_captures_betrag_not_saldo():
    """Core regression: must return -649.00 (Betrag), NOT 3'437.09 (Saldo)."""
    rows = _parse_pdf_text(UBS_SINGLE_LINE, bank="ubs")
    assert len(rows) == 1, f"Expected 1 row, got {len(rows)}"
    assert rows[0]["amount"] == -649.00, (
        f"Expected -649.00 (Betrag), got {rows[0]['amount']} — Saldo was incorrectly captured"
    )
    assert rows[0]["description"] == "Migros Bank AG"


def test_multi_transaction_all_amounts_correct():
    rows = _parse_pdf_text(UBS_MULTI_LINE, bank="ubs")
    assert len(rows) == 2
    amounts = {r["description"]: r["amount"] for r in rows}
    assert amounts["Migros Bank AG"] == -649.00
    assert amounts["TESLA LEASING; Dauerauftrag"] == -500.00


def test_credit_transaction_positive_amount():
    rows = _parse_pdf_text(UBS_CREDIT, bank="ubs")
    assert len(rows) == 1
    assert rows[0]["amount"] == 5_200.00
    assert rows[0]["description"] == "Gehalt Muster AG"


def test_swiss_thousands_separator_in_amount():
    """Amount -1'955.00 (Swiss apostrophe thousands sep) must parse to -1955.00."""
    rows = _parse_pdf_text(UBS_MULTILINE_DESCRIPTION, bank="ubs")
    assert len(rows) == 1
    assert rows[0]["amount"] == -1_955.00, (
        f"Swiss apostrophe thousands sep not handled: got {rows[0]['amount']}"
    )


def test_multiline_description_appended():
    """Continuation line 'Thurgau' should be appended to the description."""
    rows = _parse_pdf_text(UBS_MULTILINE_DESCRIPTION, bank="ubs")
    assert len(rows) == 1
    assert "Thurgau" in rows[0]["description"]


def test_noise_lines_ignored():
    """Header row, page number, and 'Seite' lines must not produce transactions."""
    rows = _parse_pdf_text(UBS_WITH_NOISE, bank="ubs")
    assert len(rows) == 1
    assert rows[0]["amount"] == -649.00


def test_mixed_income_and_expense():
    rows = _parse_pdf_text(UBS_MIXED, bank="ubs")
    assert len(rows) == 2
    by_desc = {r["description"]: r["amount"] for r in rows}
    assert by_desc["Gehalt Muster AG"] == 5_200.00
    assert by_desc["Migros Bank AG"] == -649.00


def test_date_parsed_correctly():
    rows = _parse_pdf_text(UBS_SINGLE_LINE, bank="ubs")
    assert rows[0]["date"] == datetime(2026, 4, 1)


def test_currency_set_to_chf():
    rows = _parse_pdf_text(UBS_SINGLE_LINE, bank="ubs")
    assert rows[0]["currency"] == "CHF"


def test_collapsed_spaces_no_space_between_tokens():
    """pdfplumber may collapse all spaces: still must get Betrag not Saldo."""
    rows = _parse_pdf_text(UBS_COLLAPSED_SPACES, bank="ubs")
    assert len(rows) == 1
    assert rows[0]["amount"] == -649.00, (
        f"Collapsed-space line: expected -649.00, got {rows[0]['amount']}"
    )


def test_partial_spaces_no_apostrophe_in_saldo():
    """Saldo without apostrophe (3437.09) must still be discarded."""
    rows = _parse_pdf_text(UBS_PARTIAL_SPACES, bank="ubs")
    assert len(rows) == 1
    assert rows[0]["amount"] == -649.00
