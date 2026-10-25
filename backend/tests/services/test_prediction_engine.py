"""Budgetprognose: Reale und Empirische Angaben bleiben zwei getrennte Sichten."""
from datetime import datetime, timezone

import pytest

from app.models.models import Budget, BudgetPeriod, Scenario, Transaction
from app.services import prediction_engine as pe


def _months_ago(n: int) -> datetime:
    now = datetime.now(timezone.utc)
    y, m = now.year, now.month - n
    while m <= 0:
        m += 12
        y -= 1
    return datetime(y, m, 10, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _no_fx(monkeypatch):
    async def rates(_base):
        return {}
    monkeypatch.setattr(pe.currency_service, "get_rates", rates)


async def _forecast(db, user, basis):
    out = await pe.prediction_engine.generate_forecast(
        db, user.id, horizon_months=1, basis=basis
    )
    return out["forecast"][0]


async def test_actual_and_empirical_forecasts_stay_apart(db_session, test_user, test_account):
    def txn(n, amount, category, **kw):
        return Transaction(account_id=test_account.id, date=_months_ago(n),
                           description=category, amount=amount, category=category, **kw)

    for n in (1, 2):
        db_session.add_all([
            txn(n, 5000, "Gehalt"),
            txn(n, -1200, "Lebensmittel"),
            txn(n, -3000, "Kontoübertrag", is_transfer=True),
            txn(n, -900, "Lebensmittel", is_ignored=True),
            txn(n, -2000, "Investitionen"),
        ])
    db_session.add(txn(0, -700, "Lebensmittel"))  # laufender Monat, unvollständig

    ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for notes, amount in (("Miete", 2000), ("Lebensmittel", 600)):
        db_session.add(Budget(user_id=test_user.id, amount=amount, notes=notes,
                              period=BudgetPeriod.monthly, year=2026, created_at=ts))
    db_session.add(Scenario(user_id=test_user.id, name="Wizard",
                            parameters_json={"wizard_onboarding": True, "monthly_income": 6000}))
    await db_session.flush()

    actual = await _forecast(db_session, test_user, "actual")
    assert (actual["predicted_income"], actual["predicted_expense"]) == (5000, 1200)
    assert "Miete" not in actual["category_breakdown"]
    assert not actual["peer_calibrated"]

    empirical = await _forecast(db_session, test_user, "empirical")
    assert (empirical["predicted_income"], empirical["predicted_expense"]) == (6000, 2600)
    assert "Gehalt" not in empirical["category_breakdown"]
    assert empirical["confidence_low"] == empirical["confidence_high"] == 3400


def test_quarterly_bill_is_seasonal_not_monthly():
    rows = [
        {"year": 2025, "month": m, "category": cat, "total": total, "count": 1}
        for m in range(1, 13)
        for cat, total in [("Gehalt", 5000)] + ([("Steuern", -900)] if m % 3 == 1 else [])
    ]
    prof = pe.prediction_engine._build_profiles(rows, rows, {})["category_profiles"]["Steuern"]
    assert prof["mean"] == pytest.approx(-300)
    assert prof["seasonal_indices"]["1"] == pytest.approx(3.0)
    assert prof["seasonal_indices"]["2"] == pytest.approx(0.0)
