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

        # Check if we have explicit debit/credit columns or need to calculate from balance
        has_debit_credit = col_map.get("debit") is not None or col_map.get("credit") is not None
        has_balance = col_map.get("balance") is not None

        transactions = []
        prev_balance: Optional[float] = None

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

            amount: float = 0.0

            if has_debit_credit:
                # Standard case: use explicit Belastung/Gutschrift columns
                debit_str = self._get_col(row, col_map.get("debit")) or ""
                credit_str = self._get_col(row, col_map.get("credit")) or ""

                credit_amount = self._parse_amount(credit_str) or 0.0
                debit_amount = self._parse_amount(debit_str)
                if debit_amount:
                    amount = -abs(debit_amount)
                else:
                    amount = credit_amount

            elif has_balance:
                # Calculate amount from balance difference (Saldo-based CSV)
                # CSV rows are typically in reverse chronological order (newest first)
                balance_str = self._get_col(row, col_map.get("balance")) or ""
                current_balance = self._parse_amount(balance_str)

                if current_balance is None:
                    continue

                if prev_balance is not None:
                    # Amount = previous balance - current balance
                    # If previous balance was higher, it's a debit (negative)
                    # If current balance is higher, it's a credit (positive)
                    amount = prev_balance - current_balance
                else:
                    # First row - can't calculate amount without previous balance
                    # Skip or use amount as 0
                    amount = 0.0

                prev_balance = current_balance
            else:
                # Neither debit/credit nor balance columns found
                continue

            if amount == 0.0 and not has_balance:
                continue

            transactions.append({
                "date": date,
                "booking_date": booking_date,
                "description": description,
                "amount": amount,
                "currency": "CHF",
                "balance": prev_balance if has_balance else None,
            })

        # If we calculated amounts from balance, the transactions are in reverse order
        # Reverse them to get chronological order (oldest first)
        if has_balance and not has_debit_credit:
            transactions.reverse()
            # Recalculate amounts after reversing since we need forward calculation
            transactions = self._recalculate_amounts_from_balance(transactions)

        return transactions

    def _recalculate_amounts_from_balance(self, transactions: List[Dict]) -> List[Dict]:
        """Recalculate transaction amounts from balance differences in chronological order."""
        if not transactions:
            return transactions

        # Sort by date (oldest first)
        sorted_txns = sorted(transactions, key=lambda x: x["date"])

        prev_balance: Optional[float] = None
        for txn in sorted_txns:
            balance = txn.get("balance")
            if balance is not None and prev_balance is not None:
                # Amount = current balance - previous balance
                txn["amount"] = balance - prev_balance
            elif balance is not None and prev_balance is None:
                # First transaction - set amount to 0 (we don't know the starting balance)
                txn["amount"] = 0.0
            prev_balance = balance

        return sorted_txns

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
