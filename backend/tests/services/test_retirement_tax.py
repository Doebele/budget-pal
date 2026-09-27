"""Schritt 6: Steuern im Ruhestand und der Vergleich Rente oder Kapital."""
from datetime import datetime

import numpy as np
import pytest

from app.api.projections import _flow_inputs
from app.services import retirement_tax as rt
from app.services.projection import ProjectionService

SERVICE = ProjectionService()


class TestTables:
    def test_support_points_are_exact(self):
        table = rt._table()
        tg = table["cantons"]["TG"]
        for amount, tax in zip(table["income_amounts"], tg["income_single"]):
            assert float(rt.income_tax(amount, "TG")) == pytest.approx(tax)
        for amount, tax in zip(table["wealth_amounts"], tg["wealth_single"]):
            assert float(rt.wealth_tax(amount, "TG")) == pytest.approx(tax)

    def test_all_26_cantons_rise_with_income(self):
        table = rt._table()
        assert len(table["cantons"]) == 26
        for canton in table["cantons"]:
            taxes = rt.income_tax(np.arange(0, 400_001, 10_000), canton)
            assert np.all(np.diff(taxes) >= 0), canton

    def test_zero_and_beyond_the_table(self):
        top = rt._table()["income_amounts"][-1]
        assert float(rt.income_tax(0, "ZH")) == 0.0
        rate = float(rt.income_tax(top, "ZH")) / top
        assert float(rt.income_tax(2 * top, "ZH")) == pytest.approx(2 * top * rate)

    def test_vectorised_like_scalar(self):
        wealth = np.array([0.0, 300_000.0, 1_500_000.0])
        together = rt.retirement_tax(40_000, wealth, "BE")
        single = [float(rt.retirement_tax(40_000, w, "BE")) for w in wealth]
        assert together == pytest.approx(single)

    def test_yield_of_wealth_is_income(self):
        base = float(rt.income_tax(50_000, "ZH"))
        with_wealth = float(rt.retirement_tax(50_000, 1_000_000, "ZH"))
        assert with_wealth == pytest.approx(
            float(rt.income_tax(50_000 + rt.INVESTMENT_YIELD * 1_000_000, "ZH"))
            + float(rt.wealth_tax(1_000_000, "ZH"))
        )
        assert with_wealth > base


RECORDS = [
    {"pillar": "1", "contribution_years": 44, "average_insured_salary": 100_000},
    {"pillar": "2", "current_balance": 500_000, "annual_contribution": 0,
     "expected_return_rate": 0.0, "provider": "PK"},
]


def _run(**overrides):
    dob = f"{datetime.now().year - 60}-06-01"
    kwargs = dict(
        current_net_worth=500_000, annual_savings=0, annual_income=100_000, years=30,
        mean_return=0.0, volatility=0.0, inflation_rate=0.0, date_of_birth=dob,
        retirement_age=65, runs=10, retirement_spending=40_000, canton="TG",
        pension_records=RECORDS,
    )
    kwargs.update(overrides)
    return SERVICE.run(**kwargs)


class TestTaxInTheWealthPath:
    def test_taxes_are_paid_from_wealth_after_retirement(self):
        with_tax, without = _run(), _run(tax_in_retirement=False)
        assert with_tax["p50"][5] == pytest.approx(without["p50"][5])   # bis 65 gleich
        lost = without["p50"][-1] - with_tax["p50"][-1]
        # das letzte Jahr der Reihe liegt nach dem Horizont
        assert lost == pytest.approx(sum(with_tax["retirement_tax"][:-1]))
        assert with_tax["retirement_tax"][4] == 0.0 and with_tax["retirement_tax"][5] > 0

    def test_wizard_spending_without_the_tax_budget(self):
        params = {"monthly_expenses_base": 6_000, "monthly_taxes": 700}
        assert _flow_inputs(params)["annual_expenses"] == 5_300 * 12
        # aeltere Szenarien ohne monthly_taxes: Wert aus dem Wizard
        assert _flow_inputs({"monthly_expenses_base": 6_000}, 500)["annual_expenses"] == 5_500 * 12


class TestPensionOrCapital:
    def test_two_variants_with_the_same_markets(self):
        res = SERVICE.compare_bvg_options(
            pension_records=RECORDS, current_net_worth=500_000, annual_savings=0,
            annual_income=100_000, years=35, mean_return=0.05, volatility=0.12,
            inflation_rate=0.015, date_of_birth=f"{datetime.now().year - 60}-06-01",
            retirement_age=65, runs=200, retirement_spending=50_000, canton="TG",
        )
        pension, capital = res["variants"]
        assert (pension["key"], capital["key"]) == ("pension", "capital")
        assert pension["bvg_monthly"] > 0 and pension["capital_net"] == 0
        assert capital["bvg_monthly"] == 0 and capital["capital_net"] > 0
        # bis zur Pensionierung dieselben Maerkte, also dasselbe Vermoegen
        assert pension["p50"][:5] == pytest.approx(capital["p50"][:5])

    def test_breakeven_without_returns(self):
        """Ohne Rendite holt die Rente das Kapital nach rund Kapital/Rente Jahren ein."""
        records = [{"pillar": "2", "current_balance": 400_000, "annual_contribution": 0,
                    "expected_return_rate": 0.0, "provider": "PK"}]
        res = SERVICE.compare_bvg_options(
            pension_records=records, current_net_worth=0, annual_savings=0, annual_income=0,
            years=35, mean_return=0.0, volatility=0.0, inflation_rate=0.0,
            date_of_birth=f"{datetime.now().year - 60}-06-01", retirement_age=65, runs=10,
            retirement_spending=0.0, tax_in_retirement=False,
        )
        pension, capital = res["variants"]
        years = capital["capital_net"] / (pension["bvg_monthly"] * 12)
        assert res["breakeven_age"] == pytest.approx(65 + years, abs=1.5)

    def test_own_plan_is_a_third_variant(self):
        records = [{"pillar": "2", "current_balance": 400_000, "capital_share": 0.5,
                    "expected_return_rate": 0.0}]
        res = SERVICE.compare_bvg_options(
            pension_records=records, current_net_worth=0, annual_savings=0, annual_income=0,
            years=10, date_of_birth=f"{datetime.now().year - 60}-06-01", retirement_age=65,
            runs=10, retirement_spending=0.0,
        )
        assert [v["key"] for v in res["variants"]] == ["pension", "capital", "own"]

    def test_without_pension_fund_nothing_to_compare(self):
        res = SERVICE.compare_bvg_options(
            pension_records=[], current_net_worth=0, annual_savings=0, annual_income=0, years=5,
        )
        assert res["variants"] == []
