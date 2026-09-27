"""Schritt 8: Szenarienmatrix Rentenalter x Kapitalanteil und Hinweise."""
from datetime import datetime

from app.services.projection import ProjectionService

SERVICE = ProjectionService()
RECORDS = [
    {"pillar": "1", "contribution_years": 30, "average_insured_salary": 90_000},
    {"pillar": "2", "current_balance": 450_000, "annual_contribution": 10_000,
     "expected_return_rate": 0.01, "provider": "PK"},
    {"pillar": "3a", "current_balance": 60_000, "provider": "A"},
    {"pillar": "3a", "current_balance": 60_000, "provider": "B"},
    {"pillar": "3b", "current_balance": 150_000, "withdrawal_age": 66, "expected_return_rate": 0.0},
]


def _scenarios(**kw):
    base = dict(
        pension_records=RECORDS, current_net_worth=200_000, annual_savings=20_000,
        annual_income=100_000, years=37, mean_return=0.04, volatility=0.1, inflation_rate=0.01,
        date_of_birth=f"{datetime.now().year - 58}-06-01", retirement_age=63, runs=200,
        retirement_spending=55_000, canton="TG", drawdown_until_age=90,
    )
    base.update(kw)
    return SERVICE.retirement_scenarios(**base)


def test_matrix_covers_ages_and_shares():
    res = _scenarios()
    assert res["ages"] == [60, 62, 63, 65]
    assert len(res["cells"]) == 4 * 3
    cell = {(c["age"], c["capital_share"]): c for c in res["cells"]}
    # spaeter in Rente = mehr Einkommen mit 75
    assert cell[(65, 0.0)]["net_75"] > cell[(60, 0.0)]["net_75"]


def test_hints_from_own_numbers():
    keys = [h["key"] for h in _scenarios()["hints"]]
    assert "earlyCost" in keys
    assert "lifeInsurance" in keys
    assert "pensionWins" in keys or "capitalWins" in keys


def test_bridge_hint_before_ahv():
    keys = [h["key"] for h in _scenarios(retirement_age=61)["hints"]]
    assert "ahvBridge" in keys
