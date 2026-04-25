"""
Anomaly Detector — scans recent transactions and returns a list of findings.

Findings types:
  - unusually_large   : single transaction > μ + 2σ for its category
  - new_subscription  : recurring merchant not seen before previous 60 days
  - price_change      : recurring merchant whose avg changed > 15%
  - missing_salary    : no income transaction in current month (after day 10)
  - large_cash        : cash/ATM withdrawal > 500 CHF

All monetary comparisons are in the user's reference currency.
"""
from __future__ import annotations

import statistics
from datetime import date, datetime, timezone, timedelta
from typing import List, Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, extract, func

from app.models.models import Transaction, Account, User
from app.services.currency_service import currency_service, convert_with_eur_rates, normalize_reference_currency


# ── Dataclass-like result ─────────────────────────────────────

class AnomalyFinding:
    __slots__ = ("type", "severity", "title", "body", "transaction_id", "amount", "currency")

    def __init__(
        self,
        type: str,
        severity: str,        # "info" | "warning" | "alert"
        title: str,
        body: str,
        transaction_id: Optional[int] = None,
        amount: Optional[float] = None,
        currency: Optional[str] = None,
    ):
        self.type = type
        self.severity = severity
        self.title = title
        self.body = body
        self.transaction_id = transaction_id
        self.amount = amount
        self.currency = currency

    def to_dict(self) -> dict:
        return {
            "type": self.type,
            "severity": self.severity,
            "title": self.title,
            "body": self.body,
            "transaction_id": self.transaction_id,
            "amount": self.amount,
            "currency": self.currency,
        }


async def detect(
    user: User,
    db: AsyncSession,
    *,
    lookback_days: int = 90,
    recent_days: int = 30,
) -> List[AnomalyFinding]:
    """Run all detectors and return findings, most severe first."""
    ref = normalize_reference_currency(user.currency)
    rates = await currency_service.get_rates()
    today = date.today()
    cutoff = today - timedelta(days=lookback_days)
    recent_cutoff = today - timedelta(days=recent_days)

    # Load transactions for the lookback window
    rows = (await db.execute(
        select(Transaction)
        .join(Account, Transaction.account_id == Account.id)
        .where(
            Account.user_id == user.id,
            Transaction.is_deleted.isnot(True),
            Transaction.is_transfer.isnot(True),
            Transaction.date >= datetime.combine(cutoff, datetime.min.time(), tzinfo=timezone.utc),
        )
        .order_by(Transaction.date.desc())
    )).scalars().all()

    findings: List[AnomalyFinding] = []

    findings += _detect_unusually_large(rows, ref, rates, recent_cutoff)
    findings += _detect_new_subscriptions(rows, ref, rates, recent_cutoff, lookback_days)
    findings += _detect_price_changes(rows, ref, rates, recent_cutoff)
    findings += _detect_missing_salary(rows, ref, rates, today)
    findings += _detect_large_cash(rows, ref, rates, recent_cutoff)

    # Sort: alert > warning > info
    order = {"alert": 0, "warning": 1, "info": 2}
    findings.sort(key=lambda f: order.get(f.severity, 9))
    return findings


def _ref_amount(txn: Transaction, ref: str, rates: dict) -> float:
    ccy = (txn.currency or "CHF").strip().upper()
    return convert_with_eur_rates(rates, txn.amount, ccy, ref)


# ── Individual detectors ──────────────────────────────────────

def _detect_unusually_large(rows, ref, rates, recent_cutoff) -> List[AnomalyFinding]:
    """Flag transactions where |amount| > category mean + 2σ."""
    from collections import defaultdict

    # Build per-category distributions from older transactions
    cat_amounts: dict[str, list[float]] = defaultdict(list)
    for t in rows:
        if t.date.date() > recent_cutoff:
            continue  # exclude recent from baseline
        if t.amount >= 0:
            continue  # income — skip
        cat = (t.category or "Unkategorisiert").lower()
        cat_amounts[cat].append(abs(_ref_amount(t, ref, rates)))

    findings = []
    for t in rows:
        if t.date.date() <= recent_cutoff:
            continue
        if t.amount >= 0:
            continue
        cat = (t.category or "Unkategorisiert").lower()
        vals = cat_amounts.get(cat, [])
        if len(vals) < 4:
            continue
        mu = statistics.mean(vals)
        sigma = statistics.stdev(vals)
        amt = abs(_ref_amount(t, ref, rates))
        if sigma > 0 and amt > mu + 2 * sigma:
            findings.append(AnomalyFinding(
                type="unusually_large",
                severity="warning",
                title=f"Ungewöhnlich hohe Ausgabe: {t.merchant_normalized or t.description}",
                body=(
                    f"{ref} {amt:,.2f} — über {(amt - mu) / sigma:.1f}σ vom Kategoriedurchschnitt "
                    f"({t.category or 'Unkategorisiert'}, Ø {ref} {mu:,.2f})"
                ),
                transaction_id=t.id,
                amount=round(amt, 2),
                currency=ref,
            ))
    return findings[:5]  # cap at 5


