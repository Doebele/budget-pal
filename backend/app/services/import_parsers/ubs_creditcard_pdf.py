"""
UBS Switzerland Kreditkartenabrechnung PDF parser.

Handles both UBS Mastercard and UBS Visa Card statements (multi-card PDF).

Layout per transaction (3 lines):
  DD.MM.YYYY  MERCHANT NAME CITY  AMOUNT    ← Buchungsdatum + description + CHF amount
  MCC_CATEGORY                              ← merchant category ("Restaurants, Bars" etc.)
  DD.MM.YYYY                               ← Valutadatum (transaction / value date)

Card-section headers look like:
  CARDHOLDER, UBS Mastercard Gold, 5101 99XX XXXX 9501
  CARDHOLDER, UBS Visa Card Gold,  4901 18XX XXXX 8814

Detection signature (any one suffices):
  • "Kreditkartenabrechnung" in text
  • "UBS Mastercard" or "UBS Visa Card" AND "Rechnungsdatum" in text
"""
from __future__ import annotations

import re
from datetime import date
from typing import List, Optional, Tuple

# ── Regex patterns ────────────────────────────────────────────────────────────

# Swiss CHF amount: 1'234.56 or 18.00 or -1'337.65
_AMOUNT_RE = re.compile(r"^-?[\d']+\.\d{2}$")

# DD.MM.YYYY — used for date lines
_DATE_LINE_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}$")

# Transaction line: starts with DD.MM.YYYY, ends with a CHF amount
# e.g. "16.02.2026 F und F Kantine Zuerich 18.00"
_TXN_LINE_RE = re.compile(
    r"^(\d{2}\.\d{2}\.\d{4})\s+(.+?)\s+(-?[\d']+\.\d{2})$"
)

# Card section header: "SOME NAME, UBS Mastercard Gold, XXXX ..."
_CARD_SECTION_RE = re.compile(
    r"UBS\s+(Mastercard|Visa\s+Card)\s+(Gold|Classic|Platinum)",
    re.IGNORECASE,
)

# Lines to skip — summaries, carry-overs, header text, payments
_SKIP_PATTERNS = [
    re.compile(r"^Buchungsdatum\s+Detail\s+Betrag", re.IGNORECASE),
    re.compile(r"^Übertrag\s+(auf|von)\s+Seite\s+\d+", re.IGNORECASE),
    re.compile(r"^Kartentotal\b", re.IGNORECASE),
    re.compile(r"^Rechnungsbetrag\b", re.IGNORECASE),
    re.compile(r"^Betrag\s+letzte\s+Rechnung\b", re.IGNORECASE),
    re.compile(r"^Abrechnungsdetails\b", re.IGNORECASE),
    re.compile(r"^Rechnungskontrolle\b", re.IGNORECASE),
    re.compile(r"^Kreditkartenabrechnung\b", re.IGNORECASE),
    re.compile(r"^Der\s+Rechnungsbetrag\s+wird", re.IGNORECASE),
    re.compile(r"^Bitte\s+prüfen\s+Sie", re.IGNORECASE),
    re.compile(r"^Fremdwährungsumrechnung\b", re.IGNORECASE),
    re.compile(r"^Bei\s+Auslandtransaktionen", re.IGNORECASE),
    re.compile(r"^Es\s+empfiehlt\s+sich", re.IGNORECASE),
    re.compile(r"^Als\s+Auslandtransaktion\b", re.IGNORECASE),
    re.compile(r"^Allfällige\s+Unstimmigkeiten", re.IGNORECASE),
    re.compile(r"^Das\s+Formular\s+finden\s+Sie", re.IGNORECASE),
    re.compile(r"^Seite\s+\d+\s+von\s+\d+", re.IGNORECASE),
    re.compile(r"^UBS\s+Switzerland\b", re.IGNORECASE),
    re.compile(r"^Flughofstrasse\b", re.IGNORECASE),
    re.compile(r"^Postfach$", re.IGNORECASE),
    re.compile(r"^Tel\.\s+\+41", re.IGNORECASE),
    re.compile(r"^Fragen\s+und\s+Antworten", re.IGNORECASE),
    re.compile(r"^ubs\.com", re.IGNORECASE),
    re.compile(r"^Kartenkonto\b", re.IGNORECASE),
    re.compile(r"^Kontolimite\b", re.IGNORECASE),
    re.compile(r"^Kontoinhaber\b", re.IGNORECASE),
    re.compile(r"^Rechnungsperiode\b", re.IGNORECASE),
    re.compile(r"^Rechnungsdatum\b", re.IGNORECASE),
    re.compile(r"^HERR$|^FRAU$|^HERR\s|^FRAU\s", re.IGNORECASE),
    re.compile(r"^[A-Z\s]+(STRASSE|GASSE|WEG|PLATZ|ALLEE)\b", re.IGNORECASE),
    re.compile(r"^\d{4}\s+[A-Z]"),  # Swiss postal code + city (e.g. "8274 TAEGERWILEN")
    re.compile(r"^a$|^b$"),  # pdfplumber artifact (logo text)
]

