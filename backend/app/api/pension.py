"""Pension data API — manage Pillar 1/2/3a records."""

from datetime import datetime
from typing import List, Optional

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.models import PensionData, PensionPillar, User
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter()


class PensionCreate(BaseModel):
    pillar: PensionPillar
    provider: Optional[str] = None
    current_balance: float = 0.0
    annual_contribution: float = 0.0
    expected_return_rate: float = 0.01
    retirement_age: int = 65
    contribution_years: Optional[int] = None
    average_insured_salary: Optional[float] = None
    notes: Optional[str] = None
    as_of_date: Optional[datetime] = None


class PensionResponse(BaseModel):
    id: int
    pillar: str
    provider: Optional[str]
    current_balance: float
    annual_contribution: float
    expected_return_rate: float
    retirement_age: int
    contribution_years: Optional[int]
    average_insured_salary: Optional[float]
    notes: Optional[str]
    as_of_date: Optional[datetime]


@router.get("", response_model=List[PensionResponse])
async def list_pension(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(PensionData).where(PensionData.user_id == current_user.id)
    )
    records = result.scalars().all()
    return [
        PensionResponse(
            id=r.id,
            pillar=r.pillar.value,
            provider=r.provider,
            current_balance=r.current_balance,
            annual_contribution=r.annual_contribution,
            expected_return_rate=r.expected_return_rate,
            retirement_age=r.retirement_age,
            contribution_years=r.contribution_years,
            average_insured_salary=r.average_insured_salary,
            notes=r.notes,
            as_of_date=r.as_of_date,
        )
        for r in records
    ]


@router.post("", response_model=PensionResponse, status_code=status.HTTP_201_CREATED)
async def create_pension(
    payload: PensionCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    record = PensionData(user_id=current_user.id, **payload.model_dump())
    db.add(record)
    await db.flush()
    await db.commit()
    await db.refresh(record)
    return PensionResponse(
        id=record.id,
        pillar=record.pillar.value,
        provider=record.provider,
        current_balance=record.current_balance,
        annual_contribution=record.annual_contribution,
        expected_return_rate=record.expected_return_rate,
        retirement_age=record.retirement_age,
        contribution_years=record.contribution_years,
        average_insured_salary=record.average_insured_salary,
        notes=record.notes,
        as_of_date=record.as_of_date,
    )


@router.put("/{pension_id}", response_model=PensionResponse)
async def update_pension(
    pension_id: int,
    payload: PensionCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(PensionData).where(
            PensionData.id == pension_id, PensionData.user_id == current_user.id
        )
    )
    record = result.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Pension record not found.")
    for k, v in payload.model_dump().items():
        setattr(record, k, v)
    await db.flush()
    await db.commit()
    await db.refresh(record)
    return PensionResponse(
        id=record.id,
        pillar=record.pillar.value,
        provider=record.provider,
        current_balance=record.current_balance,
        annual_contribution=record.annual_contribution,
        expected_return_rate=record.expected_return_rate,
        retirement_age=record.retirement_age,
        contribution_years=record.contribution_years,
        average_insured_salary=record.average_insured_salary,
        notes=record.notes,
        as_of_date=record.as_of_date,
    )


@router.delete("/{pension_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_pension(
    pension_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(PensionData).where(
            PensionData.id == pension_id, PensionData.user_id == current_user.id
        )
    )
    record = result.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Pension record not found.")
    await db.delete(record)
