"""Budgets API."""
from datetime import datetime
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.core.database import get_db
from app.core.security import get_current_user
from app.models.models import Budget, BudgetPeriod, User

router = APIRouter()


class BudgetCreate(BaseModel):
    category_id: Optional[int] = None
    amount: float
    period: BudgetPeriod = BudgetPeriod.monthly
    year: int
    month: Optional[int] = None
    notes: Optional[str] = None


class BudgetUpdate(BaseModel):
    """Partial-update model — all fields optional except amount."""
    amount: float
    category_id: Optional[int] = None
    period: Optional[BudgetPeriod] = None
    year: Optional[int] = None
    month: Optional[int] = None
    notes: Optional[str] = None


class BudgetResponse(BaseModel):
    id: int
    category_id: Optional[int]
    amount: float
    period: str
    year: int
    month: Optional[int]
    notes: Optional[str]
    created_at: Optional[datetime] = None   # needed for wizard-batch filtering


@router.get("", response_model=List[BudgetResponse])
async def list_budgets(
    year: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    filters = [Budget.user_id == current_user.id]
    if year:
        filters.append(Budget.year == year)
    from sqlalchemy import and_
    result = await db.execute(select(Budget).where(and_(*filters)))
    budgets = result.scalars().all()
    return [
        BudgetResponse(
            id=b.id, category_id=b.category_id, amount=b.amount,
            period=b.period.value, year=b.year, month=b.month, notes=b.notes,
            created_at=b.created_at,
        ) for b in budgets
    ]


@router.post("", response_model=BudgetResponse, status_code=status.HTTP_201_CREATED)
async def create_budget(
    payload: BudgetCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    budget = Budget(user_id=current_user.id, **payload.model_dump())
    db.add(budget)
    await db.flush()
    await db.refresh(budget)
    return BudgetResponse(
        id=budget.id, category_id=budget.category_id, amount=budget.amount,
        period=budget.period.value, year=budget.year, month=budget.month, notes=budget.notes,
    )


@router.put("/{budget_id}", response_model=BudgetResponse)
async def update_budget(
    budget_id: int,
    payload: BudgetUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Budget).where(Budget.id == budget_id, Budget.user_id == current_user.id)
    )
    budget = result.scalar_one_or_none()
    if not budget:
        raise HTTPException(status_code=404, detail="Budget not found.")
    # Only overwrite fields that were explicitly provided
    for k, v in payload.model_dump(exclude_none=True).items():
        setattr(budget, k, v)
    await db.flush()
    await db.refresh(budget)
    return BudgetResponse(
        id=budget.id, category_id=budget.category_id, amount=budget.amount,
        period=budget.period.value, year=budget.year, month=budget.month, notes=budget.notes,
        created_at=budget.created_at,
    )
