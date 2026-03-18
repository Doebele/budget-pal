"""
UBS Switzerland CSV parser.

Format:
- Encoding: ISO-8859-1 (Latin-1)
- Delimiter: semicolon (;)
- Date format: DD.MM.YYYY
- Separate Belastung (debit) and Gutschrift (credit) columns
- Header discovery: scan until "Valuta" or "Buchungsdatum" found in a row
"""
import io
import re
from datetime import datetime
from typing import List, Dict, Optional


class UBSParser:
    ENCODING = "latin-1"
    DELIMITER = ";"
    DATE_FORMAT = "%d.%m.%Y"

    # Possible header column names (normalized lowercase)
    VALUE_DATE_COLS = ["valuta", "valutadatum"]
    BOOKING_DATE_COLS = ["buchungsdatum", "buchungsdate", "datum"]
    DESCRIPTION_COLS = ["buchungstext", "beschreibung", "text"]
    DEBIT_COLS = ["belastung", "debit", "ausgabe"]
    CREDIT_COLS = ["gutschrift", "kredit", "einnahme"]
    BALANCE_COLS = ["saldo", "balance"]

    def parse(self, content: bytes) -> List[Dict]:
        """Parse UBS CSV bytes to list of normalized transaction dicts."""
        text = content.decode(self.ENCODING, errors="replace")
        lines = text.splitlines()

        # Find header line
        header_idx = self._find_header_line(lines)
        if header_idx is None:
            raise ValueError("Could not find UBS CSV header row (expected 'Valuta' or 'Buchungsdatum' column).")

        header = [col.strip().lower() for col in lines[header_idx].split(self.DELIMITER)]
        data_lines = lines[header_idx + 1:]

        # Map column names to indices
        col_map = self._map_columns(header)

        transactions = []
        for line in data_lines:
            line = line.strip()
            if not line:
                continue

            parts = line.split(self.DELIMITER)
            if len(parts) < 3:
                continue

            row = [p.strip().strip('"') for p in parts]

            # Parse date
            date_str = self._get_col(row, col_map.get("value_date") or col_map.get("booking_date"))
            if not date_str:
                continue
            try:
                date = datetime.strptime(date_str, self.DATE_FORMAT)
            except ValueError:
                continue

            booking_date_str = self._get_col(row, col_map.get("booking_date"))
            booking_date: Optional[datetime] = None
            if booking_date_str and booking_date_str != date_str:
                try:
                    booking_date = datetime.strptime(booking_date_str, self.DATE_FORMAT)
                except ValueError:
                    pass

            description = self._get_col(row, col_map.get("description")) or ""
            if not description.strip():
                continue

            # Amount: debit is negative, credit is positive
            debit_str = self._get_col(row, col_map.get("debit")) or ""
            credit_str = self._get_col(row, col_map.get("credit")) or ""

            amount = self._parse_amount(credit_str) or 0.0
            debit_amount = self._parse_amount(debit_str)
            if debit_amount:
                amount = -abs(debit_amount)

            if amount == 0.0 and not debit_str and not credit_str:
                continue

            transactions.append({
                "date": date,
                "booking_date": booking_date,
                "description": description,
                "amount": amount,
                "currency": "CHF",
            })

        return transactions

    def _find_header_line(self, lines: List[str]) -> Optional[int]:
        """Scan lines to find the header row."""
        for idx, line in enumerate(lines):
            normalized = line.lower()
            if any(kw in normalized for kw in ["valuta", "buchungsdatum", "belastung", "gutschrift"]):
                return idx
        return None

    def _map_columns(self, header: List[str]) -> Dict[str, int]:
        """Map semantic field names to column indices."""
        result = {}
        for i, col in enumerate(header):
            col_clean = col.replace("-", " ").replace("_", " ").strip()
            if any(v in col_clean for v in self.VALUE_DATE_COLS):
                result.setdefault("value_date", i)
            if any(v in col_clean for v in self.BOOKING_DATE_COLS):
                result.setdefault("booking_date", i)
            if any(v in col_clean for v in self.DESCRIPTION_COLS):
                result.setdefault("description", i)
            if any(v in col_clean for v in self.DEBIT_COLS):
                result.setdefault("debit", i)
            if any(v in col_clean for v in self.CREDIT_COLS):
                result.setdefault("credit", i)
            if any(v in col_clean for v in self.BALANCE_COLS):
                result.setdefault("balance", i)
        return result

    def _get_col(self, row: List[str], idx: Optional[int]) -> Optional[str]:
        if idx is None or idx >= len(row):
            return None
        val = row[idx].strip()
        return val if val else None

    def _parse_amount(self, value: str) -> Optional[float]:
        """Parse UBS amount string (may use period as thousands sep)."""
        if not value or not value.strip():
            return None
        cleaned = value.strip().replace("'", "").replace(",", ".")
        # Remove any trailing currency symbols
        cleaned = re.sub(r"[^\d.\-]", "", cleaned)
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
