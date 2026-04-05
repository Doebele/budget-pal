"""
Wizard API — onboarding endpoint that bootstraps a full user financial profile
from the 8-step wizard in one transactional POST.

POST /wizard/complete
  Accepts: WizardCompletePayload (all wizard form data)
  Creates:
    - Savings account + budget entries from entered expenses
    - Income budget entries
    - Pension entries (Pillar 1 / 2 / 3a)
    - Asset entries
    - Initial projection scenario
  Returns: WizardCompleteResponse with summary and redirect hint
"""

from __future__ import annotations

import json
from datetime import datetime, timezone, date
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.models import (
    Account,
    AccountType,
    Asset,
    AssetType,
    Budget,
    BudgetPeriod,
    PensionData,
    PensionPillar,
    Scenario,
    User,
    UserWizardConfig,
)

router = APIRouter()


# ── Peer group (BFS-style reference — mirrors peerGroupAnalyzer.ts) ──


class PeerGroupProfileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ageGroup: Literal["25-34", "35-44", "45-54", "55-64", "65+"]
    canton: str
    householdType: Literal["single", "couple", "family", "single-parent"]
    employmentStatus: Literal["employed", "self-employed", "mixed", "retired"]
    incomeLevel: Literal["low", "medium", "high"]


# ── Pydantic Schemas ───────────────────────────────────────────

class Pillar3aAccountPayload(BaseModel):
    provider: str = ""
    balance: float = 0.0
    annual_contribution: float = 7_056.0
    strategy: Literal["interest", "funds"] = "funds"


