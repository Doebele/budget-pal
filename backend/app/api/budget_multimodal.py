"""
Multi-Modal Budget Analysis API

GET /api/budget/multi-analysis
  mode: past | wizard | combined | peer
  start / end: ISO date range (optional, defaults to current month)

Returns a unified CategoryBreakdown across four data sources:
  past     — actual transaction history only
  wizard   — budget entries created by the setup wizard
  combined — 60 % actual + 40 % wizard (falls back gracefully)
  peer     — user spending vs. Swiss peer-group benchmarks
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import and_, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.taxonomy import (
    default_transaction_category_for_wizard_label,
    load_merged_taxonomy_for_user,
    peer_key_for_transaction_category,
    peer_key_for_wizard_label,
    peer_key_for_wizard_mapping,
    resolve_mapping_value_to_txn_category,
)
from app.models.models import (
    Account, Budget, PeerGroupBenchmark, Scenario, Transaction, User,
    WizardCategoryMapping,
)
from app.services.currency_service import (
    currency_service,
    normalize_reference_currency,
    convert_with_eur_rates,
)

logger = logging.getLogger(__name__)
router = APIRouter()

AnalysisMode = Literal["past", "wizard", "combined", "peer"]

PEER_LABELS: dict[str, str] = {
    "housing":       "Wohnen",
    "food":          "Lebensmittel",
    "transport":     "Transport",
    "insurance":     "Versicherungen",
    "health":        "Gesundheit",
    "leisure":       "Freizeit & Unterhaltung",
    "communication": "Kommunikation",
    "clothing":      "Kleidung",
    "restaurant":    "Restaurant & Takeaway",
}


def _peer_col(key: str, benchmark: PeerGroupBenchmark) -> float:
    return {
        "housing":       benchmark.housing_avg,
        "food":          benchmark.food_avg,
        "transport":     benchmark.transport_avg,
        "insurance":     benchmark.insurance_avg,
        "health":        benchmark.health_avg,
        "leisure":       benchmark.leisure_avg,
        "communication": benchmark.communication_avg,
        "clothing":      benchmark.clothing_avg,
        "restaurant":    benchmark.restaurant_avg,
    }.get(key, 0.0)


def _peer_monthly_in_ref(
    key: Optional[str],
    benchmark: Optional[PeerGroupBenchmark],
    rates: dict,
    ref: str,
) -> Optional[float]:
    """Peer benchmarks are stored in CHF per month → user's reference currency."""
    if not key or not benchmark:
        return None
    v = float(_peer_col(key, benchmark))
    if v <= 0:
        return None
    return convert_with_eur_rates(rates, v, "CHF", ref)


# ── Pydantic response models ──────────────────────────────────

class CategoryBreakdown(BaseModel):
    category: str
    peer_key: Optional[str] = None
    planned: Optional[float] = None       # wizard budget
    actual: Optional[float] = None        # real transactions
    peer_benchmark: Optional[float] = None
    blended: Optional[float] = None       # combined mode
    delta_vs_peer: Optional[float] = None # peer mode: actual - benchmark


class PeerGroupInfo(BaseModel):
    age_range: str
    household_type: str
    median_income: float
    p25_income: float
    p75_income: float
    savings_rate_pct: float
    peer_count: int


class SavingsOpportunity(BaseModel):
    category: str
    peer_key: str
    peer_label: str
    actual: float
    peer_benchmark: float
    excess: float           # actual - benchmark (positive = over peer)
    excess_pct: float       # percentage over peer benchmark
    monthly_saving: float   # potential monthly saving if reduced to benchmark
    action: str             # human-readable recommendation


class MultiAnalysisResponse(BaseModel):
    mode: str
    period_start: Optional[str]
    period_end: Optional[str]
    income: float
    total_expenses: float
    savings_rate: float
    categories: List[CategoryBreakdown]
    peer_info: Optional[PeerGroupInfo] = None
    wizard_available: bool
    peer_data_available: bool
    data_sources: List[str]
    opportunities: List[SavingsOpportunity] = []
    reference_currency: str = "CHF"


# ── Helpers ───────────────────────────────────────────────────

