"""
comdirect CSV parser (Germany).

Format:
- Encoding: Windows-1252 (cp1252)
- Delimiter: semicolon (;)
- Date format: DD.MM.YYYY
- Decimal: German format (1.234,56 — period = thousands, comma = decimal)
- Headers: "Buchungstag";"Wertstellung (Valuta)";"Vorgang";"Buchungstext";"Umsatz in EUR"
- Buchungstext is a large concatenated field — needs regex parsing for payee + purpose
"""
import re
from datetime import datetime
from typing import List, Dict, Optional


class ComdirectParser:
    ENCODING = "cp1252"
    DELIMITER = ";"
    DATE_FORMAT = "%d.%m.%Y"

    # Comdirect Buchungstext patterns for extracting meaningful info
    # The text contains: Auftraggeber/Empfänger, Buchungstext, Konto/BIC etc.
    PAYEE_PATTERNS = [
        r"Auftraggeber:\s*(.+?)(?:\n|Buchungstext:|$)",
        r"Empfänger:\s*(.+?)(?:\n|Buchungstext:|$)",
        r"Empfaenger:\s*(.+?)(?:\n|Buchungstext:|$)",
        r"Beguenstigter/Zahlungspflichtiger:\s*(.+?)(?:\n|$)",
    ]
    PURPOSE_PATTERNS = [
        r"Buchungstext:\s*(.+?)(?:\n|Konto|BIC|IBAN|$)",
        r"Verwendungszweck:\s*(.+?)(?:\n|Konto|$)",
        r"Verw\.\s*:\s*(.+?)(?:\n|$)",
    ]

    def parse(self, content: bytes) -> List[Dict]:
        """Parse comdirect CSV export."""
        text = content.decode(self.ENCODING, errors="replace")
        lines = text.splitlines()

        # Find header row
        header_idx = self._find_header(lines)
        if header_idx is None:
            raise ValueError("Could not find comdirect CSV header row.")

        raw_header = lines[header_idx]
        header_cols = [c.strip().strip('"') for c in raw_header.split(self.DELIMITER)]
        header_lower = [h.lower() for h in header_cols]

        # Map columns
        def find_col(candidates: List[str]) -> Optional[int]:
            for c in candidates:
                for i, h in enumerate(header_lower):
                    if c in h:
                        return i
            return None

        idx_booking_date = find_col(["buchungstag"])
        idx_value_date = find_col(["wertstellung", "valuta"])
        idx_vorgang = find_col(["vorgang"])
        idx_buchungstext = find_col(["buchungstext"])
        idx_amount = find_col(["umsatz in eur", "betrag in eur", "umsatz"])

        if idx_booking_date is None or idx_amount is None:
            raise ValueError("Could not find required comdirect columns (Buchungstag, Umsatz).")

        transactions = []
        data_lines = lines[header_idx + 1:]

        for line in data_lines:
            line = line.strip()
            if not line or line.startswith('"Kontonummer') or line.startswith('"Alter Saldo') or line.startswith('"Neuer Saldo'):
                continue

            parts = self._split_comdirect_line(line)
            if not parts or len(parts) < 3:
                continue

            def get(idx: Optional[int]) -> str:
                if idx is None or idx >= len(parts):
                    return ""
                return parts[idx].strip().strip('"')

            booking_date_str = get(idx_booking_date)
            if not booking_date_str or booking_date_str in ("", "offen"):
                continue

            try:
                booking_date = datetime.strptime(booking_date_str, self.DATE_FORMAT)
            except ValueError:
                continue

            value_date_str = get(idx_value_date)
            value_date: Optional[datetime] = None
            if value_date_str:
                try:
                    value_date = datetime.strptime(value_date_str, self.DATE_FORMAT)
                except ValueError:
                    pass

            vorgang = get(idx_vorgang)
            buchungstext_raw = get(idx_buchungstext)

            # Extract payee and purpose from Buchungstext
            payee = self._extract_payee(buchungstext_raw)
            purpose = self._extract_purpose(buchungstext_raw)

            # Build description
            desc_parts = [p for p in [payee, purpose or vorgang] if p]
            description = " — ".join(desc_parts) if desc_parts else buchungstext_raw[:100] or "comdirect Transaction"

            amount_str = get(idx_amount)
            amount = self._parse_german_amount(amount_str)
            if amount is None:
                continue

            transactions.append({
                "date": value_date or booking_date,
                "booking_date": booking_date,
                "description": description.strip(),
                "amount": amount,
                "currency": "EUR",
            })

        return transactions

    def _find_header(self, lines: List[str]) -> Optional[int]:
        for i, line in enumerate(lines):
            normalized = line.lower()
            if "buchungstag" in normalized and ("buchungstext" in normalized or "vorgang" in normalized):
                return i
        return None

    def _split_comdirect_line(self, line: str) -> List[str]:
        """Split comdirect CSV line (handles quoted semicolon-separated fields)."""
        import csv
        reader = csv.reader([line], delimiter=";", quotechar='"')
        return next(reader, [])

    def _extract_payee(self, text: str) -> str:
        """Try to extract payee/recipient from Buchungstext."""
        for pattern in self.PAYEE_PATTERNS:
            m = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
            if m:
                payee = m.group(1).strip()
                # Clean up
                payee = re.sub(r"\s+", " ", payee)
                return payee[:100]
        return ""

    def _extract_purpose(self, text: str) -> str:
        """Try to extract payment purpose/reference from Buchungstext."""
        for pattern in self.PURPOSE_PATTERNS:
            m = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
            if m:
                purpose = m.group(1).strip()
                purpose = re.sub(r"\s+", " ", purpose)
                # Remove common noise
                purpose = re.sub(r"IBAN:\s*[A-Z]{2}\d+[\s\d]*", "", purpose)
                purpose = re.sub(r"BIC:\s*[A-Z0-9]+", "", purpose)
                purpose = purpose.strip()
                return purpose[:150]
        return ""

    def _parse_german_amount(self, value: str) -> Optional[float]:
        """
        Parse German number format:
        1.234,56 → 1234.56
        -1.234,56 → -1234.56
        """
        if not value or not value.strip():
            return None

        cleaned = value.strip().replace('"', "")

        # Detect sign
        negative = cleaned.startswith("-")
        cleaned = cleaned.lstrip("+-").strip()

        # Remove thousands separator (period) and convert decimal comma
        cleaned = cleaned.replace(".", "").replace(",", ".")

        # Remove currency symbols
        cleaned = re.sub(r"[^\d.\-]", "", cleaned)

        if not cleaned:
            return None

        try:
            amount = float(cleaned)
            return -amount if negative else amount
        except ValueError:
            return None
