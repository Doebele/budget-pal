"""
Pure helpers for matching PDF preview rows (in-file duplicates, normalized keys).
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional, Tuple

DUPLICATE_AMOUNT_TOLERANCE = 0.01


def row_signature(original_date: str, amount: float, description: str) -> Tuple[str, float, str]:
    """Normalize preview row fields for equality checks."""
    d = original_date.strip()[:10]
    desc = description.strip()
    am = float(amount)
    return (d, round(am, 2), desc)


def find_pdf_internal_duplicate_of(
    prior: List[Tuple[str, str, float, str]],
    original_date: str,
    amount: float,
    description: str,
) -> Optional[str]:
    """
    If an earlier preview row (same PDF) matches date, amount (within tolerance), and
    description, return that row's id. Otherwise None.
    """
    d, _rounded, desc = row_signature(original_date, amount, description)
    am = float(amount)
    for row_id, pd, pam, pdesc in prior:
        if pd != d or pdesc != desc:
            continue
        if abs(am - float(pam)) < DUPLICATE_AMOUNT_TOLERANCE:
            return row_id
    return None


def normalize_preview_date_str(date_val: object) -> str:
    """Coerce parser output to YYYY-MM-DD for hashing and display."""
    if isinstance(date_val, datetime):
        return date_val.strftime("%Y-%m-%d")
    if date_val:
        return str(date_val).strip()[:10]
    return ""
