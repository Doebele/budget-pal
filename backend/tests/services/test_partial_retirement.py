"""Schritt 4: Teilpensionierung der Pensionskasse und Lebensversicherung am Ablauf."""
from datetime import datetime

import pytest

from app.api.pension import PartialStep, _check_partial_steps
from app.services.projection import (
    NET_INCOME_SHARE,
    ProjectionService,
    bvg_steps,
    pensum_at,
    single_year_tax,
)

SERVICE = ProjectionService()
BVG = {"pillar": "2", "current_balance": 500_000, "annual_contribution": 10_000,
       "expected_return_rate": 0.0, "provider": "PK"}
HALF_AT_60 = [{"age": 60, "pensum": 0.6, "capital_share": 1.0}]


class TestBvgSteps:
    def test_step_releases_the_reduced_share(self):
        """100 % auf 60 %: 40 % des Guthabens werden frei, der Rest spart mit
        60 % der Beitraege weiter und wird beim Erwerbsende frei."""
        steps, balances = bvg_steps({**BVG, "partial_steps": HALF_AT_60}, 0, 55, 63)
        at_60 = 500_000 + 5 * 10_000
        assert [s["age"] for s in steps] == [60, 63]
        assert steps[0]["released"] == pytest.approx(at_60 * 0.4)
        assert steps[0]["capital"] == pytest.approx(at_60 * 0.4)  # ganz als Kapital
        assert steps[0]["pension"] == 0.0
        assert steps[1]["released"] == pytest.approx(at_60 * 0.6 + 3 * 10_000 * 0.6)
        assert balances[5] == pytest.approx(at_60 * 0.6)  # mit 60 nach dem Schritt

    def test_without_steps_everything_at_the_end(self):
        steps, _ = bvg_steps(BVG, 0, 55, 65)
        assert len(steps) == 1 and steps[0]["released"] == pytest.approx(600_000)

    @pytest.mark.parametrize("partial", [
        [{"age": 64, "pensum": 0.5}],                              # nach dem Erwerbsende
        [{"age": 57, "pensum": 0.5}],                              # vor 58
        [{"age": 60, "pensum": 0.5}, {"age": 61, "pensum": 0.7}],  # Pensum steigt
    ])
    def test_invalid_steps_are_ignored(self, partial):
        steps, _ = bvg_steps({**BVG, "partial_steps": partial}, 0, 55, 63)
        assert steps[-1]["age"] == 63
        assert len(steps) == (2 if len(partial) == 2 else 1)

    def test_at_most_two_partial_steps(self):
        partial = [{"age": 60, "pensum": 0.8}, {"age": 61, "pensum": 0.6}, {"age": 62, "pensum": 0.4}]
        steps, _ = bvg_steps({**BVG, "partial_steps": partial}, 0, 55, 64)
        assert [s["age"] for s in steps] == [60, 61, 64]

    def test_pensum_by_age(self):
        record = {**BVG, "partial_steps": HALF_AT_60}
        assert [pensum_at(record, 55, 63, a) for a in (59, 60, 62, 63)] == [1.0, 0.6, 0.6, 0.0]


class TestPartialRetirementInThePlan:
    RECORDS = [{**BVG, "partial_steps": HALF_AT_60, "capital_share": 0.0}]

    def test_partial_capital_is_taxed_and_blocks_the_3a_year(self):
        records = self.RECORDS + [{"pillar": "3a", "current_balance": 50_000, "provider": "3a"}]
        events = SERVICE.capital_withdrawals(records, 55, 63, 0, 0.0)
        bvg = next(e for e in events if e["source"] == "bvg")
        assert (bvg["age"], bvg["pensum"]) == (60, 0.6)
        assert bvg["tax"] > 0
        assert next(e for e in events if e["source"] == "3a")["age"] != 60

    def test_lost_salary_and_partial_pension_flow_into_wealth(self):
        income = 100_000
        dob = f"{datetime.now().year - 55}-06-01"
        r = SERVICE.run(
            current_net_worth=1_000_000, annual_savings=20_000, annual_income=income,
            years=10, mean_return=0.0, volatility=0.0, inflation_rate=0.0,
            pension_records=[{**BVG, "partial_steps": [{"age": 60, "pensum": 0.6}]}],
            date_of_birth=dob, retirement_age=63, runs=10, retirement_spending=0.0,
        )
        partial_pension = r["pension_income"][5]
        assert partial_pension > 0
        jump = r["p50"][6] - r["p50"][5]
        assert jump == pytest.approx(20_000 - 0.4 * income * NET_INCOME_SHARE + partial_pension)
        assert r["pension_income"][4] == 0.0