# LSV / direct debit payment (negative = credit back to account)
_LSV_RE = re.compile(r"^LSV-Zahlung\b", re.IGNORECASE)


def is_ubs_creditcard_pdf(text: str) -> bool:
    """Return True when text looks like a UBS Kreditkartenabrechnung PDF."""
    if "Kreditkartenabrechnung" in text:
        return True
    if ("UBS Mastercard" in text or "UBS Visa Card" in text) and "Rechnungsdatum" in text:
        return True
    return False


def parse_ubs_creditcard_pdf(pdf) -> List[dict]:
    """
    Parse a UBS credit card statement PDF.

    Returns list of dicts:
      { date, description, amount, currency, notes }
    where:
      - date       = Buchungsdatum (booking date) as "YYYY-MM-DD"
      - description = merchant name + city
      - amount     < 0 for expenses, > 0 for refunds / LSV payments credited back
      - currency   = "CHF"
      - notes      = MCC merchant category (e.g. "Restaurants, Bars")
    """
    full_text = "\n".join(page.extract_text() or "" for page in pdf.pages)
    lines = [l.strip() for l in full_text.splitlines()]

    # ── State machine ────────────────────────────────────────────
    transactions: List[dict] = []
    current_card: str = "UBS Kreditkarte"

    i = 0
    while i < len(lines):
        line = lines[i]

        # Empty line
        if not line:
            i += 1
            continue

        # Track current card type (for description enrichment)
        cm = _CARD_SECTION_RE.search(line)
        if cm:
            card_type = cm.group(0).strip()
            current_card = card_type
            i += 1
            continue

        # Skip boilerplate lines
        if _should_skip(line):
            i += 1
            continue

        # LSV payment (e.g. "27.02.2026 LSV-Zahlung vom 26.02.2026 -1'337.65")
        # Import as income (positive amount) since it's a credit on the card account.
        # We skip LSV lines — they represent bank-to-card settlements, not real spending.
        tm = _TXN_LINE_RE.match(line)
        if tm:
            booking_date_str, merchant, amount_str = tm.group(1), tm.group(2), tm.group(3)

            # Skip internal settlement / summary lines
            _skip_merchants = (
                "Rechnungsbetrag", "Kartentotal", "letzte Rechnung",
                "Kontoabschluss", "Jahresgebühr",
            )
            if _LSV_RE.search(merchant) or any(kw in merchant for kw in _skip_merchants):
                i += 1
                continue

            booking_date = _parse_date(booking_date_str)
            if booking_date is None:
                i += 1
                continue

            amount = _parse_chf_amount(amount_str)
            if amount is None:
                i += 1
                continue

            # Peek at next two lines for category + valuta date
            mcc_category: Optional[str] = None
            valuta_date: Optional[str] = None

            if i + 1 < len(lines):
                next1 = lines[i + 1].strip()
                if next1 and not _TXN_LINE_RE.match(next1) and not _DATE_LINE_RE.match(next1) and not _should_skip(next1):
                    mcc_category = next1
                    if i + 2 < len(lines):
                        next2 = lines[i + 2].strip()
                        if _DATE_LINE_RE.match(next2):
                            valuta_date = next2
                            i += 3  # consume txn + category + valuta date
                        else:
                            i += 2  # consume txn + category
                    else:
                        i += 2
                elif _DATE_LINE_RE.match(next1):
                    # category line missing, next is valuta date
                    valuta_date = next1
                    i += 2
                else:
                    i += 1
            else:
                i += 1

            # Expenses are positive in the PDF → negate for our convention (negative = expense)
            # Refunds/credits are already negative in PDF → positive in our convention
            final_amount = -amount if amount > 0 else abs(amount)

            description = merchant.strip()
            notes = mcc_category or ""

            transactions.append({
                "date": booking_date.strftime("%Y-%m-%d"),
                "description": description,
                "amount": final_amount,
                "currency": "CHF",
                "notes": notes,
            })
            continue

        i += 1

    return transactions


# ── Helpers ───────────────────────────────────────────────────────────────────

def _should_skip(line: str) -> bool:
    for pat in _SKIP_PATTERNS:
        if pat.search(line):
            return True
    return False


def _parse_date(s: str) -> Optional[date]:
    """Parse DD.MM.YYYY → date."""
    try:
        d, m, y = s.split(".")
        return date(int(y), int(m), int(d))
    except Exception:
        return None


def _parse_chf_amount(s: str) -> Optional[float]:
    """Parse Swiss CHF amount string: '1'234.56' or '-18.00' → float."""
    cleaned = s.replace("'", "")
    try:
        return float(cleaned)
    except ValueError:
        return None
