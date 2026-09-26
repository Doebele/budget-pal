"""Pension data API — manage Pillar 1/2/3a records."""

from datetime import datetime
from typing import List, Optional

from app.core.config import settings
from app.core.database import get_db
from app.core.security import get_current_user
from app.models.models import PensionData, PensionPillar, User
from app.api.budget_multimodal import _get_wizard_scenario
from app.services.capital_tax import tax_profile
from app.services.projection import ProjectionService
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
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
    # Saeule 2: Umwandlungssatz laut Vorsorgeausweis, Bruchteil (0.053 = 5.3 %)
    conversion_rate: Optional[float] = Field(default=None, ge=0.02, le=0.08)
    # Saeule 2: Anteil als Kapital (0-1); Saeule 3a: Bezugsalter (60-70)
    capital_share: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    withdrawal_age: Optional[int] = Field(default=None, ge=60, le=70)
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
    conversion_rate: Optional[float]
    capital_share: Optional[float]
    withdrawal_age: Optional[int]
    notes: Optional[str]
    as_of_date: Optional[datetime]


def _to_response(r: PensionData) -> PensionResponse:
    return PensionResponse(
        id=r.id,
        pillar=r.pillar.value,
        provider=r.provider,
        current_balance=r.current_balance,
        annual_contribution=r.annual_contribution,
        expected_return_rate=r.expected_return_rate,
        retirement_age=r.retirement_age,
        contribution_years=r.contribution_years,
        average_insured_salary=r.average_insured_salary,
        conversion_rate=r.conversion_rate,
        capital_share=r.capital_share,
        withdrawal_age=r.withdrawal_age,
        notes=r.notes,
        as_of_date=r.as_of_date,
    )


# ── Schaetzung bei Pensionierung ──────────────────────────────
# Eine Rechnung fuer Wizard, Finanzplan und Prognose (ProjectionService).

class Pillar3aInput(BaseModel):
    balance: float = 0.0
    annual_contribution: float = 0.0
    return_rate: float = 0.03
    provider: Optional[str] = Field(default=None, max_length=120)
    # None = der Planer staffelt
    withdrawal_age: Optional[int] = Field(default=None, ge=60, le=70)


class PensionEstimateRequest(BaseModel):
    """Werte, die noch nicht gespeichert sind — der Wizard rechnet live."""
    current_age: int = Field(ge=15, le=100)
    retirement_age: int = Field(default=65, ge=55, le=75)
    ahv_contribution_years: Optional[int] = Field(default=None, ge=0, le=60)
    ahv_average_income: float = Field(default=0.0, ge=0)
    bvg_balance: float = 0.0
    bvg_annual_contribution: float = 0.0
    bvg_return_rate: float = 0.015
    bvg_conversion_rate: Optional[float] = Field(default=None, ge=0.02, le=0.08)
    bvg_capital_share: float = Field(default=0.0, ge=0.0, le=1.0)
    pillar_3a: List[Pillar3aInput] = []
    inflation_rate: Optional[float] = Field(default=None, ge=0, le=0.1)
    canton: str = Field(default="ZH", min_length=2, max_length=2)
    married: bool = False


class CapitalWithdrawal(BaseModel):
    source: str      # "bvg" | "3a"
    label: str
    age: int
    year: int
    amount: float    # heutige CHF, brutto
    tax: float       # Anteil an der Steuer des Bezugsjahres
    account: Optional[int] = None  # nur 3a: Position des Kontos in der Eingabe


class PensionEstimate(BaseModel):
    """Alle Betraege in heutigen CHF; Monatswerte = Jahreswert / 12."""
    retirement_age: int
    years_to_retirement: int
    ahv_start_age: int
    bvg_start_age: int
    ahv_monthly: float
    bvg_capital: float
    bvg_conversion_rate: float
    bvg_capital_share: float
    bvg_lump_sum: float
    bvg_monthly: float
    pillar_3a_capital: float
    pillar_3b_capital: float
    pillar_3b_monthly: float
    # Bezugsplan: jedes Kapital mit Alter und Steuer; Summe und Vergleich mit
    # einem einzigen Bezugsjahr
    capital_withdrawals: List[CapitalWithdrawal]
    capital_tax: float
    capital_tax_single_year: float
    capital_net: float
    # Monatliche Renten (AHV + BVG + 3b); Kapitalbezuege sind nicht darin
    total_monthly: float


_service = ProjectionService()


def _age_from(dob: Optional[datetime]) -> int:
    # Kalenderjahr-Differenz, wie ProjectionService._project_pensions
    return datetime.now().year - dob.year if dob else 40


@router.post("/estimate", response_model=PensionEstimate)
async def estimate_from_inputs(
    payload: PensionEstimateRequest,
    current_user: User = Depends(get_current_user),
):
    """Schaetzung aus ungespeicherten Werten (Wizard)."""
    records = [
        {"pillar": "1", "contribution_years": payload.ahv_contribution_years,
         "average_insured_salary": payload.ahv_average_income},
        {"pillar": "2", "current_balance": payload.bvg_balance,
         "annual_contribution": payload.bvg_annual_contribution,
         "expected_return_rate": payload.bvg_return_rate,
         "conversion_rate": payload.bvg_conversion_rate,
         "capital_share": payload.bvg_capital_share},
    ] + [
        {"pillar": "3a", "current_balance": a.balance,
         "annual_contribution": a.annual_contribution, "expected_return_rate": a.return_rate,
         "provider": a.provider, "withdrawal_age": a.withdrawal_age}
        for a in payload.pillar_3a
    ]
    return _service.estimate_at_retirement(
        pension_records=records,
        current_age=payload.current_age,
        retirement_age=payload.retirement_age,
        annual_income=payload.ahv_average_income,
        inflation_rate=payload.inflation_rate if payload.inflation_rate is not None
        else settings.swiss_inflation_rate,
        canton=payload.canton.upper(),
        married=payload.married,
    )


@router.get("/estimate", response_model=PensionEstimate)
async def estimate_from_records(
    retirement_age: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Schaetzung aus den gespeicherten Vorsorgedaten (Finanzplan)."""
    records = (
        await db.execute(select(PensionData).where(PensionData.user_id == current_user.id))
    ).scalars().all()
    payload = [
        {"pillar": r.pillar.value, "current_balance": r.current_balance,
         "annual_contribution": r.annual_contribution,
         "expected_return_rate": r.expected_return_rate,
         "contribution_years": r.contribution_years,
         "average_insured_salary": r.average_insured_salary,
         "conversion_rate": r.conversion_rate,
         "capital_share": r.capital_share,
         "withdrawal_age": r.withdrawal_age,
         "provider": r.provider}
        for r in records
    ]
    canton, married = tax_profile(await _get_wizard_scenario(current_user.id, db))
    ahv = next((r for r in records if r.pillar == PensionPillar.pillar_1), None)
    age = retirement_age or (ahv.retirement_age if ahv else None) or current_user.retirement_age or 65
    return _service.estimate_at_retirement(
        pension_records=payload,
        current_age=_age_from(current_user.date_of_birth),
        retirement_age=age,
        annual_income=(ahv.average_insured_salary if ahv else None) or 0.0,
        inflation_rate=settings.swiss_inflation_rate,
        canton=canton,
        married=married,
    )


@router.get("", response_model=List[PensionResponse])
async def list_pension(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(PensionData).where(PensionData.user_id == current_user.id)
    )
    records = result.scalars().all()
    return [_to_response(r) for r in records]


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
    return _to_response(record)


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
    return _to_response(record)


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