def _utc_start(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, 0, 0, 0)


def _utc_end(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, 23, 59, 59)


def _user_age(user: User) -> Optional[int]:
    if not user.date_of_birth:
        return None
    today = date.today()
    dob = user.date_of_birth.date() if hasattr(user.date_of_birth, "date") else user.date_of_birth
    return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))


async def _get_wizard_scenario(user_id: int, db: AsyncSession) -> Optional[dict]:
    """Return the parameters_json of the most-recent wizard onboarding scenario."""
    result = await db.execute(
        select(Scenario)
        .where(Scenario.user_id == user_id)
        .order_by(desc(Scenario.created_at))
    )
    for scenario in result.scalars().all():
        params = scenario.parameters_json or {}
        if params.get("wizard_onboarding"):
            return params
    return None


async def _get_wizard_budgets(user_id: int, db: AsyncSession) -> list[Budget]:
    """Return only the most-recent wizard batch (all entries share the same created_at)."""
    # Find the latest creation timestamp
    ts_result = await db.execute(
        select(func.max(Budget.created_at)).where(Budget.user_id == user_id)
    )
    latest_ts = ts_result.scalar_one_or_none()
    if latest_ts is None:
        return []
    # Load only entries from that batch
    result = await db.execute(
        select(Budget).where(
            and_(Budget.user_id == user_id, Budget.created_at == latest_ts)
        )
    )
    return list(result.scalars().all())


async def _get_actual_stats(
    user_id: int,
    period_start: date,
    period_end: date,
    db: AsyncSession,
    rates: dict,
    ref_currency: str,
) -> tuple[float, dict[str, float]]:
    """Returns (total_income, {category: total_expense}) in `ref_currency`."""
    result = await db.execute(
        select(Transaction.amount, Transaction.category, Account.currency)
        .join(Account)
        .where(
            and_(
                Account.user_id == user_id,
                Transaction.is_deleted.isnot(True),
                Transaction.is_transfer == False,
                Transaction.date >= _utc_start(period_start),
                Transaction.date <= _utc_end(period_end),
            )
        )
    )
    income = 0.0
    expenses: dict[str, float] = {}
    for amt, cat, acur in result.all():
        cur = (acur or "CHF").strip().upper()
        conv = convert_with_eur_rates(rates, float(amt), cur, ref_currency)
        if conv > 0:
            income += conv
        else:
            c = cat or "Sonstiges"
            expenses[c] = expenses.get(c, 0.0) + abs(conv)
    return income, expenses


async def _get_peer_benchmark(
    user: User, wizard_params: Optional[dict], db: AsyncSession
) -> Optional[PeerGroupBenchmark]:
    age = _user_age(user)
    household = (wizard_params or {}).get("household_type", "single")
    if age is None:
        return None
    result = await db.execute(
        select(PeerGroupBenchmark).where(
            and_(
                PeerGroupBenchmark.age_range_start <= age,
                PeerGroupBenchmark.age_range_end >= age,
                PeerGroupBenchmark.household_type == household,
            )
        )
    )
    return result.scalar_one_or_none()


# ── Main endpoint ─────────────────────────────────────────────

