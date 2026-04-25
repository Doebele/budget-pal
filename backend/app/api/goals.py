"""
Goals API — Financial targets with progress tracking.

GET    /goals                — list all goals for current user
POST   /goals                — create a new goal
PUT    /goals/{id}           — update
DELETE /goals/{id}           — delete
GET    /goals/{id}/projection — months to target at current contribution rate
"""
from datetime import date, datetime
from typing import List, Optional
from math import ceil

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.models import Goal, GoalType, Account, User

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────

class GoalCreate(BaseModel):
    name: str
    goal_type: GoalType = GoalType.savings
    target_amount: float
    current_amount: float = 0.0
    monthly_contribution: float = 0.0
    deadline: Optional[date] = None
    linked_account_id: Optional[int] = None
    notes: Optional[str] = None


class GoalUpdate(BaseModel):
    name: Optional[str] = None
    goal_type: Optional[GoalType] = None
    target_amount: Optional[float] = None
    current_amount: Optional[float] = None
    monthly_contribution: Optional[float] = None
    deadline: Optional[date] = None
    linked_account_id: Optional[int] = None
    notes: Optional[str] = None
    is_achieved: Optional[bool] = None


class GoalResponse(BaseModel):
    id: int
    name: str
    goal_type: GoalType
    target_amount: float
    current_amount: float
    monthly_contribution: float
    deadline: Optional[date]
    linked_account_id: Optional[int]
    linked_account_name: Optional[str]
    notes: Optional[str]
    is_achieved: bool
    # Computed
    progress_pct: float
    remaining: float
    months_to_target: Optional[int]
    eta: Optional[date]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


def _compute_projection(goal: Goal) -> dict:
    remaining = max(0.0, goal.target_amount - goal.current_amount)
    progress_pct = min(100.0, (goal.current_amount / goal.target_amount * 100) if goal.target_amount > 0 else 0)

    months_to_target: Optional[int] = None
    eta: Optional[date] = None

    if remaining <= 0:
        months_to_target = 0
    elif goal.monthly_contribution and goal.monthly_contribution > 0:
        months_to_target = ceil(remaining / goal.monthly_contribution)
        today = date.today()
        month = today.month + months_to_target - 1
        year = today.year + month // 12
        month = month % 12 + 1
        try:
            eta = date(year, month, 1)
        except ValueError:
            eta = None

    return {
        "progress_pct": round(progress_pct, 1),
        "remaining": round(remaining, 2),
        "months_to_target": months_to_target,
        "eta": eta,
    }


def _to_response(goal: Goal) -> GoalResponse:
    proj = _compute_projection(goal)
    return GoalResponse(
        id=goal.id,
        name=goal.name,
        goal_type=goal.goal_type,
        target_amount=goal.target_amount,
        current_amount=goal.current_amount,
        monthly_contribution=goal.monthly_contribution,
        deadline=goal.deadline,
        linked_account_id=goal.linked_account_id,
        linked_account_name=goal.linked_account.name if goal.linked_account else None,
        notes=goal.notes,
        is_achieved=goal.is_achieved,
        created_at=goal.created_at,
        updated_at=goal.updated_at,
        **proj,
    )


async def _get_goal(goal_id: int, user: User, db: AsyncSession) -> Goal:
    from sqlalchemy.orm import selectinload
    result = await db.execute(
        select(Goal)
        .options(selectinload(Goal.linked_account))
        .where(Goal.id == goal_id, Goal.user_id == user.id)
    )
    g = result.scalar_one_or_none()
    if g is None:
        raise HTTPException(status_code=404, detail="Goal not found.")
    return g


# ── Routes ────────────────────────────────────────────────────

@router.get("", response_model=List[GoalResponse])
async def list_goals(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy.orm import selectinload
    result = await db.execute(
        select(Goal)
        .options(selectinload(Goal.linked_account))
        .where(Goal.user_id == current_user.id)
        .order_by(Goal.created_at.desc())
    )
    goals = result.scalars().all()
    return [_to_response(g) for g in goals]


@router.post("", response_model=GoalResponse, status_code=201)
async def create_goal(
    payload: GoalCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Validate linked account belongs to user
    if payload.linked_account_id is not None:
        acc = (await db.execute(
            select(Account).where(Account.id == payload.linked_account_id, Account.user_id == current_user.id)
        )).scalar_one_or_none()
        if acc is None:
            raise HTTPException(status_code=404, detail="Linked account not found.")

    g = Goal(
        user_id=current_user.id,
        **payload.model_dump(),
    )
    db.add(g)
    await db.commit()
    await db.refresh(g)
    return await _get_goal(g.id, current_user, db)


@router.put("/{goal_id}", response_model=GoalResponse)
async def update_goal(
    goal_id: int,
    payload: GoalUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    g = await _get_goal(goal_id, current_user, db)
    data = payload.model_dump(exclude_none=True)

    if "linked_account_id" in data and data["linked_account_id"] is not None:
        acc = (await db.execute(
            select(Account).where(Account.id == data["linked_account_id"], Account.user_id == current_user.id)
        )).scalar_one_or_none()
        if acc is None:
            raise HTTPException(status_code=404, detail="Linked account not found.")

    for k, v in data.items():
        setattr(g, k, v)

    # Auto-mark as achieved
    if g.current_amount >= g.target_amount:
        g.is_achieved = True

    await db.commit()
    return await _get_goal(goal_id, current_user, db)


@router.delete("/{goal_id}", status_code=204)
async def delete_goal(
    goal_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    g = await _get_goal(goal_id, current_user, db)
    await db.delete(g)
    await db.commit()
