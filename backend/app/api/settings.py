"""
Settings API — category mappings between wizard labels and transaction categories.

GET  /api/settings/category-mappings  → list of {wizard_label, transaction_category}
PUT  /api/settings/category-mappings  → upsert mappings for the user
"""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.taxonomy import default_transaction_category_for_wizard_label, load_merged_taxonomy_for_user
from app.models.models import Account, Transaction, User, WizardCategoryMapping

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Pydantic models ───────────────────────────────────────────

class CategoryMappingItem(BaseModel):
    wizard_label: str
    transaction_category: str


class CategoryMappingsResponse(BaseModel):
    mappings: List[CategoryMappingItem]
    wizard_labels: List[str]          # known wizard labels from budgets
    transaction_categories: List[str]  # known txn categories from transactions


class PutMappingsRequest(BaseModel):
    mappings: List[CategoryMappingItem]


# ── Helpers ───────────────────────────────────────────────────

async def _get_wizard_labels(user_id: int, db: AsyncSession) -> list[str]:
    """Return distinct wizard budget labels (notes) for the user's latest batch."""
    from app.models.models import Budget
    ts_result = await db.execute(
        select(func.max(Budget.created_at)).where(Budget.user_id == user_id)
    )
    latest_ts = ts_result.scalar_one_or_none()
    if latest_ts is None:
        return []
    result = await db.execute(
        select(Budget.notes).where(
            and_(Budget.user_id == user_id, Budget.created_at == latest_ts)
        ).distinct()
    )
    return sorted([r for r in result.scalars() if r])


async def _get_txn_categories(user_id: int, db: AsyncSession) -> list[str]:
    """Return distinct transaction categories for the user."""
    result = await db.execute(
        select(Transaction.category)
        .join(Account)
        .where(
            and_(
                Account.user_id == user_id,
                Transaction.is_deleted.isnot(True),
                Transaction.category.isnot(None),
            )
        )
        .distinct()
    )
    return sorted([r for r in result.scalars() if r])


# ── Endpoints ─────────────────────────────────────────────────

@router.get("/category-mappings", response_model=CategoryMappingsResponse)
async def get_category_mappings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the user's category mappings merged with defaults."""
    # User-specific overrides
    result = await db.execute(
        select(WizardCategoryMapping).where(
            WizardCategoryMapping.user_id == current_user.id
        )
    )
    user_rows = {m.wizard_label.lower(): m for m in result.scalars()}

    wizard_labels = await _get_wizard_labels(current_user.id, db)
    txn_categories = await _get_txn_categories(current_user.id, db)
    merged = await load_merged_taxonomy_for_user(db, current_user.id)

    # Build effective mappings: user override → taxonomy default → ""
    mappings: list[CategoryMappingItem] = []
    for label in wizard_labels:
        lower = label.lower()
        if lower in user_rows:
            txn_cat = user_rows[lower].transaction_category
        else:
            txn_cat = default_transaction_category_for_wizard_label(merged, label)
        mappings.append(CategoryMappingItem(wizard_label=label, transaction_category=txn_cat))

    return CategoryMappingsResponse(
        mappings=mappings,
        wizard_labels=wizard_labels,
        transaction_categories=txn_categories,
    )


@router.put("/category-mappings", response_model=CategoryMappingsResponse)
async def put_category_mappings(
    body: PutMappingsRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upsert category mappings for the current user."""
    # Load existing
    result = await db.execute(
        select(WizardCategoryMapping).where(
            WizardCategoryMapping.user_id == current_user.id
        )
    )
    existing = {m.wizard_label.lower(): m for m in result.scalars()}

    for item in body.mappings:
        lower = item.wizard_label.lower()
        if lower in existing:
            existing[lower].transaction_category = item.transaction_category
        else:
            db.add(WizardCategoryMapping(
                user_id=current_user.id,
                wizard_label=item.wizard_label,
                transaction_category=item.transaction_category,
            ))

    await db.commit()

    # Return updated state
    wizard_labels = await _get_wizard_labels(current_user.id, db)
    txn_categories = await _get_txn_categories(current_user.id, db)
    merged = await load_merged_taxonomy_for_user(db, current_user.id)

    result2 = await db.execute(
        select(WizardCategoryMapping).where(
            WizardCategoryMapping.user_id == current_user.id
        )
    )
    user_rows2 = {m.wizard_label.lower(): m for m in result2.scalars()}

    mappings: list[CategoryMappingItem] = []
    for label in wizard_labels:
        lower = label.lower()
        if lower in user_rows2:
            txn_cat = user_rows2[lower].transaction_category
        else:
            txn_cat = default_transaction_category_for_wizard_label(merged, label)
        mappings.append(CategoryMappingItem(wizard_label=label, transaction_category=txn_cat))

    return CategoryMappingsResponse(
        mappings=mappings,
        wizard_labels=wizard_labels,
        transaction_categories=txn_categories,
    )


@router.delete("/category-mappings", status_code=204)
async def reset_category_mappings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Reset all user-specific mappings (reverts to defaults)."""
    result = await db.execute(
        select(WizardCategoryMapping).where(
            WizardCategoryMapping.user_id == current_user.id
        )
    )
    for row in result.scalars():
        await db.delete(row)
    await db.commit()
