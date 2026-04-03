"""
Forecasting API — Predictive Budgeting Engine.

POST /api/forecasting/scenario      — generate a forecast (with optional save)
GET  /api/forecasting/scenarios     — list saved forecast scenarios
POST /api/forecasting/scenarios     — save a named scenario
DELETE /api/forecasting/scenarios/{id} — delete a saved scenario
GET  /api/forecasting/analysis      — raw time-series analysis (no forecast)
GET  /api/forecasting/peer-baseline — peer-group CHF defaults for a profile
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.models import ForecastScenario, User
from app.services.prediction_engine import prediction_engine
from app.services.peer_group import (
    PeerGroupProfile,
    get_peer_group_defaults,
    swiss_cantons_list,
)

logger = logging.getLogger(__name__)
router = APIRouter()

# ── Schemas ───────────────────────────────────────────────────

class PeerProfileInput(BaseModel):
    age_group: str = "35-44"
    canton: str = "ZH"
    household_type: str = "single"
    employment_status: str = "employed"
    income_level: str = "medium"


class ForecastRequest(BaseModel):
    account_ids: Optional[List[int]] = None
    horizon_months: int = Field(default=12, ge=1, le=240)
    time_horizon: str = "monthly"          # monthly | yearly | retirement | lifecycle
    include_peer_baseline: bool = True
    peer_profile: Optional[PeerProfileInput] = None
    lookback_months: int = Field(default=24, ge=3, le=60)
    save_as: Optional[str] = None          # if set, save result under this name
    description: Optional[str] = None


class CategoryBreakdownItem(BaseModel):
    predicted: float
    confidence_low: float
    confidence_high: float


class ForecastMonth(BaseModel):
    month: str
    predicted_income: float
    predicted_expense: float
    net: float
    confidence_low: float
    confidence_high: float
    category_breakdown: Dict[str, CategoryBreakdownItem]
    peer_calibrated: bool


class ForecastResponse(BaseModel):
    months: List[str]
    forecast: List[ForecastMonth]
    data_months: int
    first_date: Optional[str]
    last_date: Optional[str]
    total_monthly_income_mean: float
    total_monthly_expense_mean: float
    scenario_id: Optional[int] = None


class ScenarioCreate(BaseModel):
    name: str
    description: Optional[str] = None
    parameters: Dict[str, Any]


class ScenarioResponse(BaseModel):
    id: int
    name: str
    description: Optional[str]
    parameters: Dict[str, Any]
    created_at: datetime
    updated_at: datetime


# ── Routes ────────────────────────────────────────────────────

@router.post("/scenario", response_model=ForecastResponse)
async def generate_forecast(
    req: ForecastRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Generate a predictive budget forecast.

    Combines historical transaction time-series with peer-group calibration.
    Set `save_as` to persist the result as a named scenario.
    """
    peer_dict = req.peer_profile.model_dump() if req.peer_profile else None

    try:
        result = await prediction_engine.generate_forecast(
            db=db,
            user_id=current_user.id,
            horizon_months=req.horizon_months,
            account_ids=req.account_ids,
            lookback_months=req.lookback_months,
            peer_profile=peer_dict,
            include_peer_baseline=req.include_peer_baseline,
        )
    except Exception as exc:
        logger.error("Forecast generation failed for user=%d: %s", current_user.id, exc)
        raise HTTPException(status_code=500, detail=f"Forecast error: {exc}") from exc

    analysis = result["analysis"]
    scenario_id: Optional[int] = None

    # Optionally save the scenario
    if req.save_as:
        scenario = ForecastScenario(
            user_id=current_user.id,
            name=req.save_as,
            description=req.description,
            parameters={
                "horizon_months": req.horizon_months,
                "time_horizon": req.time_horizon,
                "include_peer_baseline": req.include_peer_baseline,
                "peer_profile": peer_dict,
                "lookback_months": req.lookback_months,
                "account_ids": req.account_ids,
            },
            result_json={
                "months": result["months"],
                "forecast": result["forecast"],
                "analysis": {
                    "data_months": analysis["data_months"],
                    "first_date": analysis["first_date"],
                    "last_date": analysis["last_date"],
                    "total_monthly_income_mean": analysis["total_monthly_income_mean"],
                    "total_monthly_expense_mean": analysis["total_monthly_expense_mean"],
                },
            },
            expires_at=datetime.now(timezone.utc) + timedelta(hours=24),
        )
        db.add(scenario)
        await db.flush()
        await db.refresh(scenario)
        scenario_id = scenario.id

    # Build response
    forecast_months = [
        ForecastMonth(
            month=row["month"],
            predicted_income=row["predicted_income"],
            predicted_expense=row["predicted_expense"],
            net=row["net"],
            confidence_low=row["confidence_low"],
            confidence_high=row["confidence_high"],
            category_breakdown={
                cat: CategoryBreakdownItem(**vals)
                for cat, vals in row["category_breakdown"].items()
            },
            peer_calibrated=row["peer_calibrated"],
        )
        for row in result["forecast"]
    ]

    return ForecastResponse(
        months=result["months"],
        forecast=forecast_months,
        data_months=analysis["data_months"],
        first_date=analysis["first_date"],
        last_date=analysis["last_date"],
        total_monthly_income_mean=analysis["total_monthly_income_mean"],
        total_monthly_expense_mean=analysis["total_monthly_expense_mean"],
        scenario_id=scenario_id,
    )


