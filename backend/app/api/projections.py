"""
Projections API routes — Monte Carlo simulations and pension projections.

POST /projections/run                 — run a Monte Carlo + pension projection
GET  /projections/scenarios           — list saved scenarios
POST /projections/scenarios           — save a new scenario
PUT  /projections/scenarios/{id}      — update scenario
DELETE /projections/scenarios/{id}    — delete scenario
"""
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.config import settings
from app.models.models import Scenario, ProjectionCache, PensionData, Asset, User
from app.services.projection import ProjectionService

router = APIRouter()
projection_service = ProjectionService()


# ── Schemas ───────────────────────────────────────────────────

class ProjectionParameters(BaseModel):
    current_net_worth: float
    annual_savings: float
    annual_income: float
    years_to_project: Optional[int] = None
    target_age: Optional[int] = None
    mean_return: float = 0.07
    return_volatility: float = 0.12
    inflation_rate: float = 0.015
    include_pension: bool = True
    date_of_birth: Optional[str] = None  # ISO format: YYYY-MM-DD
    retirement_age: int = 65


class ProjectionResult(BaseModel):
    years: List[int]
    p10: List[float]
    p25: List[float]
    p50: List[float]
    p75: List[float]
    p90: List[float]
    pension_ahv: List[float]
    pension_bvg: List[float]
    pension_3a: List[float]
    pension_3b: List[float] = []   # Säule 3b / Lebensversicherung (optional — zero for old cached results)
    inflation_adjusted: bool
    computed_at: str
    runs: int


class ScenarioCreate(BaseModel):
    name: str
    description: Optional[str] = None
    parameters: Dict[str, Any]
    is_default: bool = False


class ScenarioResponse(BaseModel):
    id: int
    name: str
    description: Optional[str]
    parameters: Dict[str, Any]
    is_default: bool
    created_at: datetime
    updated_at: datetime


class ScenarioUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    parameters: Optional[Dict[str, Any]] = None
    is_default: Optional[bool] = None


# ── Routes ────────────────────────────────────────────────────

