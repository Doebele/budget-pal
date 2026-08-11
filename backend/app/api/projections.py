"""
Projections API routes — Monte Carlo simulations and pension projections.

POST /projections/run                 — run a Monte Carlo + pension projection
GET  /projections/scenarios           — list saved scenarios
POST /projections/scenarios           — save a new scenario
PUT  /projections/scenarios/{id}      — update scenario
DELETE /projections/scenarios/{id}    — delete scenario
"""
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.config import settings
from app.models.models import Scenario, PensionData, User
from app.services.projection import (
    AMORTIZATION_YEARS_DEFAULT,
    CARE_COST_ANNUAL_DEFAULT,
    ProjectionService,
    build_annual_flows,
)

router = APIRouter()
projection_service = ProjectionService()


# ── Schemas ───────────────────────────────────────────────────

class ProjectionParameters(BaseModel):
    # Optional, damit ein gewaehltes Szenario sie liefern kann. Nach dem Merge
    # wird geprueft, dass alle drei gesetzt sind (siehe run_projection).
    current_net_worth: Optional[float] = None
    annual_savings: Optional[float] = None
    annual_income: Optional[float] = None
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
    # run() liefert das seit jeher, das Schema hat es verschluckt — das
    # Frontend (RetirementPlanner.tsx:75) las darum immer undefined.
    retirement_idx: Optional[int] = None
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


# ── Szenario → Simulationsparameter ───────────────────────────

def _params_from_scenario(parameters_json: Dict[str, Any]) -> Dict[str, Any]:
    """Bildet die Wizard-Werte aus `Scenario.parameters_json` auf die
    Argumente von `ProjectionService.run()` ab.

    Nur Schluessel, die tatsaechlich vorhanden sind, landen im Ergebnis —
    fehlende ueberlaesst der Aufrufer dem Request-Body bzw. den Defaults.
    """
    p = parameters_json or {}
    out: Dict[str, Any] = {}

    if p.get("inflation_rate") is not None:
        # wizard.py teilt bereits durch 100, der Wert ist ein Bruchteil.
        out["inflation_rate"] = float(p["inflation_rate"])
    if p.get("retirement_age") is not None:
        out["retirement_age"] = int(p["retirement_age"])
    if p.get("life_expectancy") is not None:
        out["life_expectancy"] = int(p["life_expectancy"])

    # Sparrate aus dem monatlichen Ueberschuss des Wizards.
    income = p.get("monthly_income")
    expenses = p.get("monthly_expenses")
    if income is not None and expenses is not None:
        annual_savings = max(0.0, float(income) - float(expenses)) * 12
        # Szenario "Sparplan erhoehen": schlaegt einen Prozentsatz auf.
        # ponytail: die heutige Jahresschleife in projection.py kennt kein
        # Alters-Gate — die Sparrate fliesst auch nach dem Rentenalter weiter.
        # Fuer Horizonte bis zum Rentenalter unerheblich, darueber hinaus nicht.
        # Wird mit der Entnahmephase (annual_flows) fuer alle Szenarien behoben.
        increase_pct = float(p.get("savings_increase_pct") or 0.0)
        if increase_pct:
            annual_savings *= 1 + increase_pct / 100
        out["annual_savings"] = annual_savings

    # Bruttolohn, nicht monthly_income — das ist netto (wizard.py rechnet x0.72).
    if p.get("ahv_avg_lohn") is not None:
        out["annual_income"] = float(p["ahv_avg_lohn"])

    return out


def _flow_inputs(parameters_json: Dict[str, Any]) -> Dict[str, Any]:
    """Rohwerte fuer `build_annual_flows` — getrennt von den run()-Argumenten,
    weil sie nicht direkt an die Simulation gehen."""
    p = parameters_json or {}
    monthly_expenses = p.get("monthly_expenses_base", p.get("monthly_expenses")) or 0.0
    return {
        "active_scenarios": p.get("active_scenarios") or [],
        "annual_expenses": float(monthly_expenses) * 12,
        "lifestyle_factor": float(p.get("lifestyle_factor") or 0.8),
        "care_cost_annual": float(p.get("care_cost_annual") or CARE_COST_ANNUAL_DEFAULT),
        "mortgage_debt": float(p.get("mortgage_debt") or 0.0),
        "mortgage_rate_pct": float(p.get("mortgage_rate_pct") or 0.0),
        "amortization_years": int(p.get("amortization_years") or AMORTIZATION_YEARS_DEFAULT),
        "early_retirement_years": int(p.get("early_retirement_years") or 3),
    }


# ── Routes ────────────────────────────────────────────────────