@router.get("/analysis")
async def get_analysis(
    account_ids: Optional[str] = Query(None, description="Comma-separated account IDs"),
    lookback_months: int = Query(24, ge=3, le=60),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return raw statistical analysis of historical transactions."""
    ids = [int(i) for i in account_ids.split(",") if i.strip()] if account_ids else None
    try:
        analysis = await prediction_engine.analyze(
            db=db,
            user_id=current_user.id,
            account_ids=ids,
            lookback_months=lookback_months,
        )
    except Exception as exc:
        logger.error("Analysis failed for user=%d: %s", current_user.id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return analysis


@router.get("/peer-baseline")
async def get_peer_baseline(
    age_group: str = Query("35-44"),
    canton: str = Query("ZH"),
    household_type: str = Query("single"),
    employment_status: str = Query("employed"),
    income_level: str = Query("medium"),
    current_user: User = Depends(get_current_user),
):
    """Return peer-group monthly expense defaults (CHF) for the given profile."""
    try:
        profile = PeerGroupProfile(
            age_group=age_group,        # type: ignore[arg-type]
            canton=canton,
            household_type=household_type,  # type: ignore[arg-type]
            employment_status=employment_status,  # type: ignore[arg-type]
            income_level=income_level,  # type: ignore[arg-type]
        )
        defaults = get_peer_group_defaults(profile)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid profile: {exc}") from exc
    return {"profile": profile.__dict__, "defaults": defaults, "cantons": swiss_cantons_list()}


@router.get("/scenarios", response_model=List[ScenarioResponse])
async def list_scenarios(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all saved forecast scenarios for the current user."""
    result = await db.execute(
        select(ForecastScenario)
        .where(ForecastScenario.user_id == current_user.id)
        .order_by(desc(ForecastScenario.created_at))
        .limit(50)
    )
    scenarios = result.scalars().all()
    return [
        ScenarioResponse(
            id=s.id,
            name=s.name,
            description=s.description,
            parameters=s.parameters or {},
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
    """Save a named forecast scenario."""
    scenario = ForecastScenario(
        user_id=current_user.id,
        name=payload.name,
        description=payload.description,
        parameters=payload.parameters,
        expires_at=datetime.now(timezone.utc) + timedelta(days=365),
    )
    db.add(scenario)
    await db.flush()
    await db.refresh(scenario)
    return ScenarioResponse(
        id=scenario.id,
        name=scenario.name,
        description=scenario.description,
        parameters=scenario.parameters or {},
        created_at=scenario.created_at,
        updated_at=scenario.updated_at,
    )


@router.delete("/scenarios/{scenario_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_scenario(
    scenario_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a saved forecast scenario."""
    result = await db.execute(
        select(ForecastScenario).where(
            ForecastScenario.id == scenario_id,
            ForecastScenario.user_id == current_user.id,
        )
    )
    scenario = result.scalar_one_or_none()
    if not scenario:
        raise HTTPException(status_code=404, detail="Scenario not found.")
    await db.delete(scenario)