@router.post("/run", response_model=ProjectionResult)
async def run_projection(
    params: ProjectionParameters,
    scenario_id: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run Monte Carlo simulation and Swiss pension projection.

    Results are cached for 24h keyed by user_id + scenario_id (if provided).
    """
    # Check cache first
    if scenario_id:
        now = datetime.now(timezone.utc)
        cache_result = await db.execute(
            select(ProjectionCache).where(
                ProjectionCache.user_id == current_user.id,
                ProjectionCache.scenario_id == scenario_id,
                ProjectionCache.expires_at > now,
            )
        )
        cached = cache_result.scalar_one_or_none()
        if cached:
            result = cached.result_json
            return ProjectionResult(**result)

    # Fetch pension data for this user
    pension_result = await db.execute(
        select(PensionData).where(PensionData.user_id == current_user.id)
    )
    pension_records = pension_result.scalars().all()

    # Determine projection horizon
    years_to_project = params.years_to_project
    if not years_to_project and params.target_age and params.date_of_birth:
        dob = datetime.fromisoformat(params.date_of_birth)
        current_age = (datetime.now() - dob).days / 365.25
        years_to_project = max(1, int(params.target_age - current_age))
    years_to_project = years_to_project or 30

    # Run simulation
    result_data = projection_service.run(
        current_net_worth=params.current_net_worth,
        annual_savings=params.annual_savings,
        annual_income=params.annual_income,
        years=years_to_project,
        mean_return=params.mean_return,
        volatility=params.return_volatility,
        inflation_rate=params.inflation_rate,
        pension_records=[
            {
                "pillar": r.pillar.value,
                "current_balance": r.current_balance,
                "annual_contribution": r.annual_contribution,
                "expected_return_rate": r.expected_return_rate,
                "retirement_age": r.retirement_age,
                "contribution_years": r.contribution_years,
                "average_insured_salary": r.average_insured_salary,
            }
            for r in pension_records
        ],
        date_of_birth=params.date_of_birth,
        retirement_age=params.retirement_age,
        runs=settings.monte_carlo_runs,
    )

    result_dict = result_data.copy()
    result_dict["computed_at"] = datetime.now(timezone.utc).isoformat()
    result_dict["runs"] = settings.monte_carlo_runs

    # Cache result if scenario_id provided
    if scenario_id:
        cache_entry = ProjectionCache(
            user_id=current_user.id,
            scenario_id=scenario_id,
            result_json=result_dict,
            expires_at=datetime.now(timezone.utc) + timedelta(seconds=settings.projection_cache_ttl),
        )
        db.add(cache_entry)
        await db.flush()

    return ProjectionResult(**result_dict)


@router.get("/scenarios", response_model=List[ScenarioResponse])
async def list_scenarios(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all saved projection scenarios for the current user."""
    result = await db.execute(
        select(Scenario)
        .where(Scenario.user_id == current_user.id)
        .order_by(desc(Scenario.updated_at))
    )
    scenarios = result.scalars().all()
    return [
        ScenarioResponse(
            id=s.id,
            name=s.name,
            description=s.description,
            parameters=s.parameters_json,
            is_default=s.is_default,
            created_at=s.created_at,
            updated_at=s.updated_at,
        )
        for s in scenarios
    ]


@router.post("/scenarios", response_model=ScenarioResponse, status_code=status.HTTP_201_CREATED)
async def create_scenario(
    payload: ScenarioCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Save a new projection scenario."""
    # If marked as default, unset others
    if payload.is_default:
        existing_defaults = await db.execute(
            select(Scenario).where(
                Scenario.user_id == current_user.id,
                Scenario.is_default == True,
            )
        )
        for s in existing_defaults.scalars().all():
            s.is_default = False

    scenario = Scenario(
        user_id=current_user.id,
        name=payload.name,
        description=payload.description,
        parameters_json=payload.parameters,
        is_default=payload.is_default,
    )
    db.add(scenario)
    await db.flush()
    await db.refresh(scenario)

    return ScenarioResponse(
        id=scenario.id,
        name=scenario.name,
        description=scenario.description,
        parameters=scenario.parameters_json,
        is_default=scenario.is_default,
        created_at=scenario.created_at,
        updated_at=scenario.updated_at,
    )


@router.put("/scenarios/{scenario_id}", response_model=ScenarioResponse)
async def update_scenario(
    scenario_id: int,
    payload: ScenarioUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update a saved scenario."""
    result = await db.execute(
        select(Scenario).where(
            Scenario.id == scenario_id,
            Scenario.user_id == current_user.id,
        )
    )
    scenario = result.scalar_one_or_none()
    if not scenario:
        raise HTTPException(status_code=404, detail="Scenario not found.")

    if payload.name is not None:
        scenario.name = payload.name
    if payload.description is not None:
        scenario.description = payload.description
    if payload.parameters is not None:
        scenario.parameters_json = payload.parameters
    if payload.is_default is not None:
        if payload.is_default:
            existing = await db.execute(
                select(Scenario).where(
                    Scenario.user_id == current_user.id,
                    Scenario.is_default == True,
                    Scenario.id != scenario_id,
                )
            )
            for s in existing.scalars().all():
                s.is_default = False
        scenario.is_default = payload.is_default

    await db.flush()
    await db.refresh(scenario)

    return ScenarioResponse(
        id=scenario.id,
        name=scenario.name,
        description=scenario.description,
        parameters=scenario.parameters_json,
        is_default=scenario.is_default,
        created_at=scenario.created_at,
        updated_at=scenario.updated_at,
    )


@router.delete("/scenarios/{scenario_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_scenario(
    scenario_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a saved scenario and its cached results."""
    result = await db.execute(
        select(Scenario).where(
            Scenario.id == scenario_id,
            Scenario.user_id == current_user.id,
        )
    )
    scenario = result.scalar_one_or_none()
    if not scenario:
        raise HTTPException(status_code=404, detail="Scenario not found.")
    await db.delete(scenario)
