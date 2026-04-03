"""
Prediction Engine — Time-series forecasting for budget-pal.

Combines:
  A. Historical transaction analysis (seasonality, trend, stability)
  B. Peer-group calibration (Swiss BFS HABE defaults) for sparse data
  C. Forward projection (N months) with confidence intervals

Algorithm overview
------------------
1. Aggregate transactions by (year-month, category) for the user.
2. For each top-level category compute:
   - seasonal_indices[month]  : ratio to 12-month mean (1.0 = no seasonality)
   - trend_slope              : CHF/month linear drift (via least-squares)
   - std_dev                  : monthly volatility (stability measure)
3. Project forward: projected[t] = baseline * seasonal_indices[month_t] + trend * t
4. Confidence interval: projected ± 1.64 * std_dev  (≈90 % interval)
5. If < 3 months of history → overlay peer-group defaults as baseline.
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

# Map Swiss-German category names used by categorization_service → peer-group keys
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


def _seasonal_indices(monthly_values: Dict[int, float]) -> Dict[int, float]:
    """
    Compute seasonal index per calendar month.
    Index 1.0 means 'average month'; 1.2 means 20 % above average.
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
    """Stateless forecasting engine — instantiate per request."""

    async def analyze(
        self,
        db: AsyncSession,
        user_id: int,
        account_ids: Optional[List[int]] = None,
        lookback_months: int = 24,
    ) -> Dict[str, Any]:
        """
        Build a statistical profile from historical transactions.

        Returns a dict with keys:
          data_months        : number of distinct months with data
          category_profiles  : {category: {mean, std, trend, seasonal_indices}}
          total_monthly_income_mean  : average monthly income
          total_monthly_expense_mean : average monthly expense (positive number)
          first_date / last_date     : date range of analysed data
        """
        rows = await self._fetch_monthly_aggregates(db, user_id, account_ids, lookback_months)
        return self._build_profiles(rows)

    async def generate_forecast(
        self,
        db: AsyncSession,
        user_id: int,
        horizon_months: int,
        account_ids: Optional[List[int]] = None,
        lookback_months: int = 24,
        peer_profile: Optional[Dict[str, str]] = None,
        include_peer_baseline: bool = True,
    ) -> Dict[str, Any]:
        """
        Generate a monthly forecast for `horizon_months` into the future.

        Returns:
          {
            "months": ["2026-05", ...],           # ISO year-month strings
            "forecast": [
              {
                "month": "2026-05",
                "predicted_income":   6200.0,
                "predicted_expense":  4100.0,
                "net":                2100.0,
                "confidence_low":     1600.0,   # net lower bound
                "confidence_high":    2600.0,   # net upper bound
                "category_breakdown": {
                  "Wohnen":     {"predicted": 1800, "confidence_low": 1700, "confidence_high": 1900},
                  ...
                },
                "peer_calibrated": True,        # True when peer-group data was blended
              },
              ...
            ],
            "analysis": { ... }   # from analyze()
          }
        """
        analysis = await self.analyze(db, user_id, account_ids, lookback_months)
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

        months: List[str] = []
        forecast_rows: List[Dict[str, Any]] = []

        now = datetime.now(timezone.utc)
        data_sparse = analysis["data_months"] < 3

        for step in range(1, horizon_months + 1):
            # Compute target month
            total_month = now.month + step - 1
            year_offset = total_month // 12
            target_month = (total_month % 12) + 1
            target_year = now.year + year_offset
            month_str = f"{target_year}-{target_month:02d}"
            months.append(month_str)

            cat_breakdown: Dict[str, Dict[str, float]] = {}
            predicted_expense = 0.0
            predicted_income = 0.0
            confidence_variance = 0.0   # accumulates variance for net

            for cat, profile in analysis["category_profiles"].items():
                mean: float = profile["mean"]
                std: float = profile["std"]
                slope: float = profile["trend_slope"]
                seasonal = profile["seasonal_indices"].get(target_month, 1.0)

                # Blend with peer-group when data is sparse
                peer_amount = 0.0
                peer_key = CATEGORY_TO_PEER_KEY.get(cat)
                if peer_key and peer_key in peer_defaults:
                    peer_amount = peer_defaults[peer_key]

                if data_sparse and peer_amount:
                    # Weighted blend: 70 % peer, 30 % history
                    blend = 0.3
                    blended_mean = blend * mean + (1 - blend) * peer_amount
                    calibrated = True
                elif peer_amount and include_peer_baseline:
                    # Light calibration even for data-rich scenarios: 10 % peer anchor
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

                # Separate income vs expense
                if projected < 0:
                    predicted_expense += abs(projected)
                else:
                    predicted_income += projected

                confidence_variance += std ** 2

            # Net confidence interval (independent categories → add variances)
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
        }

    # ── Private helpers ───────────────────────────────────────

    async def _fetch_monthly_aggregates(
        self,
        db: AsyncSession,
        user_id: int,
        account_ids: Optional[List[int]],
        lookback_months: int,
    ) -> List[Dict[str, Any]]:
        """
        Run a single SQL aggregation: SUM(amount) per (year, month, category)
        over the past `lookback_months` for the given user.
        """
        # Build account filter
        account_subq = (
            select(Account.id)
            .where(Account.user_id == user_id, Account.is_active.is_(True))
        )
        if account_ids:
            account_subq = account_subq.where(Account.id.in_(account_ids))

        cutoff = datetime(
            datetime.now().year,
            datetime.now().month,
            1,
            tzinfo=timezone.utc,
        )
        # Subtract lookback_months
        cutoff_month = cutoff.month - (lookback_months % 12)
        cutoff_year = cutoff.year - (lookback_months // 12)
        if cutoff_month <= 0:
            cutoff_month += 12
            cutoff_year -= 1
        from datetime import datetime as dt
        cutoff = dt(cutoff_year, cutoff_month, 1, tzinfo=timezone.utc)

        stmt = (
            select(
                extract("year", Transaction.date).label("year"),
                extract("month", Transaction.date).label("month"),
                Transaction.category.label("category"),
                func.sum(Transaction.amount).label("total"),
                func.count(Transaction.id).label("count"),
            )
            .where(
                Transaction.account_id.in_(account_subq),
                Transaction.is_deleted.isnot(True),
                Transaction.date >= cutoff,
            )
            .group_by(
                extract("year", Transaction.date),
                extract("month", Transaction.date),
                Transaction.category,
            )
            .order_by(
                extract("year", Transaction.date),
                extract("month", Transaction.date),
            )
        )

        result = await db.execute(stmt)
        rows = result.fetchall()

        return [
            {
                "year": int(r.year),
                "month": int(r.month),
                "category": r.category or "Sonstiges",
                "total": float(r.total),
                "count": int(r.count),
            }
            for r in rows
        ]

    def _build_profiles(self, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        From aggregated DB rows, build statistical profiles per category.
        """
        if not rows:
            return {
                "data_months": 0,
                "category_profiles": {},
                "total_monthly_income_mean": 0.0,
                "total_monthly_expense_mean": 0.0,
                "first_date": None,
                "last_date": None,
            }

        # Group by (year, month) first to count distinct months
        months_set: set[Tuple[int, int]] = set()
        # category -> list of (period_index, amount)
        cat_series: Dict[str, List[Tuple[int, float]]] = defaultdict(list)
        # category -> {calendar_month -> [amounts]}
        cat_monthly: Dict[str, Dict[int, List[float]]] = defaultdict(lambda: defaultdict(list))

        # Create a stable period index (0, 1, 2, ...) per year-month
        month_keys = sorted({(r["year"], r["month"]) for r in rows})
        month_idx = {ym: i for i, ym in enumerate(month_keys)}

        for r in rows:
            ym = (r["year"], r["month"])
            months_set.add(ym)
            cat_series[r["category"]].append((month_idx[ym], r["total"]))
            cat_monthly[r["category"]][r["month"]].append(r["total"])

        data_months = len(months_set)

        # Also aggregate total income / expense per month
        monthly_income: Dict[Tuple[int, int], float] = defaultdict(float)
        monthly_expense: Dict[Tuple[int, int], float] = defaultdict(float)
        for r in rows:
            ym = (r["year"], r["month"])
            if r["total"] > 0:
                monthly_income[ym] += r["total"]
            else:
                monthly_expense[ym] += abs(r["total"])

        total_income_mean = (
            sum(monthly_income.values()) / len(monthly_income) if monthly_income else 0.0
        )
        total_expense_mean = (
            sum(monthly_expense.values()) / len(monthly_expense) if monthly_expense else 0.0
        )

        # Build per-category profiles
        profiles: Dict[str, Dict[str, Any]] = {}
        for cat, series in cat_series.items():
            amounts = [a for _, a in series]
            indices = [float(i) for i, _ in series]
            mean_val = sum(amounts) / len(amounts)
            std_val = _std_dev(amounts)
            slope, _ = _linear_regression(indices, amounts)

            # Seasonal: average amount per calendar month
            seasonal_input: Dict[int, float] = {}
            for cal_month, vals in cat_monthly[cat].items():
                seasonal_input[cal_month] = sum(vals) / len(vals)
            s_indices = _seasonal_indices(seasonal_input)

            profiles[cat] = {
                "mean": round(mean_val, 2),
                "std": round(std_val, 2),
                "trend_slope": round(slope, 4),
                "seasonal_indices": {str(k): round(v, 4) for k, v in s_indices.items()},
                "data_points": len(series),
            }

        if month_keys:
            first_ym = month_keys[0]
            last_ym = month_keys[-1]
            first_date = f"{first_ym[0]}-{first_ym[1]:02d}"
            last_date = f"{last_ym[0]}-{last_ym[1]:02d}"
        else:
            first_date = last_date = None

        return {
            "data_months": data_months,
            "category_profiles": profiles,
            "total_monthly_income_mean": round(total_income_mean, 2),
            "total_monthly_expense_mean": round(total_expense_mean, 2),
            "first_date": first_date,
            "last_date": last_date,
        }


# ── Module-level singleton ────────────────────────────────────
prediction_engine = PredictionEngine()
