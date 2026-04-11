"""
Prediction Engine — Time-series forecasting for budget-pal.

Combines:
  A. Historical transaction analysis (seasonality, trend, stability)
  B. Periodicity-aware recurring expense projection (weekly/monthly/quarterly/…)
  C. Peer-group calibration (Swiss BFS HABE defaults) for sparse data
  D. Forward projection (N months) with confidence intervals

Algorithm overview
------------------
1. Aggregate transactions by (year-month, category) — last 12 months for means,
   up to 24 months for trend/seasonality detection.
2. For recurring transactions (is_recurring=True) compute periodicity-adjusted
   monthly equivalents (e.g. yearly ÷ 12) — these replace the naive monthly mean
   for categories dominated by known periodic items.
3. For each category compute:
   - baseline_mean   : periodicity-corrected average monthly amount
   - seasonal_indices : ratio to 12-month mean (1.0 = no seasonality)
   - trend_slope     : CHF/month linear drift (via least-squares)
   - std_dev         : monthly volatility
4. Project: projected[t] = baseline * seasonal_indices[month_t] + trend * t
5. Confidence: projected ± 1.64 * std_dev  (≈90 %)
6. Outlier guard: monthly values > 3 × median are treated as exceptional transfers
   and capped at 2 × median before mean calculation, preventing one-off lump sums
   (e.g. tax payments, Revolut transfers) from skewing the forecast.
"""

from __future__ import annotations

import logging
import math
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select, func, extract, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Transaction, Account
from app.services.peer_group import get_peer_group_defaults, PeerGroupProfile
from app.services.currency_service import (
    currency_service,
    normalize_reference_currency,
    convert_with_eur_rates,
)

logger = logging.getLogger(__name__)

# Categories we always track (even if absent in history)
TRACKED_CATEGORIES = [
    "Wohnen",
    "Lebensmittel",
    "Transport",
    "Krankenkasse",
    "Restaurant",
    "Freizeit",
    "Kleider",
    "Reisen",
    "Bildung",
    "Abonnemente",
    "Kommunikation",
    "Einkommen",
    "Sparen",
    "Sonstiges",
]

# Map Swiss-German category names → peer-group expense keys
CATEGORY_TO_PEER_KEY: Dict[str, str] = {
    "Wohnen": "housing",
    "Lebensmittel": "groceries",
    "Transport": "transport",
    "Krankenkasse": "health_insurance",
    "Restaurant": "dining_out",
    "Freizeit": "entertainment",
    "Kleider": "clothing",
    "Reisen": "travel",
    "Bildung": "education",
    "Abonnemente": "subscriptions",
    "Kommunikation": "communication",
    "Sparen": "savings",
}

# How many times per month each periodicity fires
PERIODICITY_MONTHLY_FACTOR: Dict[str, float] = {
    "weekly":     52.0 / 12,   # ≈4.33
    "monthly":    1.0,
    "quarterly":  1.0 / 3,
    "halfyearly": 1.0 / 6,
    "yearly":     1.0 / 12,
}


# ── Low-level math helpers ────────────────────────────────────

def _linear_regression(x: List[float], y: List[float]) -> Tuple[float, float]:
    """Return (slope, intercept) from ordinary least squares."""
    n = len(x)
    if n < 2:
        return 0.0, (y[0] if y else 0.0)
    sx = sum(x)
    sy = sum(y)
    sxy = sum(xi * yi for xi, yi in zip(x, y))
    sxx = sum(xi ** 2 for xi in x)
    denom = n * sxx - sx ** 2
    if denom == 0:
        return 0.0, sy / n
    slope = (n * sxy - sx * sy) / denom
    intercept = (sy - slope * sx) / n
    return slope, intercept


def _std_dev(values: List[float]) -> float:
    """Population standard deviation."""
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    variance = sum((v - mean) ** 2 for v in values) / len(values)
    return math.sqrt(variance)


def _median(values: List[float]) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    n = len(s)
    mid = n // 2
    return (s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2)


def _trimmed_mean(values: List[float], cap_factor: float = 2.5) -> float:
    """
    Mean with outlier capping: values beyond cap_factor × median are capped.
    This prevents one-off lump sums (transfers, tax payments) from dominating
    the baseline forecast.
    """
    if not values:
        return 0.0
    if len(values) == 1:
        return values[0]
    med = _median(values)
    if med == 0:
        return sum(values) / len(values)
    cap = abs(med) * cap_factor
    # Only cap on the same side as the median (don't cap income with expense cap)
    if med < 0:
        capped = [max(v, -cap) for v in values]
    else:
        capped = [min(v, cap) for v in values]
    return sum(capped) / len(capped)