class WizardCompletePayload(BaseModel):
    """Full wizard data — mirrors the WizardData TypeScript interface.

    The frontend sends camelCase (e.g. housingMode, monthlyRent). We accept both
    camelCase (via alias_generator) and snake_case (populate_by_name=True).
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,  # also accept snake_case directly
    )

    # ── Step 1: Demographics
    vorname: str = ""
    geburtsjahr: int = Field(default=1985, ge=1930, le=2010)
    kanton: str = "ZH"
    haushalt: Literal["single", "couple", "family", "single-parent"] = "single"
    beschaeftigung: Literal["employed", "self-employed", "mixed", "retired"] = "employed"

    # ── Step 2: Income sources
    lohn: float = 0.0
    lohn_enabled: bool = True
    selbstaendig: float = 0.0
    selbstaendig_enabled: bool = False
    dividenden: float = 0.0
    dividenden_enabled: bool = False
    mieteinnahmen: float = 0.0
    mieteinnahmen_enabled: bool = False
    auslandeinkommen: float = 0.0
    auslandeinkommen_enabled: bool = False
    ahv_rente: float = 0.0
    ahv_rente_enabled: bool = False
    estimated_netto_monthly: float = 0.0

    # ── Step 3: Peer group (optional; user-adjusted BFS defaults)
    peer_group_defaults: Optional[Dict[str, Any]] = None

    # ── Step 4: Housing
    housing_mode: Literal["miete", "hypothek"] = "miete"
    monthly_rent: float = 1_500.0
    nebenkosten: float = 200.0
    property_value: float = 0.0
    outstanding_debt: float = 0.0
    monthly_amortization: float = 0.0
    health_insurance_per_person: float = 420.0
    franchise: Literal[300, 500, 1000, 1500, 2000, 2500] = 300
    zusatzversicherung: float = 0.0
    hausrat: float = 70.0
    autoversicherung: float = 0.0
    has_auto_insurance: bool = False

    # ── Step 5: Daily life
    groceries: float = 500.0
    transport_mode: Literal["ov", "car", "both"] = "ov"
    has_sbb_halbtax: bool = False
    has_sbb_ga: bool = False
    monthly_fuel: float = 0.0
    parking: float = 0.0
    car_amortization: float = 0.0
    selected_subscriptions: List[str] = Field(default_factory=list)
    subscription_total: float = 0.0
    freizeit: float = 250.0
    # BFS HABE empirical defaults (can be adjusted in wizard)
    kleidung: float = 120.0          # CHF 120/Mo — BFS HABE 2021 avg clothing+shoes
    unterhaltung: float = 200.0      # CHF 200/Mo — BFS HABE 2021 recreation & culture
    direkte_steuern: float = 700.0   # CHF 700/Mo — BFS HABE 2021 avg direct taxes
    serafe: float = 27.92            # CHF 335/Jahr ÷ 12 — Serafe (ehem. Billag)
    weiterbildung: float = 30.0      # CHF 30/Mo  — BFS HABE 2021 education/training

    # ── Step 6: Assets
    bank_balance: float = 0.0
    bank_enabled: bool = False
    stocks_value: float = 0.0
    stocks_enabled: bool = False
    property_asset_value: float = 0.0
    property_asset_debt: float = 0.0
    property_asset_enabled: bool = False
    crypto_value: float = 0.0
    crypto_enabled: bool = False
    other_assets_value: float = 0.0
    other_assets_enabled: bool = False

    # ── Step 7: Pension
    ahv_beitragsjahre: int = Field(default=10, ge=0, le=44)
    ahv_durchschnitts_lohn: float = 80_000.0
    bvg_guthaben: float = 50_000.0
    bvg_jahresbeitrag: float = 8_000.0
    bvg_rentenalter: int = Field(default=65, ge=63, le=70)
    pillar_3a_accounts: List[Pillar3aAccountPayload] = Field(default_factory=list)
    has_life_insurance: bool = False
    life_insurance_type: Literal["kapital", "risiko", "gemischt"] = "kapital"
    life_insurance_ablauf: Optional[str] = None
    life_insurance_leistung: float = 0.0

    # ── Step 8: Goals
    ziel_rentenalter: int = Field(default=65, ge=60, le=70)
    lebenserwartung: int = Field(default=90, ge=70, le=105)
    lifestyle_percent: int = Field(default=80, ge=50, le=120)
    scenario_mortgage: bool = False
    scenario_savings: bool = False
    scenario_early_retirement: bool = False
    scenario_care: bool = True
    inflation: float = Field(default=1.5, ge=0.0, le=10.0)

    @field_validator("kanton")
    @classmethod
    def validate_kanton(cls, v: str) -> str:
        valid = {
            "ZH", "BE", "LU", "UR", "SZ", "OW", "NW", "GL", "ZG", "FR",
            "SO", "BS", "BL", "SH", "AR", "AI", "SG", "GR", "AG", "TG",
            "TI", "VD", "VS", "NE", "GE", "JU",
        }
        if v.upper() not in valid:
            raise ValueError(f"Unbekannter Kanton: {v}")
        return v.upper()


class WizardSummary(BaseModel):
    accounts_created: int
    budgets_created: int
    pension_entries_created: int
    assets_created: int
    scenarios_created: int
    estimated_monthly_netto: float
    estimated_monthly_expenses: float
    estimated_monthly_surplus: float
    redirect_to: str = "/dashboard"
    message: str


# ── Helpers ────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _compute_monthly_expenses(p: WizardCompletePayload) -> float:
    housing = (
        p.monthly_rent + p.nebenkosten
        if p.housing_mode == "miete"
        else p.monthly_amortization
    )
    transport = (
        p.monthly_fuel + p.parking + p.car_amortization
        + (19.0 if p.has_sbb_halbtax else 0.0)
        + (345.0 if p.has_sbb_ga else 0.0)
    )
    return (
        housing
        + p.groceries
        + transport
        + p.health_insurance_per_person
        + p.zusatzversicherung
        + p.hausrat
        + (p.autoversicherung if p.has_auto_insurance else 0.0)
        + p.subscription_total
        + p.freizeit
        + p.kleidung
        + p.unterhaltung
        + p.direkte_steuern
        + p.serafe
        + p.weiterbildung
    )


def _build_scenario_params(p: WizardCompletePayload) -> dict:
    scenarios = []
    if p.scenario_mortgage:
        scenarios.append("mortgage_amortization")
    if p.scenario_savings:
        scenarios.append("increase_savings")
    if p.scenario_early_retirement:
        scenarios.append("early_retirement")
    if p.scenario_care:
        scenarios.append("care_costs_at_80")

    return {
        "inflation_rate": p.inflation / 100,
        "retirement_age": p.ziel_rentenalter,
        "life_expectancy": p.lebenserwartung,
        "lifestyle_factor": p.lifestyle_percent / 100,
        "kanton": p.kanton,
        "household_type": p.haushalt,
        "active_scenarios": scenarios,
        "ahv_beitragsjahre": p.ahv_beitragsjahre,
        "ahv_avg_lohn": p.ahv_durchschnitts_lohn,
        "bvg_guthaben": p.bvg_guthaben,
        "bvg_jahresbeitrag": p.bvg_jahresbeitrag,
        "bvg_rentenalter": p.bvg_rentenalter,
        "pillar_3a_total": sum(a.balance for a in p.pillar_3a_accounts),
    }


# ── Peer group endpoints (no auth — static / derived reference data) ──


@router.get(
    "/peer-reference",
    summary="Swiss cantons and common subscription catalog",
)
async def wizard_peer_reference():
    from app.services.peer_group import COMMON_SUBSCRIPTIONS, swiss_cantons_list

    return {
        "cantons": swiss_cantons_list(),
        "subscriptions": list(COMMON_SUBSCRIPTIONS),
    }


@router.post(
    "/peer-defaults",
    summary="Computed peer-group monthly defaults for a demographic profile",
)
async def wizard_peer_defaults(profile: PeerGroupProfileIn):
    from app.services.peer_group import PeerGroupProfile, get_peer_group_defaults

    p = PeerGroupProfile(
        age_group=profile.ageGroup,
        canton=profile.canton,
        household_type=profile.householdType,
        employment_status=profile.employmentStatus,
        income_level=profile.incomeLevel,
    )
    return get_peer_group_defaults(p)


# ── Main endpoint ──────────────────────────────────────────────

@router.post(
    "/complete",
    response_model=WizardSummary,
    status_code=status.HTTP_201_CREATED,
    summary="Empirische Angaben abschliessen (Onboarding)",
    description=(
        "Akzeptiert die vollständigen Daten aus «Empirischen Angaben» und legt Konten, "
        "Budgets, Vorsorge, Vermögen und ein Basisszenario an."
    ),
)
async def wizard_complete(
    payload: WizardCompletePayload,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WizardSummary:
    accounts_created = 0
    budgets_created = 0
    pension_entries_created = 0
    assets_created = 0
    scenarios_created = 0

    current_year = datetime.now().year
    # Consistent timestamp for every budget row in this wizard run — used by
    # the frontend's batch-deduplication (Strategy 1: filter to max created_at).
    wizard_run_time = datetime.now(timezone.utc)

    # ── 0. Remove previous wizard-generated data (idempotency) ────
    # Budgets created by the wizard carry a non-null `notes` field.
    # Manually created budgets (no notes) are intentionally preserved.
    await db.execute(
        sa_delete(Budget).where(
            Budget.user_id == current_user.id,
            Budget.notes.is_not(None),
        )
    )
    # Pension and asset records are always fully wizard-managed.
    await db.execute(
        sa_delete(PensionData).where(PensionData.user_id == current_user.id)
    )
    await db.execute(
        sa_delete(Asset).where(Asset.user_id == current_user.id)
    )
    # Flush deletes before inserting new rows to avoid constraint conflicts.
    await db.flush()

    # ── 1. Update user profile ─────────────────────────────────
    if payload.geburtsjahr:
        current_user.date_of_birth = datetime(payload.geburtsjahr, 6, 1, tzinfo=timezone.utc)
    current_user.retirement_age = payload.ziel_rentenalter

    # ── 2. Create checking account (Lohnkonto) ─────────────────
    if payload.estimated_netto_monthly > 0:
        checking = Account(
            user_id=current_user.id,
            name=f"{payload.vorname or 'Mein'} Lohnkonto",
            bank="Hauptbank",
            currency="CHF",
            balance=payload.bank_balance if payload.bank_enabled else 0.0,
            account_type=AccountType.checking,
        )
        db.add(checking)
        accounts_created += 1

    # ── 3. Create savings account if data entered ──────────────
    if payload.bank_enabled and payload.bank_balance > 0:
        savings = Account(
            user_id=current_user.id,
            name="Sparkonto",
            bank="Hauptbank",
            currency="CHF",
            balance=payload.bank_balance,
            account_type=AccountType.savings,
        )
        db.add(savings)
        accounts_created += 1

    # ── 4. Flush to ensure IDs are available ──────────────────
    await db.flush()

    # ── 5. Budget entries (monthly) ───────────────────────────
    def add_budget(amount: float, notes: str) -> None:
        nonlocal budgets_created
        if amount <= 0:
            return
        b = Budget(
            user_id=current_user.id,
            amount=amount,
            period=BudgetPeriod.monthly,
            year=current_year,
            notes=notes,
            # Explicit timestamp so every row in this batch shares the same
            # created_at value — required for reliable Strategy-1 deduplication
            # on the frontend (filter to max timestamp = latest wizard run).
            created_at=wizard_run_time,
        )
        db.add(b)
        budgets_created += 1

    # Housing
    if payload.housing_mode == "miete":
        add_budget(payload.monthly_rent, "Miete")
        add_budget(payload.nebenkosten, "Nebenkosten (Strom/Heizung)")
    else:
        add_budget(payload.monthly_amortization, "Hypothek Amortisation")

    # Insurance
    add_budget(payload.health_insurance_per_person, "Krankenkasse")
    if payload.zusatzversicherung > 0:
        add_budget(payload.zusatzversicherung, "Zusatzversicherung")
    add_budget(payload.hausrat, "Hausrat & Haftpflicht")
    if payload.has_auto_insurance:
        add_budget(payload.autoversicherung, "Autoversicherung")

    # Daily life
    add_budget(payload.groceries, "Lebensmittel")
    add_budget(payload.freizeit, "Freizeit & Restaurant")

    # BFS-based empirical defaults (Shopping, Unterhaltung, Steuern, Weiterbildung)
    add_budget(payload.kleidung,        "Kleidung")
    add_budget(payload.unterhaltung,    "Freizeit & Unterhaltung")
    add_budget(payload.direkte_steuern, "Direkte Steuern")
    add_budget(payload.serafe,          "Serafe")
    add_budget(payload.weiterbildung,   "Weiterbildung & Kurse")

    # Subscriptions — save one budget entry per selected service
    # SBB entries are already handled via has_sbb_halbtax / has_sbb_ga above
    _SBB_NAMES = {"SBB Halbtax", "SBB GA 2. Kl."}
    from app.services.peer_group import COMMON_SUBSCRIPTIONS as _SUBS
    _sub_price_map = {s["name"]: float(s["price"]) for s in _SUBS}
    _any_sub_saved = False
    for sub_name in payload.selected_subscriptions:
        if sub_name in _SBB_NAMES:
            continue
        price = _sub_price_map.get(sub_name, 0.0)
        add_budget(price, sub_name)
        _any_sub_saved = True
    # Fallback: if the user had a raw subscription_total but no named items
    if not _any_sub_saved and payload.subscription_total > 0:
        add_budget(payload.subscription_total, "Abonnements")

    # Transport
    if payload.transport_mode in ("car", "both"):
        add_budget(payload.monthly_fuel, "Benzin / Strom (Auto)")
        add_budget(payload.parking, "Parkplatz")
        add_budget(payload.car_amortization, "Auto-Amortisation")
    if payload.has_sbb_halbtax:
        add_budget(19.0, "SBB Halbtax")
    if payload.has_sbb_ga:
        add_budget(345.0, "SBB GA 2. Klasse")

    # ── 6. Pension entries ────────────────────────────────────

    # Pillar 1 (AHV) — informational
    ahv = PensionData(
        user_id=current_user.id,
        pillar=PensionPillar.pillar_1,
        provider="AHV/IV (BSV)",
        current_balance=0.0,
        annual_contribution=0.0,
        expected_return_rate=0.0,
        retirement_age=payload.ziel_rentenalter,
        contribution_years=payload.ahv_beitragsjahre,
        average_insured_salary=payload.ahv_durchschnitts_lohn,
        notes=(
            f"AHV Beitragsjahre: {payload.ahv_beitragsjahre} | "
            f"Ø Jahreslohn: CHF {payload.ahv_durchschnitts_lohn:,.0f}"
        ),
        as_of_date=_now(),
    )
    db.add(ahv)
    pension_entries_created += 1

    # Pillar 2 (BVG)
    bvg = PensionData(
        user_id=current_user.id,
        pillar=PensionPillar.pillar_2,
        provider="Pensionskasse",
        current_balance=payload.bvg_guthaben,
        annual_contribution=payload.bvg_jahresbeitrag,
        expected_return_rate=0.015,  # BVG Mindestzins
        retirement_age=payload.bvg_rentenalter,
        notes=f"BVG Guthaben aus empirischen Angaben | Rentenalter: {payload.bvg_rentenalter}",
        as_of_date=_now(),
    )
    db.add(bvg)
    pension_entries_created += 1

    # Pillar 3a accounts
    for i, acc_3a in enumerate(payload.pillar_3a_accounts):
        expected_return = 0.04 if acc_3a.strategy == "funds" else 0.01
        p3a = PensionData(
            user_id=current_user.id,
            pillar=PensionPillar.pillar_3a,
            provider=acc_3a.provider or f"3a Konto {i + 1}",
            current_balance=acc_3a.balance,
            annual_contribution=acc_3a.annual_contribution,
            expected_return_rate=expected_return,
            retirement_age=payload.ziel_rentenalter,
            notes=f"Strategie: {acc_3a.strategy} | Import aus empirischen Angaben",
            as_of_date=_now(),
        )
        db.add(p3a)
        pension_entries_created += 1

    # ── 7. Asset entries ──────────────────────────────────────

    if payload.stocks_enabled and payload.stocks_value > 0:
        db.add(Asset(
            user_id=current_user.id,
            asset_type=AssetType.stock,
            name="Aktien & ETFs",
            current_value=payload.stocks_value,
            currency="CHF",
            expected_return_rate=0.07,
            notes="Import aus empirischen Angaben",
            as_of_date=_now(),
        ))
        assets_created += 1

    if payload.property_asset_enabled and payload.property_asset_value > 0:
        net_equity = max(payload.property_asset_value - payload.property_asset_debt, 0.0)
        db.add(Asset(
            user_id=current_user.id,
            asset_type=AssetType.property,
            name="Immobilien",
            current_value=net_equity,
            currency="CHF",
            expected_return_rate=0.02,
            notes=(
                f"Marktwert: CHF {payload.property_asset_value:,.0f} | "
                f"Hypothek: CHF {payload.property_asset_debt:,.0f}"
            ),
            as_of_date=_now(),
        ))
        assets_created += 1

    if payload.crypto_enabled and payload.crypto_value > 0:
        db.add(Asset(
            user_id=current_user.id,
            asset_type=AssetType.crypto,
            name="Kryptowährungen",
            current_value=payload.crypto_value,
            currency="CHF",
            expected_return_rate=0.0,
            notes="Import aus empirischen Angaben — Marktwert zum Zeitpunkt der Erfassung",
            as_of_date=_now(),
        ))
        assets_created += 1

    if payload.other_assets_enabled and payload.other_assets_value > 0:
        db.add(Asset(
            user_id=current_user.id,
            asset_type=AssetType.other,
            name="Sonstige Anlagen",
            current_value=payload.other_assets_value,
            currency="CHF",
            notes="Import aus empirischen Angaben",
            as_of_date=_now(),
        ))
        assets_created += 1

    # Property entered in Step 4 (Hypothek) — also add as asset
    if payload.housing_mode == "hypothek" and payload.property_value > 0:
        net_equity_step4 = max(payload.property_value - payload.outstanding_debt, 0.0)
        db.add(Asset(
            user_id=current_user.id,
            asset_type=AssetType.property,
            name="Wohneigentum",
            current_value=net_equity_step4,
            currency="CHF",
            expected_return_rate=0.02,
            notes=(
                f"Marktwert: CHF {payload.property_value:,.0f} | "
                f"Hypothek: CHF {payload.outstanding_debt:,.0f}"
            ),
            as_of_date=_now(),
        ))
        assets_created += 1

    # ── 8. Initial projection scenario ────────────────────────

    scenario_params = _build_scenario_params(payload)
    monthly_expenses = _compute_monthly_expenses(payload)
    monthly_income = payload.estimated_netto_monthly or (
        (payload.lohn if payload.lohn_enabled else 0.0)
        + (payload.selbstaendig if payload.selbstaendig_enabled else 0.0)
        + (payload.ahv_rente if payload.ahv_rente_enabled else 0.0)
    ) * 0.72  # rough net estimate

    scenario_params["monthly_income"] = monthly_income
    scenario_params["monthly_expenses"] = monthly_expenses
    scenario_params["wizard_onboarding"] = True

    scenario = Scenario(
        user_id=current_user.id,
        name="Finanzplan (empirische Angaben)",
        description=(
            f"Automatisch erstelltes Basisszenario basierend auf empirischen Angaben "
            f"vom {_now().strftime('%d.%m.%Y')}. "
            f"Kanton: {payload.kanton} | Haushalt: {payload.haushalt} | "
            f"Rentenalter: {payload.ziel_rentenalter}"
        ),
        parameters_json=scenario_params,
    )
    db.add(scenario)
    scenarios_created += 1

    # ── 8b. Persist peer-group defaults snapshot (user-edited values) ──
    if payload.peer_group_defaults is not None:
        cfg_result = await db.execute(
            select(UserWizardConfig).where(UserWizardConfig.user_id == current_user.id)
        )
        wizard_cfg = cfg_result.scalar_one_or_none()
        blob = json.dumps(payload.peer_group_defaults, ensure_ascii=False)
        if wizard_cfg:
            wizard_cfg.peer_group_defaults_json = blob
        else:
            db.add(
                UserWizardConfig(
                    user_id=current_user.id,
                    peer_group_defaults_json=blob,
                )
            )

    # ── 9. Commit ─────────────────────────────────────────────
    await db.commit()

    monthly_surplus = max(monthly_income - monthly_expenses, 0.0)

    return WizardSummary(
        accounts_created=accounts_created,
        budgets_created=budgets_created,
        pension_entries_created=pension_entries_created,
        assets_created=assets_created,
        scenarios_created=scenarios_created,
        estimated_monthly_netto=monthly_income,
        estimated_monthly_expenses=monthly_expenses,
        estimated_monthly_surplus=monthly_surplus,
        redirect_to="/dashboard",
        message=(
            f"Finanzplan erfolgreich erstellt! "
            f"{budgets_created} Budgetposten, {pension_entries_created} Vorsorgeeinträge "
            f"und {assets_created} Vermögenswerte wurden angelegt."
        ),
    )
