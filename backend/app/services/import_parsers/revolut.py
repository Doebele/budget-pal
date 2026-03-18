"""
Revolut CSV parser.

Format:
- Encoding: UTF-8
- Delimiter: comma
- Headers: Type, Product, Started Date, Completed Date, Description,
           Amount, Fee, Currency, State, Balance
- Date format: YYYY-MM-DD HH:MM:SS
- Filter: State == "COMPLETED" only
- Fee is a separate column (positive number, represents a charge)
"""
import csv
import io
from datetime import datetime
from typing import List, Dict, Optional


class RevolutParser:
    ENCODING = "utf-8"
    DELIMITER = ","
    DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
    DATE_FORMAT_ALT = "%Y-%m-%d"
    VALID_STATES = {"completed"}

    def parse(self, content: bytes) -> List[Dict]:
        """Parse Revolut CSV export to normalized transaction list."""
        text = content.decode(self.ENCODING, errors="replace")
        reader = csv.DictReader(io.StringIO(text))

        # Normalize header keys (strip whitespace, lowercase)
        if reader.fieldnames is None:
            raise ValueError("Revolut CSV appears to be empty or has no header.")

        fieldnames_normalized = {
            k.strip().lower(): k for k in reader.fieldnames if k
        }

        def find_field(candidates: List[str]) -> Optional[str]:
            for c in candidates:
                if c in fieldnames_normalized:
                    return fieldnames_normalized[c]
            return None

        f_type = find_field(["type"])
        f_product = find_field(["product"])
        f_started = find_field(["started date", "started_date"])
        f_completed = find_field(["completed date", "completed_date"])
        f_description = find_field(["description"])
        f_amount = find_field(["amount"])
        f_fee = find_field(["fee"])
        f_currency = find_field(["currency"])
        f_state = find_field(["state"])
        f_balance = find_field(["balance"])

        if not f_amount or not f_description:
            raise ValueError("Could not find required Revolut columns (Amount, Description).")

        transactions = []
        for row in reader:
            state = (row.get(f_state, "") or "").strip().lower()
            if state not in self.VALID_STATES:
                continue

            # Parse date (prefer completed date, fall back to started)
            date_str = (
                row.get(f_completed, "") or
                row.get(f_started, "") or ""
            ).strip()

            date: Optional[datetime] = None
            for fmt in (self.DATE_FORMAT, self.DATE_FORMAT_ALT):
                try:
                    date = datetime.strptime(date_str, fmt)
                    break
                except (ValueError, TypeError):
                    continue

            if date is None:
                continue

            description = (row.get(f_description, "") or "").strip()
            txn_type = (row.get(f_type, "") or "").strip()
            product = (row.get(f_product, "") or "").strip()

            # Augment description with type
            if txn_type and txn_type.lower() not in description.lower():
                description = f"{description} ({txn_type})" if description else txn_type

            amount_str = (row.get(f_amount, "") or "").strip()
            try:
                amount = float(amount_str)
            except (ValueError, TypeError):
                continue

            # Fee — treat as a separate expense (negative) only if > 0
            fee_str = (row.get(f_fee, "") or "0").strip()
            try:
                fee = float(fee_str)
            except (ValueError, TypeError):
                fee = 0.0

            currency = (row.get(f_currency, "EUR") or "EUR").strip().upper()

            txn = {
                "date": date,
                "description": description or "Revolut Transaction",
                "amount": amount,
                "currency": currency,
            }
            transactions.append(txn)

            # Append fee as a separate transaction if present
            if fee > 0:
                transactions.append({
                    "date": date,
                    "description": f"Revolut Fee — {description}",
                    "amount": -fee,
                    "currency": currency,
                })

        return transactions