def _seasonal_indices(monthly_values: Dict[int, float]) -> Dict[int, float]:
    """
    Compute seasonal index per calendar month.
    Index 1.0 = average month; 1.2 = 20 % above average.
    """
    if not monthly_values:
        return {m: 1.0 for m in range(1, 13)}
    mean = sum(monthly_values.values()) / len(monthly_values)
    if mean == 0:
        return {m: 1.0 for m in range(1, 13)}
    indices: Dict[int, float] = {}
    for month in range(1, 13):
        indices[month] = monthly_values.get(month, mean) / mean
    return indices


# ── Main service class ────────────────────────────────────────

class PredictionEngine:
    """Stateless forecasting engine — instantiate once per application."""

    async def analyze(
        self,
        db: AsyncSession,
        user_id: int,
        account_ids: Optional[List[int]] = None,
        lookback_months: int = 12,
        reference_currency: str = "CHF",
    ) -> Dict[str, Any]:
        """
        Build a statistical profile from historical transactions.

        Returns a dict with keys:
          data_months                  : number of distinct months with data
          category_profiles            : {category: {mean, std, trend, seasonal_indices}}
          total_monthly_income_mean    : average monthly income (12-month trimmed)
          total_monthly_expense_mean   : average monthly expense (12-month trimmed, positive)
          first_date / last_date       : date range of analysed data
          recurring_monthly_equiv      : {category: monthly-equivalent CHF from recurring txns}
        """
        ref = normalize_reference_currency(reference_currency)
        rates = await currency_service.get_rates("EUR")
        rows_12 = await self._fetch_monthly_aggregates(
            db, user_id, account_ids, 12, rates, ref
        )
        rows_24 = await self._fetch_monthly_aggregates(
            db, user_id, account_ids, max(lookback_months, 24), rates, ref
        )
        recurring = await self._fetch_recurring_equivalents(
            db, user_id, account_ids, rates, ref
        )

        return self._build_profiles(rows_12, rows_24, recurring)

    async def generate_forecast(
        self,
        db: AsyncSession,
        user_id: int,
        horizon_months: int,
        account_ids: Optional[List[int]] = None,
        lookback_months: int = 12,
        peer_profile: Optional[Dict[str, str]] = None,
        include_peer_baseline: bool = True,
        reference_currency: str = "CHF",
    ) -> Dict[str, Any]:
        """
        Generate a monthly forecast for `horizon_months` into the future.

        Returns extended response including:
          peer_net_monthly        : flat peer-group monthly net (income − expenses)
          empirical_net_monthly   : empirical median savings (income × savings_rate)
        """
        ref = normalize_reference_currency(reference_currency)
        rates = await currency_service.get_rates("EUR")
        analysis = await self.analyze(
            db, user_id, account_ids, lookback_months, reference_currency=ref
        )
        peer_defaults: Dict[str, float] = {}

        if include_peer_baseline and peer_profile:
            try:
                pg = PeerGroupProfile(
                    age_group=peer_profile.get("age_group", "35-44"),       # type: ignore[arg-type]
                    canton=peer_profile.get("canton", "ZH"),
                    household_type=peer_profile.get("household_type", "single"),  # type: ignore[arg-type]
                    employment_status=peer_profile.get("employment_status", "employed"),  # type: ignore[arg-type]
                    income_level=peer_profile.get("income_level", "medium"),  # type: ignore[arg-type]
                )
                peer_defaults = get_peer_group_defaults(pg)
            except Exception as exc:
                logger.warning("Peer-group lookup failed: %s", exc)

        peer_net_monthly = convert_with_eur_rates(
            rates, _compute_peer_net(peer_defaults), "CHF", ref
        )
        empirical_net_monthly = convert_with_eur_rates(
            rates, _compute_empirical_net(peer_defaults), "CHF", ref
        )

        months: List[str] = []
        forecast_rows: List[Dict[str, Any]] = []

        now = datetime.now(timezone.utc)
        data_sparse = analysis["data_months"] < 3

        for step in range(1, horizon_months + 1):
            total_month = now.month + step - 1
            year_offset = total_month // 12
            target_month = (total_month % 12) + 1
            target_year = now.year + year_offset
            month_str = f"{target_year}-{target_month:02d}"
            months.append(month_str)

            cat_breakdown: Dict[str, Dict[str, float]] = {}
            predicted_expense = 0.0
            predicted_income = 0.0
            confidence_variance = 0.0
            calibrated = False

            for cat, profile in analysis["category_profiles"].items():
                mean: float = profile["mean"]
                std: float = profile["std"]
                slope: float = profile["trend_slope"]
                seasonal = profile["seasonal_indices"].get(target_month, 1.0)

                # Peer-group blending
                peer_amount = 0.0
                peer_key = CATEGORY_TO_PEER_KEY.get(cat)
                if peer_key and peer_key in peer_defaults:
                    peer_amount = convert_with_eur_rates(
                        rates, float(peer_defaults[peer_key]), "CHF", ref
                    )

                if data_sparse and peer_amount:
                    blended_mean = 0.3 * mean + 0.7 * peer_amount
                    calibrated = True
                elif peer_amount and include_peer_baseline:
                    blended_mean = 0.9 * mean + 0.1 * peer_amount
                    calibrated = True
                else:
                    blended_mean = mean
                    calibrated = data_sparse

                projected = (blended_mean + slope * step) * seasonal
                low = projected - 1.64 * std
                high = projected + 1.64 * std

                cat_breakdown[cat] = {
                    "predicted": round(projected, 2),
                    "confidence_low": round(low, 2),
                    "confidence_high": round(high, 2),
                }

                if projected < 0:
                    predicted_expense += abs(projected)
                else:
                    predicted_income += projected

                confidence_variance += std ** 2

            net_std = math.sqrt(confidence_variance) if confidence_variance > 0 else 0.0
            net = predicted_income - predicted_expense

            forecast_rows.append({
                "month": month_str,
                "predicted_income": round(predicted_income, 2),
                "predicted_expense": round(predicted_expense, 2),
                "net": round(net, 2),
                "confidence_low": round(net - 1.64 * net_std, 2),
                "confidence_high": round(net + 1.64 * net_std, 2),
                "category_breakdown": cat_breakdown,
                "peer_calibrated": calibrated,
            })

        return {
            "months": months,
            "forecast": forecast_rows,
            "analysis": analysis,
            "peer_net_monthly": round(peer_net_monthly, 2),
            "empirical_net_monthly": round(empirical_net_monthly, 2),
        }

    # ── Private helpers ───────────────────────────────────────

    async def _fetch_monthly_aggregates(
        self,
        db: AsyncSession,
        user_id: int,
        account_ids: Optional[List[int]],
        lookback_months: int,
        rates: Dict[str, float],
        ref_currency: str,
    ) -> List[Dict[str, Any]]:
        """SUM(amount) per (year, month, category), converted to reference currency."""
        account_subq = (
            select(Account.id)
            .where(Account.user_id == user_id, Account.is_active.is_(True))
        )
        if account_ids:
            account_subq = account_subq.where(Account.id.in_(account_ids))

        now = datetime.now(timezone.utc)
        cutoff_month = now.month - (lookback_months % 12)
        cutoff_year = now.year - (lookback_months // 12)
        if cutoff_month <= 0:
            cutoff_month += 12
            cutoff_year -= 1
        from datetime import datetime as dt
        cutoff = dt(cutoff_year, cutoff_month, 1, tzinfo=timezone.utc)

        stmt = (
            select(Transaction.date, Transaction.category, Transaction.amount, Account.currency)
            .join(Account)
            .where(
                Transaction.account_id.in_(account_subq),
                Transaction.is_deleted.isnot(True),
                Transaction.date >= cutoff,
            )
        )

        result = await db.execute(stmt)
        buckets: Dict[tuple, Dict[str, Any]] = {}
        for row in result.all():
            d = row.date
            y, mo = int(d.year), int(d.month)
            cat = row.category or "Sonstiges"
            cur = (row.currency or "CHF").strip().upper()
            conv = convert_with_eur_rates(rates, float(row.amount), cur, ref_currency)
            key = (y, mo, cat)
            if key not in buckets:
                buckets[key] = {
                    "year": y,
                    "month": mo,
                    "category": cat,
                    "total": 0.0,
                    "count": 0,
                }
            buckets[key]["total"] += conv
            buckets[key]["count"] += 1

        return sorted(buckets.values(), key=lambda x: (x["year"], x["month"]))

    async def _fetch_recurring_equivalents(
        self,
        db: AsyncSession,
        user_id: int,
        account_ids: Optional[List[int]],
        rates: Dict[str, float],
        ref_currency: str,
    ) -> Dict[str, float]:
        """
        Recurring transactions (last 12 months) → {category: monthly_equivalent}
        in reference currency.
        """
        account_subq = (
            select(Account.id)
            .where(Account.user_id == user_id, Account.is_active.is_(True))
        )
        if account_ids:
            account_subq = account_subq.where(Account.id.in_(account_ids))

        now = datetime.now(timezone.utc)
        from datetime import datetime as dt
        cutoff_year  = now.year - 1
        cutoff_month = now.month
        cutoff = dt(cutoff_year, cutoff_month, 1, tzinfo=timezone.utc)

        stmt = (
            select(
                Transaction.amount,
                Transaction.category,
                Transaction.periodicity,
                Account.currency,
            )
            .join(Account)
            .where(
                Transaction.account_id.in_(account_subq),
                Transaction.is_deleted.isnot(True),
                Transaction.is_recurring.is_(True),
                Transaction.date >= cutoff,
            )
        )

        result = await db.execute(stmt)
        groups: Dict[tuple, List[float]] = defaultdict(list)
        for r in result.all():
            cur = (r.currency or "CHF").strip().upper()
            conv = convert_with_eur_rates(rates, float(r.amount), cur, ref_currency)
            groups[(r.category or "Sonstiges", r.periodicity or "monthly")].append(conv)

        monthly_by_cat: Dict[str, float] = defaultdict(float)
        for (cat, per), amounts in groups.items():
            avg_amt = sum(amounts) / len(amounts)
            factor = PERIODICITY_MONTHLY_FACTOR.get(per, 1.0)
            monthly_by_cat[cat] += avg_amt * factor

        return dict(monthly_by_cat)

    def _build_profiles(
        self,
        rows_12: List[Dict[str, Any]],
        rows_24: List[Dict[str, Any]],
        recurring: Dict[str, float],
    ) -> Dict[str, Any]:
        """
        Build statistical profiles per category.

        - Baseline mean : from last 12 months with outlier capping.
          If a category has substantial recurring data, the periodicity-adjusted
          recurring equivalent overrides the naive mean for that category.
        - Trend / seasonality : derived from the longer (≤24-month) series.
        """
        if not rows_12 and not rows_24:
            return {
                "data_months": 0,
                "category_profiles": {},
                "total_monthly_income_mean": 0.0,
                "total_monthly_expense_mean": 0.0,
                "first_date": None,
                "last_date": None,
                "recurring_monthly_equiv": {},
            }

        # ── 12-month window: compute means ───────────────────
        months_set_12: set = set()
        cat_monthly_12: Dict[str, Dict[int, float]] = defaultdict(dict)

        for r in rows_12:
            ym = (r["year"], r["month"])
            months_set_12.add(ym)
            cat_monthly_12[r["category"]][(r["year"], r["month"])] = r["total"]

        data_months = len(months_set_12)

        # Monthly income / expense totals (12-month)
        monthly_income_12: Dict[tuple, float] = defaultdict(float)
        monthly_expense_12: Dict[tuple, float] = defaultdict(float)
        for r in rows_12:
            ym = (r["year"], r["month"])
            if r["total"] > 0:
                monthly_income_12[ym]  += r["total"]
            else:
                monthly_expense_12[ym] += abs(r["total"])

        total_income_mean  = _trimmed_mean(list(monthly_income_12.values()))
        total_expense_mean = _trimmed_mean(list(monthly_expense_12.values()))

        # ── 24-month window: derive trend + seasonality ──────
        months_set_24: set = set()
        cat_series_24: Dict[str, List[Tuple[int, float]]] = defaultdict(list)
        cat_monthly_cal_24: Dict[str, Dict[int, List[float]]] = defaultdict(lambda: defaultdict(list))

        month_keys_24 = sorted({(r["year"], r["month"]) for r in rows_24})
        month_idx_24  = {ym: i for i, ym in enumerate(month_keys_24)}

        for r in rows_24:
            ym = (r["year"], r["month"])
            months_set_24.add(ym)
            cat_series_24[r["category"]].append((month_idx_24[ym], r["total"]))
            cat_monthly_cal_24[r["category"]][r["month"]].append(r["total"])

        # Collect all categories from both windows
        all_cats = set(cat_monthly_12.keys()) | set(cat_series_24.keys())

        # ── Build profiles ───────────────────────────────────
        profiles: Dict[str, Dict[str, Any]] = {}

        for cat in all_cats:
            # Baseline mean: from 12-month window with outlier trimming
            monthly_vals_12 = list(cat_monthly_12.get(cat, {}).values())

            # Pad missing months with zero so sparse categories (e.g. quarterly
            # expenses that didn't fire in every month) get correct monthly avg.
            if monthly_vals_12:
                n_months = max(len(months_set_12), 1)
                padded = monthly_vals_12 + [0.0] * max(0, n_months - len(monthly_vals_12))
                raw_mean = _trimmed_mean(padded)
            else:
                raw_mean = 0.0

            # Override with periodicity-adjusted recurring equivalent when available
            # and when it represents > 40 % of the raw mean magnitude.
            recur_equiv = recurring.get(cat, None)
            if recur_equiv is not None:
                if raw_mean == 0 or (abs(recur_equiv) / max(abs(raw_mean), 1)) >= 0.4:
                    # Use recurring equivalent as the baseline
                    mean_val = recur_equiv
                else:
                    # Blend: 60 % recurring equivalent, 40 % historical mean
                    mean_val = 0.6 * recur_equiv + 0.4 * raw_mean
            else:
                mean_val = raw_mean

            # Standard deviation from 12-month window
            std_val = _std_dev(monthly_vals_12) if monthly_vals_12 else 0.0

            # Trend from 24-month series (linear regression → CHF/month drift)
            # Formula: projected[t] = (baseline_mean + slope × t) × seasonal_index[month_t]
            # where t = 1…horizon_months (step in the forecast loop).
            series_24 = cat_series_24.get(cat, [])
            if len(series_24) >= 3:
                indices = [float(i) for i, _ in series_24]
                amounts = [a for _, a in series_24]
                slope, _ = _linear_regression(indices, amounts)
                # Cap trend to ±3 % of baseline per year so fixed / periodic costs
                # (taxes, insurance, rent) don't drift unboundedly.  A genuine 3 %
                # annual increase in e.g. Krankenkasse premia is still fully captured.
                if mean_val != 0:
                    max_monthly_drift = abs(mean_val) * 0.03 / 12
                    slope = max(-max_monthly_drift, min(slope, max_monthly_drift))
            else:
                slope = 0.0

            # Seasonality from 24-month calendar averages
            cal_24 = cat_monthly_cal_24.get(cat, {})
            seasonal_input: Dict[int, float] = {}
            for cal_month, vals in cal_24.items():
                seasonal_input[cal_month] = sum(vals) / len(vals)
            s_indices = _seasonal_indices(seasonal_input)

            profiles[cat] = {
                "mean": round(mean_val, 2),
                "std":  round(std_val, 2),
                "trend_slope": round(slope, 4),
                "seasonal_indices": {str(k): round(v, 4) for k, v in s_indices.items()},
                "data_points": len(monthly_vals_12),
                "recurring_override": recur_equiv is not None,
            }

        # Date range from 24-month window
        rows_any = rows_24 or rows_12
        if rows_any:
            ym_min = min((r["year"], r["month"]) for r in rows_any)
            ym_max = max((r["year"], r["month"]) for r in rows_any)
            first_date = f"{ym_min[0]}-{ym_min[1]:02d}"
            last_date  = f"{ym_max[0]}-{ym_max[1]:02d}"
        else:
            first_date = last_date = None

        return {
            "data_months": data_months,
            "category_profiles": profiles,
            "total_monthly_income_mean":  round(total_income_mean,  2),
            "total_monthly_expense_mean": round(total_expense_mean, 2),
            "first_date": first_date,
            "last_date":  last_date,
            "recurring_monthly_equiv": recurring,
        }


# ── Peer / empirical reference line helpers ───────────────────

def _compute_peer_net(peer_defaults: Dict[str, Any]) -> float:
    """
    Monthly net for the peer group:
      income_median − sum(all expense categories) − direct_taxes/12
    """
    if not peer_defaults:
        return 0.0
    income = float(peer_defaults.get("incomeMedian", 0))
    expense_keys = [
        "housing", "groceries", "transport", "health_insurance",
        "other_insurance", "communication", "dining_out", "entertainment",
        "clothing", "travel", "education", "subscriptions",
    ]
    expenses = sum(float(peer_defaults.get(k, 0)) for k in expense_keys)
    # direct_taxes is already monthly in peer_defaults (it's an annual estimate ÷ 12 internally)
    taxes = float(peer_defaults.get("direct_taxes", 0))
    return income - expenses - taxes


def _compute_empirical_net(peer_defaults: Dict[str, Any]) -> float:
    """
    Empirical Swiss median net = income_median × savings_rate (BFS HABE).
    Uses the savings_rate percentage stored in peer_defaults.
    """
    if not peer_defaults:
        return 0.0
    income = float(peer_defaults.get("incomeMedian", 0))
    rate = float(peer_defaults.get("savings_rate", 0)) / 100.0
    return income * rate


# ── Module-level singleton ────────────────────────────────────
prediction_engine = PredictionEngine()
