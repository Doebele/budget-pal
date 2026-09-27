"""Schritt 7: monatliches Einkommen ab frei gewaehltem Rentenalter mit Fonds-Entnahmeplan."""
from datetime import datetime

import pytest

from app.services.projection import ProjectionService

SERVICE = ProjectionService()
RECORDS = [
    {"pillar": "1", "contribution_years": 44, "average_insured_salary": 100_000},
    {"pillar": "2", "current_balance": 400_000, "annual_contribution": 0,
     "expected_return_rate": 0.0, "capital_share": 1.0, "provider": "PK"},
    {"pillar": "3b", "current_balance": 100_000, "withdrawal_age": 67, "expected_return_rate": 0.0},
]


def _plan(**kw):
    base = dict(
        current_net_worth=0, annual_savings=0, annual_income=100_000, years=35,
        mean_return=0.0, volatility=0.0, inflation_rate=0.0, pension_records=RECORDS,
        date_of_birth=f"{datetime.now().year - 60}-06-01", retirement_age=63, runs=10,
        retirement_spending=0.0, fund_return=0.0, payout_until_age=90, include_wealth=False,
        tax_in_retirement=False,
    )
    base.update(kw)
    return SERVICE.income_plan(**base)


def test_capital_is_paid_out_evenly_until_the_chosen_age():
    plan = _plan()
    rows = {r["age"]: r for r in plan["rows"]}
    total = sum(i["amount"] for i in plan["fund_inflows"]) + plan["fund_start"]
    assert rows[63]["fund"] == pytest.approx(total / 28 / 12)       # 63 bis und mit 90
    assert rows[80]["fund"] == pytest.approx(rows[63]["fund"])
    assert rows[91]["fund"] == 0.0
    assert rows[90]["fund_balance"] == pytest.approx(rows[63]["fund"] * 12, rel=1e-6)


def test_later_capital_flows_into_the_fund():
    plan = _plan()
    rows = {r["age"]: r for r in plan["rows"]}
    assert [i["age"] for i in plan["fund_inflows"]] == [63, 67]
    assert rows[67]["fund_balance"] > rows[66]["fund_balance"]


def test_yield_only_keeps_the_capital():
    plan = _plan(fund_return=0.04, payout_until_age=None)
    first, last = plan["rows"][0], plan["rows"][-1]
    assert last["fund_balance"] >= first["fund_balance"]


def test_not_indexed_loses_real_value():
    plan = _plan(inflation_rate=0.02, fund_return=0.02, indexed=False)
    assert plan["rows"][10]["fund"] < plan["rows"][0]["fund"]


def test_earlier_retirement_means_less_ahv():
    early, normal = _plan(retirement_age=60), _plan(retirement_age=65)
    at = lambda p, age: next(r for r in p["rows"] if r["age"] == age)
    assert at(early, 70)["ahv"] < at(normal, 70)["ahv"]
    assert early["rows"][0]["age"] == 60


def test_net_is_income_minus_tax():
    plan = _plan(tax_in_retirement=True, canton="ZH")
    r = plan["rows"][5]
    assert r["net"] == pytest.approx(r["ahv"] + r["bvg"] + r["fund"] - r["tax"])
    assert r["tax"] > 0