@router.get("/multi-analysis", response_model=MultiAnalysisResponse)
async def multi_analysis(
    mode: AnalysisMode = Query("combined"),
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    today = date.today()
    period_start = start or date(today.year, today.month, 1)
    period_end = end or today

    rates = await currency_service.get_rates("EUR")
    ref = normalize_reference_currency(current_user.currency)

    wizard_params = await _get_wizard_scenario(current_user.id, db)
    wizard_budgets = await _get_wizard_budgets(current_user.id, db)
    actual_income, actual_expenses = await _get_actual_stats(
        current_user.id, period_start, period_end, db, rates, ref
    )
    peer_benchmark = await _get_peer_benchmark(current_user, wizard_params, db)

    merged_taxonomy = await load_merged_taxonomy_for_user(db, current_user.id)

    wizard_available = wizard_params is not None and len(wizard_budgets) > 0
    peer_data_available = peer_benchmark is not None

    # ── Period length (used in wizard/combined scaling) ───────
    months = max(
        1,
        (period_end.year - period_start.year) * 12
        + (period_end.month - period_start.month) + 1,
    )

    # ── Build category breakdown ──────────────────────────────
    categories: list[CategoryBreakdown] = []
    data_sources: list[str] = []

    if mode == "past":
        data_sources = ["transactions"]
        for cat, amount in sorted(actual_expenses.items(), key=lambda x: -x[1]):
            peer_key = peer_key_for_transaction_category(merged_taxonomy, cat)
            benchmark_val = _peer_monthly_in_ref(peer_key, peer_benchmark, rates, ref)
            categories.append(CategoryBreakdown(
                category=cat,
                peer_key=peer_key,
                actual=round(amount, 2),
                peer_benchmark=round(benchmark_val, 2) if benchmark_val else None,
            ))
        income = actual_income
        total_expenses = sum(actual_expenses.values())

    elif mode == "wizard":
        data_sources = ["wizard_budgets"]
        # Group wizard budgets by notes label
        wizard_totals: dict[str, float] = {}
        for b in wizard_budgets:
            label = b.notes or "Sonstiges"
            conv_amt = convert_with_eur_rates(rates, float(b.amount), "CHF", ref)
            wizard_totals[label] = wizard_totals.get(label, 0.0) + conv_amt

        # Load category mappings (DB overrides + defaults)
        mapping_result = await db.execute(
            select(WizardCategoryMapping).where(WizardCategoryMapping.user_id == current_user.id)
        )
        user_mappings = {m.wizard_label.lower(): m.transaction_category for m in mapping_result.scalars()}

        def resolve_txn_cat(wizard_label: str) -> Optional[str]:
            lower = wizard_label.lower()
            if lower in user_mappings:
                return resolve_mapping_value_to_txn_category(
                    merged_taxonomy, user_mappings[lower], wizard_label
                )
            d = default_transaction_category_for_wizard_label(merged_taxonomy, wizard_label)
            return d if d else None

        if (wizard_params or {}).get("monthly_income") is not None:
            monthly_wizard_income = convert_with_eur_rates(
                rates, float(wizard_params["monthly_income"]), "CHF", ref
            )
            income = monthly_wizard_income * months
        else:
            income = actual_income
        for cat, monthly_amount in sorted(wizard_totals.items(), key=lambda x: -x[1]):
            txn_cat = resolve_txn_cat(cat)
            actual_val = actual_expenses.get(txn_cat) if txn_cat else actual_expenses.get(cat)
            _mk = user_mappings.get(cat.lower())
            _peer = peer_key_for_wizard_mapping(merged_taxonomy, cat, _mk)
            categories.append(CategoryBreakdown(
                category=cat,
                peer_key=_peer,
                planned=round(monthly_amount * months, 2),   # period total
                actual=round(actual_val, 2) if actual_val is not None else None,
            ))
        total_expenses = sum(wizard_totals.values()) * months  # period total
        if actual_expenses:
            data_sources.append("transactions")

    elif mode == "combined":
        data_sources = ["transactions"]
        # Wizard budgets keyed by notes
        wizard_by_label: dict[str, float] = {}
        for b in wizard_budgets:
            label = b.notes or "Sonstiges"
            conv_amt = convert_with_eur_rates(rates, float(b.amount), "CHF", ref)
            wizard_by_label[label] = wizard_by_label.get(label, 0.0) + conv_amt
        if wizard_by_label:
            data_sources.append("wizard_budgets")

        # Merge actual + wizard categories
        all_cats = set(actual_expenses.keys()) | set(wizard_by_label.keys())
        blended_total = 0.0
        for cat in sorted(all_cats):
            actual = actual_expenses.get(cat)
            planned = wizard_by_label.get(cat)
            if actual is not None and planned is not None:
                blended = round(0.6 * actual + 0.4 * planned, 2)
            elif actual is not None:
                blended = round(actual, 2)
            else:
                blended = round(planned, 2)  # type: ignore[arg-type]
            blended_total += blended
            categories.append(CategoryBreakdown(
                category=cat,
                peer_key=(
                    peer_key_for_transaction_category(merged_taxonomy, cat)
                    or peer_key_for_wizard_label(merged_taxonomy, cat)
                ),
                planned=round(planned, 2) if planned is not None else None,
                actual=round(actual, 2) if actual is not None else None,
                blended=blended,
            ))
        categories.sort(key=lambda c: -(c.blended or 0))
        if actual_income:
            income = actual_income
        elif (wizard_params or {}).get("monthly_income") is not None:
            income = convert_with_eur_rates(
                rates, float(wizard_params["monthly_income"]), "CHF", ref
            )
        else:
            income = 0.0
        total_expenses = blended_total

    else:  # peer
        data_sources = ["transactions"]
        if peer_benchmark:
            data_sources.append("peer_benchmarks")
        # Use actual transactions; add peer benchmark per peer_key
        peer_groups: dict[str, list[str]] = {}
        for cat, amount in actual_expenses.items():
            peer_key = peer_key_for_transaction_category(merged_taxonomy, cat)
            if peer_key:
                peer_groups.setdefault(peer_key, [])
                peer_groups[peer_key].append(cat)

        # Show one row per peer category
        shown_peer_keys: set[str] = set()
        for cat, amount in sorted(actual_expenses.items(), key=lambda x: -x[1]):
            peer_key = peer_key_for_transaction_category(merged_taxonomy, cat)
            benchmark_val = _peer_monthly_in_ref(peer_key, peer_benchmark, rates, ref)
            delta = round(amount - benchmark_val, 2) if benchmark_val is not None else None
            entry = CategoryBreakdown(
                category=cat,
                peer_key=peer_key,
                actual=round(amount, 2),
                peer_benchmark=round(benchmark_val, 2) if benchmark_val is not None else None,
                delta_vs_peer=delta,
            )
            # Avoid duplicate peer categories
            if peer_key and peer_key in shown_peer_keys:
                # Aggregate into existing entry
                for existing in categories:
                    if existing.peer_key == peer_key:
                        existing.actual = round((existing.actual or 0) + amount, 2)
                        if existing.delta_vs_peer is not None and delta is not None:
                            existing.delta_vs_peer = round((existing.delta_vs_peer or 0) + amount, 2)
                        break
            else:
                if peer_key:
                    shown_peer_keys.add(peer_key)
                categories.append(entry)
        income = actual_income
        total_expenses = sum(actual_expenses.values())

    # ── Top-level metrics ─────────────────────────────────────
    # All modes now return period totals for income/total_expenses.
    # Savings rate is computed from monthly figures for comparability.
    monthly_income = income / months if months > 1 else income
    monthly_expenses = total_expenses / months if months > 1 else total_expenses
    savings_rate = (
        round((monthly_income - monthly_expenses) / monthly_income * 100, 1)
        if monthly_income > 0 else 0.0
    )

    peer_info: Optional[PeerGroupInfo] = None
    if peer_benchmark and mode in ("peer", "combined", "past"):
        age = _user_age(current_user)
        peer_info = PeerGroupInfo(
            age_range=f"{peer_benchmark.age_range_start}–{peer_benchmark.age_range_end}",
            household_type=peer_benchmark.household_type,
            median_income=convert_with_eur_rates(
                rates, float(peer_benchmark.median_income_monthly), "CHF", ref
            ),
            p25_income=convert_with_eur_rates(
                rates, float(peer_benchmark.p25_income_monthly), "CHF", ref
            ),
            p75_income=convert_with_eur_rates(
                rates, float(peer_benchmark.p75_income_monthly), "CHF", ref
            ),
            savings_rate_pct=peer_benchmark.savings_rate_pct,
            peer_count=peer_benchmark.peer_count,
        )

    # ── Savings opportunities (always computed when peer data exists) ──
    opportunities: list[SavingsOpportunity] = []
    if peer_benchmark:
        # Aggregate actual spending by peer_key
        actual_by_peer_key: dict[str, float] = {}
        for cat_name, amount in actual_expenses.items():
            pk = peer_key_for_transaction_category(merged_taxonomy, cat_name)
            if pk:
                actual_by_peer_key[pk] = actual_by_peer_key.get(pk, 0.0) + amount

        threshold = 1.15  # flag if >15% over peer benchmark
        for pk, label in PEER_LABELS.items():
            benchmark_val = _peer_monthly_in_ref(pk, peer_benchmark, rates, ref)
            if not benchmark_val or benchmark_val <= 0:
                continue
            user_val = actual_by_peer_key.get(pk, 0.0)
            if user_val <= 0:
                continue
            # Normalize: benchmark is monthly, user_val is for the whole period
            monthly_user = user_val / months
            if monthly_user > benchmark_val * threshold:
                excess = round(monthly_user - benchmark_val, 2)
                excess_pct = round((monthly_user / benchmark_val - 1) * 100, 1)
                opportunities.append(SavingsOpportunity(
                    category=label,
                    peer_key=pk,
                    peer_label=label,
                    actual=round(monthly_user, 2),
                    peer_benchmark=round(benchmark_val, 2),
                    excess=excess,
                    excess_pct=excess_pct,
                    monthly_saving=excess,
                    action=(
                        f"Reduziere {label} von {monthly_user:,.0f} auf ~{benchmark_val:,.0f} "
                        f"{ref}/Monat → spare ~{excess:,.0f} {ref}/Monat"
                    ),
                ))
        opportunities.sort(key=lambda o: -o.excess)

    return MultiAnalysisResponse(
        mode=mode,
        period_start=period_start.isoformat(),
        period_end=period_end.isoformat(),
        income=round(income, 2),           # period total
        total_expenses=round(total_expenses, 2),  # period total
        savings_rate=savings_rate,          # monthly rate
        categories=categories,
        peer_info=peer_info,
        wizard_available=wizard_available,
        peer_data_available=peer_data_available,
        data_sources=data_sources,
        opportunities=opportunities,
        reference_currency=ref,
    )


# ── Budget Health Score ───────────────────────────────────────

class HealthScoreComponent(BaseModel):
    name: str
    score: float        # 0–100
    weight: float       # 0–1, sum = 1.0
    detail: str


class HealthScoreLever(BaseModel):
    title: str
    body: str
    potential: float    # CHF / month improvement potential


class HealthScoreResponse(BaseModel):
    score: float        # 0–100 weighted composite
    grade: str          # A / B / C / D / F
    components: List[HealthScoreComponent]
    top_levers: List[HealthScoreLever]


def _grade(score: float) -> str:
    if score >= 85: return "A"
    if score >= 70: return "B"
    if score >= 55: return "C"
    if score >= 40: return "D"
    return "F"


def _compute_health_score(
    *,
    income: float,
    expenses: float,
    cat_totals: "dict[str, float]",
    planned_total: float,
    has_pension: bool,
    months_covered: int,
    ref: str,
) -> HealthScoreResponse:
    """Shared scoring logic — called with data from any mode."""

    # Component 1: Savings Rate (30%)
    if income > 0:
        savings_rate_pct = max(0.0, (income - expenses) / income * 100)
        savings_score = min(100.0, savings_rate_pct * 4.0)
    else:
        savings_rate_pct = 0.0
        savings_score = 0.0

    # Component 2: Budget Adherence (25%)
    if planned_total > 0:
        util = expenses / planned_total
        if util <= 1.0:
            adherence_score = 100.0
        elif util <= 1.2:
            adherence_score = max(0.0, 100.0 - (util - 1.0) * 250)
        else:
            adherence_score = 0.0
    else:
        adherence_score = 50.0

    # Component 3: Cashflow Coverage (20%)
    if income <= 0:
        cashflow_score = 0.0
    elif income >= expenses:
        cashflow_score = 100.0
    else:
        cashflow_score = max(0.0, (income / expenses) * 100.0)

    # Component 4: Pension Progress (15%)
    pension_score = 100.0 if has_pension else 30.0

    # Component 5: Expense Diversity (10%)
    if expenses > 0 and cat_totals:
        shares = [v / expenses for v in cat_totals.values()]
        hhi = sum(s ** 2 for s in shares)
        diversity_score = min(100.0, (1 - hhi) * 100 * 1.3)
    else:
        diversity_score = 50.0

    components = [
        HealthScoreComponent(
            name="Sparquote", score=round(savings_score, 1), weight=0.30,
            detail=f"{savings_rate_pct:.1f}% Sparquote" if income > 0 else "Keine Einnahmen im Zeitraum",
        ),
        HealthScoreComponent(
            name="Budgettreue", score=round(adherence_score, 1), weight=0.25,
            detail=(
                f"{round(expenses / planned_total * 100):.0f}% des Budgets ausgeschöpft"
                if planned_total > 0 else "Kein Soll-Budget erfasst"
            ),
        ),
        HealthScoreComponent(
            name="Cashflow", score=round(cashflow_score, 1), weight=0.20,
            detail=(
                f"Einnahmen decken Ausgaben zu {round(income/expenses*100) if expenses > 0 else 100:.0f}%"
                if income > 0 else "Keine Einnahmen erfasst"
            ),
        ),
        HealthScoreComponent(
            name="Altersvorsorge", score=round(pension_score, 1), weight=0.15,
            detail="Vorsorgebeiträge erkannt" if has_pension else "Keine Säule-3a-Beiträge erkannt",
        ),
        HealthScoreComponent(
            name="Ausgabendiversität", score=round(diversity_score, 1), weight=0.10,
            detail=f"{len(cat_totals)} Kategorien im Zeitraum",
        ),
    ]

    weighted_score = round(sum(c.score * c.weight for c in components), 1)

    levers: List[HealthScoreLever] = []
    if savings_score < 70:
        gap = max(0, income * 0.20 - (income - expenses))
        levers.append(HealthScoreLever(
            title="Sparquote erhöhen",
            body=f"Ziel: 20% Sparquote. Spare zusätzlich ~{ref} {gap/months_covered:,.0f}/Monat.",
            potential=round(gap / months_covered, 0),
        ))
    if adherence_score < 70 and planned_total > 0:
        overspend = max(0.0, expenses - planned_total) / months_covered
        levers.append(HealthScoreLever(
            title="Budgeteinhaltung verbessern",
            body=f"Ausgaben übersteigen das Budget um ~{ref} {overspend:,.0f}/Monat.",
            potential=round(overspend, 0),
        ))
    if pension_score < 70:
        levers.append(HealthScoreLever(
            title="Säule 3a einrichten",
            body="Zahle regelmässig in die Säule 3a ein. Max. CHF 7'056/Jahr (2024, unselbstständig).",
            potential=588.0,
        ))
    if cashflow_score < 80 and income > 0:
        deficit = max(0.0, expenses - income) / months_covered
        levers.append(HealthScoreLever(
            title="Ausgaben senken",
            body=f"Ausgaben übersteigen Einnahmen um ~{ref} {deficit:,.0f}/Monat.",
            potential=round(deficit, 0),
        ))
    levers.sort(key=lambda l: -l.potential)

    return HealthScoreResponse(
        score=weighted_score,
        grade=_grade(weighted_score),
        components=components,
        top_levers=levers[:3],
    )


@router.get("/health-score", response_model=HealthScoreResponse)
async def budget_health_score(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    mode: str = Query("historical"),   # historical | empirical | plan
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Budget Health Score — five weighted components, three data-source modes:
      historical  Real bank transactions
      empirical   Wizard-configured monthly amounts
      plan        Recurring-plan (Budgetplan) entries
    """
    import json as _json
    from datetime import timedelta
    from collections import defaultdict

    ref = normalize_reference_currency(current_user.currency)
    rates = await currency_service.get_rates()
    today = date.today()

    # ── Date range ─────────────────────────────────────────────
    if start and end:
        period_start = date.fromisoformat(start)
        period_end   = date.fromisoformat(end)
    else:
        period_start = (today.replace(day=1) - timedelta(days=1)).replace(day=1)
        period_start = (period_start - timedelta(days=1)).replace(day=1)
        period_end   = today

    months_covered = max(
        1,
        (period_end.year - period_start.year) * 12
        + (period_end.month - period_start.month) + 1,
    )

    # ── Common wizard budget loader (used by historical + plan) ──
    wizard_budgets = (await db.execute(
        select(Budget)
        .where(Budget.user_id == current_user.id, Budget.notes.isnot(None))
        .order_by(Budget.created_at.desc())
    )).scalars().all()

    # ══════════════════════════════════════════════════════════
    # MODE: historical — real transaction data
    # ══════════════════════════════════════════════════════════
    if mode == "historical":
        rows = (await db.execute(
            select(Transaction)
            .join(Account, Transaction.account_id == Account.id)
            .where(
                Account.user_id == current_user.id,
                Transaction.is_deleted.isnot(True),
                Transaction.is_transfer.isnot(True),
                Transaction.date >= _utc_start(period_start),
                Transaction.date <= _utc_end(period_end),
            )
        )).scalars().all()

        income = 0.0; expenses = 0.0
        cat_totals: dict[str, float] = defaultdict(float)
        for t in rows:
            amt = convert_with_eur_rates(rates, t.amount, (t.currency or "CHF").upper(), ref)
            if amt > 0:
                income += amt
            else:
                abs_amt = -amt
                expenses += abs_amt
                cat_totals[(t.category or "Sonstiges").lower()] += abs_amt

        planned_total = 0.0
        seen: set[str] = set()
        for b in wizard_budgets:
            k = (b.notes or "").strip().lower()
            if k and k not in seen:
                seen.add(k)
                planned_total += abs(b.amount) * months_covered

        savings_cats = {"3a", "pillar", "säule", "pension", "sparen", "altersvorsorge", "bvg", "pkk"}
        has_pension = any(
            any(k in (t.category or "").lower() for k in savings_cats)
            for t in rows if t.amount < 0
        ) or any(
            any(k in (b.notes or "").lower() for k in {"3a", "pillar", "säule", "pension"})
            for b in wizard_budgets
        )

    # ══════════════════════════════════════════════════════════
    # MODE: empirical — wizard configuration
    # ══════════════════════════════════════════════════════════
    elif mode == "empirical":
        from app.models.models import UserWizardConfig
        cfg_row = (await db.execute(
            select(UserWizardConfig).where(UserWizardConfig.user_id == current_user.id)
        )).scalar_one_or_none()

        income = 0.0; expenses = 0.0
        cat_totals = defaultdict(float)

        if cfg_row and cfg_row.wizard_data_json:
            d: dict = _json.loads(cfg_row.wizard_data_json)

            # Income (monthly)
            if d.get("lohnEnabled") and (d.get("lohn") or 0) > 0:
                income += d["lohn"]
            if d.get("selbstaendigEnabled") and (d.get("selbstaendig") or 0) > 0:
                income += d["selbstaendig"]
            if d.get("ahvRenteEnabled") and (d.get("ahvRente") or 0) > 0:
                income += d["ahvRente"]
            if d.get("dividendenEnabled") and (d.get("dividenden") or 0) > 0:
                income += d["dividenden"]
            if d.get("mieteinnahmenEnabled") and (d.get("mieteinnahmen") or 0) > 0:
                income += d["mieteinnahmen"]

            # Expenses per category (monthly)
            def _add(cat: str, amt: float) -> None:
                if amt > 0:
                    expenses_box[0] += amt
                    cat_totals[cat] += amt

            expenses_box = [0.0]

            if d.get("housingMode") == "miete":
                _add("wohnen", (d.get("monthlyRent") or 0) + (d.get("nebenkosten") or 0))
            else:
                _add("wohnen", d.get("monthlyAmortization") or 0)
            _add("krankenkasse", d.get("healthInsurancePerPerson") or 0)
            _add("zusatzversicherung", d.get("zusatzversicherung") or 0)
            _add("hausrat", d.get("hausrat") or 0)
            if d.get("hasAutoInsurance"):
                _add("autoversicherung", d.get("autoversicherung") or 0)
            _add("lebensmittel", d.get("groceries") or 0)
            _add("freizeit", d.get("freizeit") or 0)
            _add("kleidung", d.get("kleidung") or 0)
            _add("unterhaltung", d.get("unterhaltung") or 0)
            _add("weiterbildung", d.get("weiterbildung") or 0)
            if d.get("transportMode") in ("car", "both"):
                _add("transport", (d.get("monthlyFuel") or 0) + (d.get("parking") or 0) + (d.get("carAmortization") or 0))
            # Subscriptions
            sub_total = d.get("subscriptionTotal") or 0
            if sub_total > 0:
                _add("abonnements", sub_total)
            # Serafe
            if (d.get("serafe") or 0) > 0:
                _add("serafe", d["serafe"])

            expenses = expenses_box[0]
            # Scale to period
            income   *= months_covered
            expenses *= months_covered
            for k in cat_totals:
                cat_totals[k] *= months_covered

        # For empirical: the wizard IS the plan, so adherence is perfect by definition
        # We use the empirical expenses as planned (shows 100% unless wizard has no data)
        planned_total = expenses

        # Pension: pillar 3a contributions in wizard
        has_pension = (
            len(cfg_row.wizard_data_json and _json.loads(cfg_row.wizard_data_json).get("pillar3aAccounts") or []) > 0
            if cfg_row and cfg_row.wizard_data_json else False
        )

    # ══════════════════════════════════════════════════════════
    # MODE: plan — recurring_plan entries
    # ══════════════════════════════════════════════════════════
    else:  # plan
        from app.models.models import RecurringPlan as RPlan
        PERIOD_MONTHS = {"weekly": 1/4.33, "monthly": 1, "quarterly": 3, "halfyearly": 6, "yearly": 12}
        target_year = period_start.year

        plan_entries = (await db.execute(
            select(RPlan)
            .where(
                RPlan.user_id == current_user.id,
                RPlan.start_date <= date(target_year, 12, 31),
            )
            .filter(
                (RPlan.end_date == None) | (RPlan.end_date >= date(target_year, 1, 1))  # noqa: E711
            )
        )).scalars().all()

        income = 0.0; expenses = 0.0
        cat_totals = defaultdict(float)

        for e in plan_entries:
            pm = PERIOD_MONTHS.get(e.periodicity or "monthly", 1)
            monthly = float(e.amount) / pm  # amount per month equivalent
            period_total = monthly * months_covered
            plan_cur = (getattr(e, "currency", None) or "CHF").strip().upper()
            period_ref = convert_with_eur_rates(rates, period_total, plan_cur, ref)
            if period_ref > 0:
                income += period_ref
            else:
                abs_total = -period_ref
                expenses += abs_total
                cat_label = (e.description or "sonstiges").lower()[:20]
                cat_totals[cat_label] += abs_total

        # Budget adherence: plan vs actual transactions
        rows_actual = (await db.execute(
            select(Transaction)
            .join(Account, Transaction.account_id == Account.id)
            .where(
                Account.user_id == current_user.id,
                Transaction.is_deleted.isnot(True),
                Transaction.is_transfer.isnot(True),
                Transaction.date >= _utc_start(period_start),
                Transaction.date <= _utc_end(period_end),
            )
        )).scalars().all()

        actual_expenses = sum(
            -convert_with_eur_rates(rates, t.amount, (t.currency or "CHF").upper(), ref)
            for t in rows_actual if t.amount < 0
        )
        # planned_total = projected expenses from plan; compare to actual
        planned_total = expenses if expenses > 0 else 0.0
        # Override expenses with actual for honest budget-adherence comparison
        expenses_for_adherence = actual_expenses
        # But keep plan expenses for income/cashflow scoring
        # Recalculate: use actual for adherence, plan for cashflow/savings
        income_for_savings = income  # plan income
        expenses_for_savings = actual_expenses if actual_expenses > 0 else expenses

        savings_cats = {"3a", "pillar", "säule", "pension", "sparen", "altersvorsorge", "bvg", "pkk"}
        has_pension = any(
            any(k in (e.description or "").lower() for k in savings_cats)
            for e in plan_entries if e.amount < 0
        )

        # Rewrite income/expenses to be what the scorer will use
        income = income_for_savings
        expenses = expenses_for_savings

    return _compute_health_score(
        income=income,
        expenses=expenses,
        cat_totals=cat_totals,
        planned_total=planned_total,
        has_pension=has_pension,
        months_covered=months_covered,
        ref=ref,
    )
