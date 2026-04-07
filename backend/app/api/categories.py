"""Categories API."""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, func, update, distinct
from app.core.database import get_db
from app.core.security import get_current_user
from app.models.models import Category, Transaction, User

router = APIRouter()


class CategoryCreate(BaseModel):
    name: str
    slug: str
    parent_id: Optional[int] = None
    color: Optional[str] = None
    # `icon` field is reused to store the supercategory ID (e.g. "wohnen", "sparen")
    icon: Optional[str] = None


class CategoryResponse(BaseModel):
    id: int
    name: str
    slug: str
    parent_id: Optional[int]
    color: Optional[str]
    icon: Optional[str]
    is_system: bool
    txn_count: int = 0


@router.get("", response_model=List[CategoryResponse])
async def list_categories(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Category, func.count(Transaction.id).label("txn_count"))
        .outerjoin(
            Transaction,
            (Transaction.category_id == Category.id) & (Transaction.is_deleted == False),
        )
        .where(or_(Category.user_id == current_user.id, Category.is_system == True))
        .group_by(Category.id)
        .order_by(Category.sort_order, Category.name)
    )
    rows = result.all()
    return [
        CategoryResponse(
            id=c.id,
            name=c.name,
            slug=c.slug,
            parent_id=c.parent_id,
            color=c.color,
            icon=c.icon,
            is_system=c.is_system,
            txn_count=count or 0,
        )
        for c, count in rows
    ]


@router.post("", response_model=CategoryResponse, status_code=status.HTTP_201_CREATED)
async def create_category(
    payload: CategoryCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cat = Category(user_id=current_user.id, **payload.model_dump())
    db.add(cat)
    await db.flush()
    await db.refresh(cat)
    return CategoryResponse(
        id=cat.id,
        name=cat.name,
        slug=cat.slug,
        parent_id=cat.parent_id,
        color=cat.color,
        icon=cat.icon,
        is_system=cat.is_system,
        txn_count=0,
    )


@router.put("/{category_id}", response_model=CategoryResponse)
async def update_category(
    category_id: int,
    payload: CategoryCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Category).where(
            Category.id == category_id, Category.user_id == current_user.id
        )
    )
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found.")

    old_name = cat.name
    new_name = payload.name

    for k, v in payload.model_dump().items():
        setattr(cat, k, v)

    # Keep transaction.category strings in sync when renaming
    if old_name != new_name:
        await db.execute(
            update(Transaction)
            .where(Transaction.category_id == category_id)
            .values(category=new_name)
        )

    await db.flush()
    await db.refresh(cat)

    txn_count = await db.scalar(
        select(func.count(Transaction.id)).where(
            Transaction.category_id == category_id,
            Transaction.is_deleted == False,
        )
    )
    return CategoryResponse(
        id=cat.id,
        name=cat.name,
        slug=cat.slug,
        parent_id=cat.parent_id,
        color=cat.color,
        icon=cat.icon,
        is_system=cat.is_system,
        txn_count=txn_count or 0,
    )


@router.delete("/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_category(
    category_id: int,
    reassign_to_id: Optional[int] = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Category).where(
            Category.id == category_id,
            Category.user_id == current_user.id,
            Category.is_system == False,
        )
    )
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(
            status_code=404,
            detail="Category not found or is a system category.",
        )

    # If a reassignment target is given, migrate transactions first
    if reassign_to_id is not None:
        target_result = await db.execute(
            select(Category).where(Category.id == reassign_to_id)
        )
        target = target_result.scalar_one_or_none()
        if not target:
            raise HTTPException(
                status_code=404, detail="Reassignment target category not found."
            )
        await db.execute(
            update(Transaction)
            .where(Transaction.category_id == category_id)
            .values(category_id=reassign_to_id, category=target.name)
        )

    await db.delete(cat)


# ── Label-level helpers (for taxonomy management) ─────────────


class LabelStat(BaseModel):
    label: str
    txn_count: int


class MigrateLabelPayload(BaseModel):
    old_label: str
    new_label: str


@router.get("/label-stats", response_model=List[LabelStat])
async def get_label_stats(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return all distinct transaction category strings with their counts for this user."""
    result = await db.execute(
        select(Transaction.category, func.count(Transaction.id).label("cnt"))
        .join(Transaction.account)
        .where(
            Transaction.is_deleted == False,
            Transaction.category.isnot(None),
        )
        .group_by(Transaction.category)
        .order_by(Transaction.category)
    )
    return [LabelStat(label=row.category, txn_count=row.cnt) for row in result.all()]


@router.post("/migrate-label", status_code=status.HTTP_200_OK)
async def migrate_label(
    payload: MigrateLabelPayload,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Rename all transactions with category == old_label to new_label (case-insensitive)."""
    if not payload.old_label.strip() or not payload.new_label.strip():
        raise HTTPException(status_code=400, detail="Labels must not be empty.")
    if payload.old_label.strip() == payload.new_label.strip():
        raise HTTPException(status_code=400, detail="old_label and new_label are identical.")

    old_lower = payload.old_label.strip().lower()
    new_name = payload.new_label.strip()

    # Count before update
    affected = await db.scalar(
        select(func.count(Transaction.id)).where(
            func.lower(Transaction.category) == old_lower,
            Transaction.is_deleted == False,
        )
    ) or 0

    # Migrate category string on transactions
    await db.execute(
        update(Transaction)
        .where(
            func.lower(Transaction.category) == old_lower,
            Transaction.is_deleted == False,
        )
        .values(category=new_name)
    )

    # Also migrate category_id if a user Category with that name exists
    old_cat_result = await db.execute(
        select(Category).where(
            func.lower(Category.name) == old_lower,
            Category.user_id == current_user.id,
        )
    )
    old_cat = old_cat_result.scalar_one_or_none()
    if old_cat:
        new_cat_result = await db.execute(
            select(Category).where(
                func.lower(Category.name) == new_name.lower(),
            )
        )
        new_cat = new_cat_result.scalar_one_or_none()
        if new_cat:
            await db.execute(
                update(Transaction)
                .where(Transaction.category_id == old_cat.id)
                .values(category_id=new_cat.id)
            )

    return {"migrated": affected, "old_label": payload.old_label, "new_label": new_name}
