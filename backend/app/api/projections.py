"""
Projections API routes — Monte Carlo simulations and pension projections.

POST /projections/run                 — run a Monte Carlo + pension projection
GET  /projections/scenarios           — list saved scenarios
POST /projections/scenarios           — save a new scenario
PUT  /projections/scenarios/{id}      — update scenario
DELETE /projections/scenarios/{id}    — delete scenario
"""
import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.config import settings
from app.models.models import Scenario, PensionData, User, UserWizardConfig
from app.api.budget_multimodal import _get_wizard_scenario
from app.api.pension import record_dict
from app.services.capital_tax import tax_profile
from app.services.projection import (
    AMORTIZATION_YEARS_DEFAULT,
    CARE_COST_ANNUAL_DEFAULT,
    ProjectionService,
    _current_age,
    build_annual_flows,
    default_retirement_spending,
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
    retirement_age: int = Field(default=65, ge=50, le=75)
    # Jaehrliche Lebenskosten im Ruhestand in heutigen CHF. Ohne Angabe: aus
    # dem Szenario (Ausgaben x Lebensstilfaktor), sonst geschaetzt.
    retirement_spending: Optional[float] = Field(default=None, ge=0)
    # Steuer auf Kapitalbezuege: ohne Angabe aus dem Wizard-Szenario (Kanton,
    # Haushalt), sonst Zuerich / alleinstehend
    canton: Optional[str] = Field(default=None, min_length=2, max_length=2)
    married: Optional[bool] = None


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
    # Säule 3b / Lebensversicherung: Kapital bis zum Ablauf, danach 0
    pension_3b: List[float] = []
    # Jaehrliches Renteneinkommen (AHV, BVG-Renten inkl. Teilrenten), real
    pension_income: List[float] = []
    # Pensionskasse getrennt: Guthaben bis zum Endbezug (danach 0) und Rente
    capital_bvg: List[float] = []
    income_bvg: List[float] = []
    # Gleichmaessiger Kapitalverzehr pro Jahr bis drawdown_until_age (real)
    capital_drawdown: List[float] = []
    drawdown_until_age: Optional[int] = None
    # Index, ab dem AHV ("1") und Pensionskasse ("2", Endbezug) eine Rente zahlen
    payout_start_idx: Dict[str, int] = {}
    retirement_spending: Optional[float] = None
    # Einkommens- und Vermoegenssteuer im Ruhestand entlang des Medians, real
    retirement_tax: List[float] = []
    # Alter, ab dem das Vermoegen im Median aufgebraucht ist (None = reicht)
    depletion_age: Optional[int] = None
    # Anteil der Simulationen mit Vermoegen am Ende des Horizonts
    success_rate: Optional[float] = None
    # Kapitalbezuege (Pensionskasse, 3a, 3b): Alter, Jahr, Betrag, Steuer — real
    capital_withdrawals: List[Dict[str, Any]] = []
    capital_tax_total: float = 0.0
    # Steuer, wenn alles im selben Jahr bezogen wuerde (Vergleich zur Staffelung)
    capital_tax_single_year: float = 0.0
    # run() liefert das seit jeher, das Schema hat es verschluckt — das
    # Frontend (RetirementPlanner.tsx:75) las darum immer undefined.
    retirement_idx: Optional[int] = None
    inflation_adjusted: bool
    computed_at: str
    runs: int


class BvgVariant(BaseModel):
    """Eine Variante des Pensionskassen-Bezugs, heutige CHF."""
    key: str                  # "pension" | "capital" | "own"
    bvg_monthly: float        # Pensionskassen-Rente ab dem Endbezug
    capital_net: float        # BVG-Kapital nach Steuer
    p50: List[float]          # freies Vermoegen, Median
    p10: List[float]          # freies Vermoegen, schlechte Maerkte
    depletion_age: Optional[int] = None
    success_rate: float
    wealth_85: Optional[float] = None
    wealth_90: Optional[float] = None
    wealth_85_p10: Optional[float] = None
    taxes_total: float        # Kapitalsteuer + Steuern im Ruhestand (Median)


class BvgComparison(BaseModel):
    years: List[int] = []
    current_age: Optional[int] = None
    retirement_age: Optional[int] = None
    variants: List[BvgVariant]
    # Ab diesem Alter hinterlaesst die Rente im Median mehr freies Vermoegen
    breakeven_age: Optional[int] = None


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
        # Gespart wird nur bis zum Rentenalter (siehe ProjectionService.run).
        increase_pct = float(p.get("savings_increase_pct") or 0.0)
        if increase_pct:
            annual_savings *= 1 + increase_pct / 100
        out["annual_savings"] = annual_savings

    # Bruttolohn, nicht monthly_income — das ist netto (wizard.py rechnet x0.72).
    if p.get("ahv_avg_lohn") is not None:
        out["annual_income"] = float(p["ahv_avg_lohn"])

    return out


def _flow_inputs(parameters_json: Dict[str, Any], monthly_taxes: float = 0.0) -> Dict[str, Any]:
    """Rohwerte fuer `build_annual_flows` — getrennt von den run()-Argumenten,
    weil sie nicht direkt an die Simulation gehen.

    Die Ausgaben des Wizards enthalten den Posten "Direkte Steuern" des
    Erwerbslebens. Im Ruhestand rechnet die Prognose die Steuern selbst
    (retirement_tax) — darum ohne diesen Posten (`monthly_taxes` im Szenario,
    sonst der Wert aus dem Wizard).
    """
    p = parameters_json or {}
    monthly_expenses = p.get("monthly_expenses_base", p.get("monthly_expenses")) or 0.0
    taxes = p.get("monthly_taxes", monthly_taxes) or 0.0
    return {
        "active_scenarios": p.get("active_scenarios") or [],
        "annual_expenses": max(0.0, float(monthly_expenses) - float(taxes)) * 12,
        "lifestyle_factor": float(p.get("lifestyle_factor") or 0.8),
        "care_cost_annual": float(p.get("care_cost_annual") or CARE_COST_ANNUAL_DEFAULT),
        "mortgage_debt": float(p.get("mortgage_debt") or 0.0),
        "mortgage_rate_pct": float(p.get("mortgage_rate_pct") or 0.0),
        "amortization_years": int(p.get("amortization_years") or AMORTIZATION_YEARS_DEFAULT),
        "early_retirement_years": int(p.get("early_retirement_years") or 3),
    }


# ── Routes ────────────────────────────────────────────────────

async def _wizard_monthly_taxes(user_id: int, db: AsyncSession) -> float:
    """Posten "Direkte Steuern" aus dem gespeicherten Wizard (monatlich)."""
    row = (await db.execute(
        select(UserWizardConfig.wizard_data_json).where(UserWizardConfig.user_id == user_id)
    )).scalar_one_or_none()
    try:
        data = json.loads(row) if row else {}
    except ValueError:
        data = {}
    return float(data.get("direkteSteuern", data.get("direkte_steuern")) or 0.0)


async def _run_kwargs(
    params: ProjectionParameters,
    scenario_id: Optional[int],
    current_user: User,
    db: AsyncSession,
    until_age: Optional[int] = None,
) -> Dict[str, Any]:
    """Argumente fuer ProjectionService.run() aus Szenario und Anfrage.
    `until_age` rechnet bis zu diesem Alter statt ueber den Horizont der
    Anfrage (Vergleich Rente/Kapital)."""
    # Szenario laden und mit dem Body zusammenfuehren. `exclude_unset` sorgt
    # dafuer, dass nur ausdruecklich gesendete Felder das Szenario uebersteuern
    # — Pydantic-Defaults duerfen es nicht ueberschreiben.
    merged: Dict[str, Any] = {}
    flow_inputs: Dict[str, Any] = {}
    scenario_params: Optional[Dict[str, Any]] = None
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
        flow_inputs = _flow_inputs(
            scenario.parameters_json, await _wizard_monthly_taxes(current_user.id, db)
        )
        scenario_params = scenario.parameters_json
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
    if until_age:
        years_to_project = max(1, until_age - _current_age(date_of_birth))

    pension_payload = [record_dict(r) for r in pension_records]

    # Fruehpensionierung = dieselbe Rechnung mit frueherem Rentenalter: Sparen
    # endet frueher, Renten fallen kleiner aus und beginnen teils spaeter, die
    # Luecke bis dahin traegt das Vermoegen. Das Alter gilt auch fuer die
    # angezeigten Renten.
    planned_retirement = merged.get("retirement_age", 65)
    early_years = flow_inputs.pop("early_retirement_years", 3)
    active_scenarios = flow_inputs.get("active_scenarios", [])
    retirement = (
        planned_retirement - early_years
        if "early_retirement" in active_scenarios
        else planned_retirement
    )

    # Lebenskosten im Ruhestand: ausdruecklich gesendet > Szenario > Schaetzung
    annual_expenses = flow_inputs.pop("annual_expenses", 0.0)
    lifestyle_factor = flow_inputs.pop("lifestyle_factor", 0.8)
    retirement_spending = merged.get("retirement_spending")
    if retirement_spending is None and annual_expenses > 0:
        retirement_spending = annual_expenses * lifestyle_factor
    if retirement_spending is None:
        retirement_spending = default_retirement_spending(
            merged["annual_income"], merged["annual_savings"]
        )

    # Szenario-Cashflows (Pflegekosten, Amortisation)
    inflation = merged.get("inflation_rate", 0.015)
    annual_flows = None
    if {"care_costs_at_80", "mortgage_amortization"} & set(active_scenarios):
        annual_flows = build_annual_flows(
            years=years_to_project,
            current_age=_current_age(date_of_birth),
            retirement_age=retirement,
            retirement_spending=retirement_spending,
            inflation_rate=inflation,
            **flow_inputs,
        )

    # Steuer auf Kapitalbezuege: Anfrage > gewaehltes Szenario > letzter
    # Wizard > Vorgabe (Zuerich, alleinstehend)
    if not (scenario_params or {}).get("kanton"):
        scenario_params = await _get_wizard_scenario(current_user.id, db)
    canton, married = tax_profile(scenario_params)
    canton = (merged.get("canton") or canton).upper()
    if merged.get("married") is not None:
        married = bool(merged["married"])

    return dict(
        current_net_worth=merged["current_net_worth"],
        annual_savings=merged["annual_savings"],
        annual_income=merged["annual_income"],
        years=years_to_project,
        mean_return=merged.get("mean_return", 0.07),
        volatility=merged.get("return_volatility", 0.12),
        inflation_rate=inflation,
        pension_records=pension_payload,
        date_of_birth=date_of_birth,
        retirement_age=retirement,
        runs=settings.monte_carlo_runs,
        annual_flows=annual_flows,
        retirement_spending=retirement_spending,
        canton=canton,
        married=married,
        drawdown_until_age=int(merged.get("life_expectancy") or 90),
    )


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
    kwargs = await _run_kwargs(params, scenario_id, current_user, db)
    result_dict = projection_service.run(**kwargs)
    result_dict["computed_at"] = datetime.now(timezone.utc).isoformat()
    result_dict["runs"] = settings.monte_carlo_runs

    return ProjectionResult(**result_dict)


#: Der Vergleich Rente/Kapital rechnet bis 95 — Langlebigkeit ist das Risiko
#: des Kapitalbezugs.
COMPARISON_END_AGE = 95


@router.post("/compare-bvg", response_model=BvgComparison)
async def compare_bvg(
    params: ProjectionParameters,
    scenario_id: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Pensionskasse als Rente oder als Kapital: dieselbe Prognose dreimal,
    mit denselben Maerkten (siehe ProjectionService.compare_bvg_options)."""
    kwargs = await _run_kwargs(params, scenario_id, current_user, db, until_age=COMPARISON_END_AGE)
    return projection_service.compare_bvg_options(**kwargs)


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
