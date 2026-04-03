"""
Match PDF preview rows against stored transactions (PostgreSQL or SQLite).
"""

from __future__ import annotations

from datetime import datetime, date
from typing import Optional

from sqlalchemy import Date, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Transaction

from app.services.pdf_import_row_match import DUPLICATE_AMOUNT_TOLERANCE


async def find_database_duplicate_transaction_id(
    db: AsyncSession,
    account_id: int,
    original_date: str,
    amount: float,
    description: str,
    import_hash: str,
) -> Optional[int]:
    """
    Return an active transaction id that matches this preview row.

    Prefer indexed import_hash; fall back to date + amount + description for legacy rows.
    """
    q_hash = (
        await db.execute(
            select(Transaction.id)
            .where(
                Transaction.account_id == account_id,
                Transaction.is_deleted.isnot(True),
                Transaction.import_hash == import_hash,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if q_hash is not None:
        return q_hash

    try:
        d_only: date = datetime.strptime(original_date.strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return None

    desc = description.strip()
    am = float(amount)

    q_fields = (
        await db.execute(
            select(Transaction.id)
            .where(
                Transaction.account_id == account_id,
                Transaction.is_deleted.isnot(True),
                cast(Transaction.date, Date) == d_only,
                func.abs(Transaction.amount - am) < DUPLICATE_AMOUNT_TOLERANCE,
                Transaction.description == desc,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    return q_fields
