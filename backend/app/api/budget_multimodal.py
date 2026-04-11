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
                return user_mappings[lower]
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
            categories.append(CategoryBreakdown(
                category=cat,
                peer_key=peer_key_for_wizard_label(merged_taxonomy, cat),
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
