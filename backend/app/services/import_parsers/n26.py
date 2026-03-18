"""
N26 CSV parser.

Format:
- Encoding: UTF-8 with BOM (utf-8-sig)
- Delimiter: comma
- Date format: YYYY-MM-DD
- Columns: Date, Payee, Account number, Transaction type, Payment reference,
           Amount (EUR), Amount (Foreign Currency), Type Foreign Currency, Exchange Rate
- Negative amount = debit, positive = credit
"""
import re
from datetime import datetime
from typing import List, Dict, Optional


class N26Parser:
    ENCODING = "utf-8-sig"
    DELIMITER = ","
    DATE_FORMAT = "%Y-%m-%d"

    # Expected header columns (lowercase, stripped)
    COL_DATE = "date"
    COL_PAYEE = "payee"
    COL_TYPE = "transaction type"
    COL_REFERENCE = "payment reference"
    COL_AMOUNT_EUR = "amount (eur)"
    COL_AMOUNT_FC = "amount (foreign currency)"
    COL_FC_TYPE = "type foreign currency"
    COL_EXCHANGE_RATE = "exchange rate"

    def parse(self, content: bytes) -> List[Dict]:
        """Parse N26 CSV export to normalized transaction list."""
        text = content.decode(self.ENCODING, errors="replace")
        lines = [l.strip() for l in text.splitlines() if l.strip()]

        if not lines:
            raise ValueError("N26 CSV file is empty.")

        # Parse header
        header = [col.strip('"').lower() for col in lines[0].split(self.DELIMITER)]

        # Find column indices
        def find_col(name: str) -> Optional[int]:
            for i, h in enumerate(header):
                if name in h:
                    return i
            return None

        idx_date = find_col("date")
        idx_payee = find_col("payee")
        idx_type = find_col("transaction type")
        idx_ref = find_col("payment reference")
        idx_amount = find_col("amount (eur)") or find_col("amount")
        idx_fc_amount = find_col("amount (foreign currency)")
        idx_fc_type = find_col("type foreign currency")
        idx_rate = find_col("exchange rate")

        if idx_date is None or idx_amount is None:
            raise ValueError("Could not find required columns (Date, Amount) in N26 CSV.")

        transactions = []
        for line in lines[1:]:
            # Handle quoted fields with commas
            parts = self._split_csv_line(line)
            if len(parts) < 3:
                continue

            def get(idx: Optional[int]) -> str:
                if idx is None or idx >= len(parts):
                    return ""
                return parts[idx].strip().strip('"')

            date_str = get(idx_date)
            if not date_str:
                continue
            try:
                date = datetime.strptime(date_str, self.DATE_FORMAT)
            except ValueError:
                continue

            payee = get(idx_payee)
            txn_type = get(idx_type)
            reference = get(idx_ref)

            # Build description from available fields
            parts_desc = [p for p in [payee, txn_type, reference] if p]
            description = " | ".join(parts_desc) if parts_desc else "N26 Transaction"

            amount_str = get(idx_amount)
            try:
                amount = float(amount_str.replace(",", "."))
            except ValueError:
                continue

            # Foreign currency fields
            fc_amount_str = get(idx_fc_amount)
            fc_type = get(idx_fc_type)
            rate_str = get(idx_rate)

            original_amount: Optional[float] = None
            original_currency: Optional[str] = None
            exchange_rate: Optional[float] = None

            if fc_amount_str and fc_type and fc_type.upper() not in ("EUR", ""):
                try:
                    original_amount = float(fc_amount_str.replace(",", "."))
                    original_currency = fc_type.upper()
                except ValueError:
                    pass

            if rate_str:
                try:
                    exchange_rate = float(rate_str.replace(",", "."))
                except ValueError:
                    pass

            txn = {
                "date": date,
                "description": description,
                "amount": amount,
                "currency": "EUR",
            }
            if original_amount is not None:
                txn["original_amount"] = original_amount
                txn["original_currency"] = original_currency
            if exchange_rate is not None:
                txn["exchange_rate"] = exchange_rate

            transactions.append(txn)

        return transactions

    def _split_csv_line(self, line: str) -> List[str]:
        """Split a CSV line respecting quoted fields."""
        import csv
        reader = csv.reader([line])
        return next(reader, [])