def _detect_new_subscriptions(rows, ref, rates, recent_cutoff, lookback_days) -> List[AnomalyFinding]:
    """Detect recurring-tagged transactions from merchants not seen before recent window."""
    old_merchants: set[str] = set()
    new_merchants: dict[str, Transaction] = {}

    for t in rows:
        key = (t.merchant_normalized or t.description or "").lower().strip()
        if not key or not t.is_recurring:
            continue
        if t.date.date() <= recent_cutoff:
            old_merchants.add(key)
        else:
            if key not in new_merchants:
                new_merchants[key] = t

    findings = []
    for key, t in new_merchants.items():
        if key not in old_merchants:
            amt = abs(_ref_amount(t, ref, rates))
            findings.append(AnomalyFinding(
                type="new_subscription",
                severity="info",
                title=f"Neues Abonnement: {t.merchant_normalized or t.description}",
                body=f"Erstmals als wiederkehrend erkannt — {ref} {amt:,.2f}",
                transaction_id=t.id,
                amount=round(amt, 2),
                currency=ref,
            ))
    return findings[:3]


def _detect_price_changes(rows, ref, rates, recent_cutoff) -> List[AnomalyFinding]:
    """Detect recurring merchants whose average amount changed > 15%."""
    from collections import defaultdict

    old_avgs: dict[str, float] = {}
    old_vals: dict[str, list[float]] = defaultdict(list)
    new_vals: dict[str, list[float]] = defaultdict(list)
    new_txns: dict[str, Transaction] = {}

    for t in rows:
        if not t.is_recurring or t.amount >= 0:
            continue
        key = (t.merchant_normalized or t.description or "").lower().strip()
        if not key:
            continue
        amt = abs(_ref_amount(t, ref, rates))
        if t.date.date() <= recent_cutoff:
            old_vals[key].append(amt)
        else:
            new_vals[key].append(amt)
            new_txns[key] = t

    findings = []
    for key, new_list in new_vals.items():
        old_list = old_vals.get(key)
        if not old_list or not new_list:
            continue
        old_avg = statistics.mean(old_list)
        new_avg = statistics.mean(new_list)
        if old_avg == 0:
            continue
        change_pct = (new_avg - old_avg) / old_avg * 100
        if abs(change_pct) > 15:
            t = new_txns[key]
            direction = "gestiegen" if change_pct > 0 else "gesunken"
            findings.append(AnomalyFinding(
                type="price_change",
                severity="warning" if change_pct > 0 else "info",
                title=f"Preisänderung: {t.merchant_normalized or t.description}",
                body=(
                    f"Betrag {direction} um {abs(change_pct):.1f}% "
                    f"(Ø vorher {ref} {old_avg:,.2f} → jetzt {ref} {new_avg:,.2f})"
                ),
                transaction_id=t.id,
                amount=round(new_avg, 2),
                currency=ref,
            ))
    return findings[:3]


def _detect_missing_salary(rows, ref, rates, today: date) -> List[AnomalyFinding]:
    """If it's after the 10th of the month and no income > 500 in current month, flag it."""
    if today.day < 10:
        return []

    current_month_income = [
        t for t in rows
        if t.date.date().year == today.year
        and t.date.date().month == today.month
        and t.amount > 0
        and abs(_ref_amount(t, ref, rates)) > 500
    ]
    if not current_month_income:
        return [AnomalyFinding(
            type="missing_salary",
            severity="alert",
            title="Kein Lohneingang erkannt",
            body=f"Bislang kein Einkommenseingang > {ref} 500 in diesem Monat.",
        )]
    return []


def _detect_large_cash(rows, ref, rates, recent_cutoff) -> List[AnomalyFinding]:
    """Flag ATM/cash withdrawals > 500 CHF equivalent in recent window."""
    KEYWORDS = {"atm", "bancomat", "cash", "bargeld", "abhebung", "geldautomat"}
    findings = []
    for t in rows:
        if t.date.date() <= recent_cutoff or t.amount >= 0:
            continue
        desc = (t.merchant_normalized or t.description or "").lower()
        if not any(k in desc for k in KEYWORDS):
            continue
        amt = abs(_ref_amount(t, ref, rates))
        if amt > 500:
            findings.append(AnomalyFinding(
                type="large_cash",
                severity="info",
                title=f"Grosse Bargeldbehebung: {t.merchant_normalized or t.description}",
                body=f"{ref} {amt:,.2f} — Bargeldtransaktion",
                transaction_id=t.id,
                amount=round(amt, 2),
                currency=ref,
            ))
    return findings[:2]