@router.post("/run", response_model=ProjectionResult)
async def run_projection(
    params: ProjectionParameters,
    scenario_id: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Run Monte Carlo simulation and Swiss pension projection.

    Kein Ergebnis-Cache: der frühere Cache war auf (user_id, scenario_id)
    geschlüsselt und ignorierte die Body-Parameter komplett. Jeder Reglerzug
    hätte danach 24 Stunden lang dieselbe Kurve geliefert. 10'000 Läufe
    rechnet NumPy in Millisekunden — ein Cache lohnt den Invalidierungsaufwand
    nicht. Tabelle und Modell ProjectionCache bleiben für Altdaten bestehen.
    """
    # Szenario laden und mit dem Body zusammenfuehren. `exclude_unset` sorgt
    # dafuer, dass nur ausdruecklich gesendete Felder das Szenario uebersteuern
    # — Pydantic-Defaults duerfen es nicht ueberschreiben.
    merged: Dict[str, Any] = {}
    flow_inputs: Dict[str, Any] = {}
    if scenario_id:
        scenario_row = await db.execute(
            select(Scenario).where(
                Scenario.id == scenario_id,
                Scenario.user_id == current_user.id,
            )
        )
        scenario = scenario_row.scalar_one_or_none()
        if not scenario:
            raise HTTPException(status_code=404, detail="Scenario not found.")
        merged.update(_params_from_scenario(scenario.parameters_json))
        flow_inputs = _flow_inputs(scenario.parameters_json)
    merged.update(params.model_dump(exclude_unset=True))

    # Pflichtwerte pruefen — die Validierung an der Vertrauensgrenze bleibt,
    # sie wandert nur hinter den Merge.
    missing = [
        f for f in ("current_net_worth", "annual_savings", "annual_income")
        if merged.get(f) is None
    ]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Missing required parameters: {', '.join(missing)}",
        )

    # Fetch pension data for this user
    pension_result = await db.execute(
        select(PensionData).where(PensionData.user_id == current_user.id)
    )
    pension_records = pension_result.scalars().all()

    # Determine projection horizon
    date_of_birth = merged.get("date_of_birth")
    years_to_project = merged.get("years_to_project")
    if not years_to_project and merged.get("target_age") and date_of_birth:
        dob = datetime.fromisoformat(date_of_birth)
        current_age = (datetime.now() - dob).days / 365.25
        years_to_project = max(1, int(merged["target_age"] - current_age))
    if not years_to_project and merged.get("life_expectancy") and date_of_birth:
        dob = datetime.fromisoformat(date_of_birth)
        current_age = (datetime.now() - dob).days / 365.25
        years_to_project = max(1, int(merged["life_expectancy"] - current_age))
    years_to_project = years_to_project or 30

    pension_payload = [
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
    ]

    # Szenario-Cashflows (Fruehpensionierung, Pflegekosten, Amortisation).
    # Ohne aktive Szenarien bleibt annual_flows None und der Simulationspfad
    # ist bit-identisch zum Verhalten ohne Szenario.
    annual_flows = None
    if flow_inputs.get("active_scenarios"):
        current_age = 40
        if date_of_birth:
            try:
                current_age = datetime.now().year - datetime.fromisoformat(date_of_birth).year
            except ValueError:
                pass
        inflation = merged.get("inflation_rate", 0.015)
        planned_retirement = merged.get("retirement_age", 65)
        early_years = flow_inputs.pop("early_retirement_years", 3)
        # Frueher in Rente heisst: weniger Beitragsjahre, also auch weniger
        # Rente. Deshalb geht das vorgezogene Alter in BEIDE Rechnungen.
        retirement = (
            planned_retirement - early_years
            if "early_retirement" in flow_inputs["active_scenarios"]
            else planned_retirement
        )
        # Rentenserie vorab, damit die Entnahmephase die Rente als Einkommen
        # gegenrechnen kann. Rein rechnerisch, kein Monte Carlo.
        pension_series = projection_service.project_pension_series(
            pension_records=pension_payload,
            years=years_to_project,
            annual_income=merged["annual_income"],
            date_of_birth=date_of_birth,
            retirement_age=retirement,
            inflation_rate=inflation,
        )
        annual_flows = build_annual_flows(
            years=years_to_project,
            current_age=current_age,
            retirement_age=retirement,
            annual_savings=merged["annual_savings"],
            pension_series=pension_series,
            inflation_rate=inflation,
            planned_retirement_age=planned_retirement,
            **flow_inputs,
        )

    # Run simulation
    result_data = projection_service.run(
        current_net_worth=merged["current_net_worth"],
        annual_savings=merged["annual_savings"],
        annual_income=merged["annual_income"],
        years=years_to_project,
        mean_return=merged.get("mean_return", 0.07),
        volatility=merged.get("return_volatility", 0.12),
        inflation_rate=merged.get("inflation_rate", 0.015),
        pension_records=pension_payload,
        date_of_birth=date_of_birth,
        retirement_age=merged.get("retirement_age", 65),
        runs=settings.monte_carlo_runs,
        annual_flows=annual_flows,
    )

    result_dict = result_data.copy()
    result_dict["computed_at"] = datetime.now(timezone.utc).isoformat()
    result_dict["runs"] = settings.monte_carlo_runs

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
    await db.commit()

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
    await db.commit()

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
    # get_db committet nicht — ohne diese Zeile war das Loeschen wirkungslos.
    await db.commit()