class TestLifeInsurance:
    LV = {"pillar": "3b", "current_balance": 286_484, "annual_contribution": 0,
          "expected_return_rate": 0.0, "provider": "Lebensversicherung", "withdrawal_age": 66}

    def test_paid_out_at_expiry_tax_free(self):
        events = SERVICE.capital_withdrawals([self.LV], 58, 61, 0, 0.0)
        assert events == [pytest.approx({
            "source": "3b", "label": "Lebensversicherung", "age": 66, "amount": 286_484,
            "tax": 0.0, "year": datetime.now().year + 8,
        })]
        assert single_year_tax(events, "ZH", False) == 0.0

    def test_nominal_sum_loses_real_value(self):
        events = SERVICE.capital_withdrawals([self.LV], 58, 61, 0, 0.015)
        assert events[0]["amount"] == pytest.approx(286_484 / 1.015 ** 8)

    def test_series_holds_the_capital_until_expiry(self):
        dob = f"{datetime.now().year - 58}-06-01"
        _, _, _, p3b, _, _ = SERVICE._project_pensions([self.LV], 12, 0, dob, 61, 0.0)
        assert p3b[7] == pytest.approx(286_484) and p3b[8] == 0.0

    def test_flows_into_wealth(self):
        dob = f"{datetime.now().year - 58}-06-01"
        r = SERVICE.run(
            current_net_worth=0, annual_savings=0, annual_income=0, years=12,
            mean_return=0.0, volatility=0.0, inflation_rate=0.0, pension_records=[self.LV],
            date_of_birth=dob, retirement_age=61, runs=10, retirement_spending=0.0,
        )
        assert r["p50"][9] - r["p50"][8] == pytest.approx(286_484 + r["pension_income"][8])

    def test_without_expiry_at_retirement(self):
        events = SERVICE.capital_withdrawals([{**self.LV, "withdrawal_age": None}], 58, 61, 0, 0.0)
        assert events[0]["age"] == 61


class TestEstimate:
    def test_reports_the_steps_and_no_3b_pension(self):
        records = [{**BVG, "partial_steps": HALF_AT_60, "capital_share": 0.5}, TestLifeInsurance.LV]
        est = SERVICE.estimate_at_retirement(records, 55, 63, 0, 0.0)
        assert [s["age"] for s in est["bvg_steps"]] == [60, 63]
        assert est["bvg_capital"] == pytest.approx(sum(s["released"] for s in est["bvg_steps"]))
        assert est["pillar_3b_capital"] == pytest.approx(286_484)
        assert est["total_monthly"] == pytest.approx(est["ahv_monthly"] + est["bvg_monthly"])
        # beide Renten fliessen ab 63: Teilrente seit 60 plus Rente aus dem Endbezug
        assert est["bvg_monthly"] == pytest.approx(sum(s["pension_monthly"] for s in est["bvg_steps"]))


class TestLegalLimits:
    """Art. 13a BVG: hoechstens drei Kapitalbezuege, erster Schritt mind. 20 %."""

    def _check(self, *steps):
        return _check_partial_steps([PartialStep(**s) for s in steps])

    def test_valid_plan(self):
        assert len(self._check({"age": 60, "pensum": 0.8}, {"age": 62, "pensum": 0.4})) == 2

    @pytest.mark.parametrize("steps", [
        [{"age": 60, "pensum": 0.9}],                                                    # < 20 %
        [{"age": 60, "pensum": 0.6}, {"age": 60, "pensum": 0.4}],                        # gleiches Jahr
        [{"age": 60, "pensum": 0.6}, {"age": 62, "pensum": 0.7}],                        # Pensum steigt
        [{"age": 59, "pensum": 0.8}, {"age": 60, "pensum": 0.6}, {"age": 61, "pensum": 0.4}],  # 4 Bezuege
    ])
    def test_rejected(self, steps):
        with pytest.raises(ValueError):
            self._check(*steps)


def test_bvg_capital_and_income_are_separate_series():
    """Fuers Diagramm: Kapital bis zum Endbezug, danach 0; die Rente separat."""
    dob = f"{datetime.now().year - 55}-06-01"
    r = SERVICE.run(
        current_net_worth=0, annual_savings=0, annual_income=0, years=12,
        mean_return=0.0, volatility=0.0, inflation_rate=0.0,
        pension_records=[{**BVG, "partial_steps": HALF_AT_60}], date_of_birth=dob,
        retirement_age=63, runs=10, retirement_spending=0.0,
    )
    assert r["capital_bvg"][7] > 0 and r["capital_bvg"][8] == 0.0      # 62 / 63
    assert r["income_bvg"][4] == 0.0 and r["income_bvg"][5] == 0.0      # Teilschritt ganz als Kapital
    assert r["income_bvg"][8] == pytest.approx(r["pension_bvg"][8])      # ab 63 die Rente
