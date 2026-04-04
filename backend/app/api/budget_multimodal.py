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
from app.models.models import (
    Account, Budget, PeerGroupBenchmark, Scenario, Transaction, User,
)

logger = logging.getLogger(__name__)
router = APIRouter()

AnalysisMode = Literal["past", "wizard", "combined", "peer"]

# ── Category mapping helpers ──────────────────────────────────

# Maps wizard budget `notes` → peer-group column key
WIZARD_TO_PEER: dict[str, str] = {
    "miete": "housing",
    "hypothek": "housing",
    "hypothek & amortisation": "housing",
    "nebenkosten": "housing",
    "krankenkasse": "insurance",
    "zusatzversicherung": "insurance",
    "hausrat & haftpflicht": "insurance",
    "autoversicherung": "insurance",
    "lebensmittel": "food",
    "freizeit & restaurant": "food",
    "abonnements": "leisure",
    "benzin / strom (auto)": "transport",
    "parkplatz": "transport",
    "auto-amortisation": "transport",
    "sbb halbtax": "transport",
    "sbb ga 2. klasse": "transport",
}

# Maps transaction category → peer-group column key
TXN_TO_PEER: dict[str, str] = {
    # Food / Lebensmittel
    "groceries": "food",
    "food & drink": "food",
    "lebensmittel": "food",
    # Restaurant & Takeaway
    "restaurant & takeaway": "restaurant",
    "freizeit & restaurant": "restaurant",
    # Transport
    "transport": "transport",
    "travel": "transport",
    "reisen": "transport",
    "öv-abonnements": "transport",
    # Housing / Wohnen
    "housing": "housing",
    "wohnen": "housing",
    "utilities": "housing",
    "nebenkosten": "housing",
    # Insurance / Versicherungen
    "insurance": "insurance",
    "versicherungen": "insurance",
    "krankenkasse": "insurance",
    "weitere versicherungen": "insurance",
    # Health / Gesundheit
    "health": "health",
    "gesundheit": "health",
    "fitness": "health",
    # Leisure / Freizeit
    "entertainment": "leisure",
    "unterhaltung": "leisure",
    "freizeit & unterhaltung": "leisure",
    "abonnements": "leisure",
    "streaming": "leisure",
    "musik & medien": "leisure",
    "nachrichten & medien": "leisure",
    "cloud & backup": "leisure",
    "software & apps": "leisure",
    "treue & mitgliedschaften": "leisure",
    "bildung & weiterbildung": "leisure",
    "beruflich": "leisure",
    # Communication / Kommunikation
    "kommunikation": "communication",
    "internet (festnetz)": "communication",
    "mobilfunk": "communication",
    # Clothing / Kleidung
    "kleidung": "clothing",
    "shopping": "clothing",
    "shopping & lieferdienste": "clothing",
}

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
    user_id: int, period_start: date, period_end: date, db: AsyncSession
) -> tuple[float, dict[str, float]]:
    """Returns (total_income, {category: total_expense}) for the period."""
    result = await db.execute(
        select(Transaction)
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
    txns = result.scalars().all()
    income = sum(t.amount for t in txns if t.amount > 0)
    expenses: dict[str, float] = {}
    for t in txns:
        if t.amount >= 0:
            continue
        cat = t.category or "Sonstiges"
        expenses[cat] = expenses.get(cat, 0.0) + abs(t.amount)
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

    # ── Load data sources ─────────────────────────────────────
    wizard_params = await _get_wizard_scenario(current_user.id, db)
    wizard_budgets = await _get_wizard_budgets(current_user.id, db)
    actual_income, actual_expenses = await _get_actual_stats(
        current_user.id, period_start, period_end, db
    )
    peer_benchmark = await _get_peer_benchmark(current_user, wizard_params, db)

    wizard_available = wizard_params is not None and len(wizard_budgets) > 0
    peer_data_available = peer_benchmark is not None

    # ── Build category breakdown ──────────────────────────────
    categories: list[CategoryBreakdown] = []
    data_sources: list[str] = []

    if mode == "past":
        data_sources = ["transactions"]
        for cat, amount in sorted(actual_expenses.items(), key=lambda x: -x[1]):
            peer_key = TXN_TO_PEER.get(cat.lower())
            benchmark_val = _peer_col(peer_key, peer_benchmark) if (peer_key and peer_benchmark) else None
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
            wizard_totals[label] = wizard_totals.get(label, 0.0) + b.amount
        for cat, planned in sorted(wizard_totals.items(), key=lambda x: -x[1]):
            actual = actual_expenses.get(cat)
            categories.append(CategoryBreakdown(
                category=cat,
                peer_key=WIZARD_TO_PEER.get(cat.lower()),
                planned=round(planned, 2),
                actual=round(actual, 2) if actual is not None else None,
            ))
        income = (wizard_params or {}).get("monthly_income", actual_income)
        total_expenses = sum(wizard_totals.values())
        if actual_expenses:
            data_sources.append("transactions")

    elif mode == "combined":
        data_sources = ["transactions"]
        # Wizard budgets keyed by notes
        wizard_by_label: dict[str, float] = {}
        for b in wizard_budgets:
            label = b.notes or "Sonstiges"
            wizard_by_label[label] = wizard_by_label.get(label, 0.0) + b.amount
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
                peer_key=TXN_TO_PEER.get(cat.lower()) or WIZARD_TO_PEER.get(cat.lower()),
                planned=round(planned, 2) if planned is not None else None,
                actual=round(actual, 2) if actual is not None else None,
                blended=blended,
            ))
        categories.sort(key=lambda c: -(c.blended or 0))
        income = actual_income or (wizard_params or {}).get("monthly_income", 0.0)
        total_expenses = blended_total

    else:  # peer
        data_sources = ["transactions"]
        if peer_benchmark:
            data_sources.append("peer_benchmarks")
        # Use actual transactions; add peer benchmark per peer_key
        peer_groups: dict[str, list[str]] = {}
        for cat, amount in actual_expenses.items():
            peer_key = TXN_TO_PEER.get(cat.lower())
            if peer_key:
                peer_groups.setdefault(peer_key, [])
                peer_groups[peer_key].append(cat)

        # Show one row per peer category
        shown_peer_keys: set[str] = set()
        for cat, amount in sorted(actual_expenses.items(), key=lambda x: -x[1]):
            peer_key = TXN_TO_PEER.get(cat.lower())
            benchmark_val = _peer_col(peer_key, peer_benchmark) if (peer_key and peer_benchmark) else None
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
    months = max(
        1,
        (period_end.year - period_start.year) * 12
        + (period_end.month - period_start.month) + 1,
    )
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
            median_income=peer_benchmark.median_income_monthly,
            p25_income=peer_benchmark.p25_income_monthly,
            p75_income=peer_benchmark.p75_income_monthly,
            savings_rate_pct=peer_benchmark.savings_rate_pct,
            peer_count=peer_benchmark.peer_count,
        )

    # ── Savings opportunities (always computed when peer data exists) ──
    opportunities: list[SavingsOpportunity] = []
    if peer_benchmark:
        # Aggregate actual spending by peer_key
        actual_by_peer_key: dict[str, float] = {}
        for cat_name, amount in actual_expenses.items():
            pk = TXN_TO_PEER.get(cat_name.lower())
            if pk:
                actual_by_peer_key[pk] = actual_by_peer_key.get(pk, 0.0) + amount

        threshold = 1.15  # flag if >15% over peer benchmark
        for pk, label in PEER_LABELS.items():
            benchmark_val = _peer_col(pk, peer_benchmark)
            if benchmark_val <= 0:
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
                    action=f"Reduziere {label} von {monthly_user:,.0f} auf ~{benchmark_val:,.0f} CHF/Monat → spare ~{excess:,.0f} CHF/Monat",
                ))
        opportunities.sort(key=lambda o: -o.excess)

    return MultiAnalysisResponse(
        mode=mode,
        period_start=period_start.isoformat(),
        period_end=period_end.isoformat(),
        income=round(monthly_income, 2),
        total_expenses=round(monthly_expenses, 2),
        savings_rate=savings_rate,
        categories=categories,
        peer_info=peer_info,
        wizard_available=wizard_available,
        peer_data_available=peer_data_available,
        data_sources=data_sources,
        opportunities=opportunities,
    )
