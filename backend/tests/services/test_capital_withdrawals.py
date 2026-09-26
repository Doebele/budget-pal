"""Kapitalbezuege: Steuer (Bund + Kanton) und gestaffelter Bezugsplan."""
import json
from datetime import datetime
from pathlib import Path

import pytest

from app.services import capital_tax as ct
from app.services.projection import ProjectionService, bvg_steps, plan_3a_ages

SERVICE = ProjectionService()


class TestFederalTariff:
    """Tarif 2026 aus ESTV Form. 58c; Werte direkt aus der Tabelle."""

    @pytest.mark.parametrize(
        "income, married, tax",
        [
            (15_200, False, 0.0), (43_500, False, 229.20), (100_000, False, 2_684.35),
            (500_000, False, 52_503.35), (800_000, False, 92_000.00),   # 11.5 % flat
            (29_700, True, 0.0), (100_000, True, 1_816.00),
            (941_200, True, 108_236.00), (950_000, True, 109_250.00),
        ],
    )
    def test_rows_of_the_official_table(self, income, married, tax):
        assert ct.federal_income_tax(income, married) == pytest.approx(tax, abs=0.05)

    def test_capital_is_taxed_at_one_fifth(self):
        assert ct.federal_capital_tax(100_000) == pytest.approx(2_684.35 / 5)

    def test_matches_the_estv_calculator(self):
        """Die ESTV-Abfrage lieferte auch die Bundessteuer — der eigene Tarif
        muss sie fuer jeden Betrag treffen (ESTV rundet auf Franken)."""
        data = json.loads(Path(ct._DATA_FILE).read_text(encoding="utf-8"))
        for canton in data["cantons"].values():
            for married in (False, True):
                estv = canton["federal_married" if married else "federal_single"]
                for amount, fed in zip(data["amounts"], estv):
                    assert ct.federal_capital_tax(amount, married) == pytest.approx(fed, abs=1)


class TestCantonalTax:
    def test_support_points_are_exact(self):
        data = ct._cantonal_table()
        zh = data["cantons"]["ZH"]
        for amount, tax in zip(data["amounts"], zh["single"]):
            assert ct.cantonal_capital_tax(amount, "ZH") == pytest.approx(tax)

    def test_grows_with_the_amount(self):
        taxes = [ct.cantonal_capital_tax(a, "BE") for a in range(50_000, 2_000_001, 50_000)]
        assert taxes == sorted(taxes)

    def test_unknown_canton_falls_back_to_zurich(self):
        assert ct.cantonal_capital_tax(300_000, "XX") == ct.cantonal_capital_tax(300_000, "ZH")

    def test_all_26_cantons(self):
        assert len(ct.known_cantons()) == 26

    def test_same_year_withdrawals_are_added(self):
        """Progression: zwei Bezuege im selben Jahr kosten mehr als getrennt."""
        together = ct.tax_by_year([(2030, 150_000), (2030, 150_000)])[2030]
        apart = sum(ct.tax_by_year([(2030, 150_000), (2031, 150_000)]).values())
        assert together > apart

    def test_tax_profile_from_the_wizard(self):
        assert ct.tax_profile({"kanton": "sz", "household_type": "couple"}) == ("SZ", True)
        assert ct.tax_profile({"kanton": "GE", "household_type": "single"}) == ("GE", False)
        assert ct.tax_profile(None) == ("ZH", False)


class TestStaggeringPlan:
    def test_one_account_per_year_as_late_as_possible(self):
        assert plan_3a_ages(3, retirement_age=65, current_age=50) == [63, 64, 65]

    def test_never_in_the_year_of_the_pension_fund_capital(self):
        assert plan_3a_ages(3, 65, 50, avoid=[65]) == [62, 63, 64]

    def test_not_before_60(self):
        assert plan_3a_ages(8, 65, 50) == sorted([65, 64, 63, 62, 61, 60, 65, 64])

    def test_deferral_only_when_still_working(self):
        """Nach 65 nur, wer weiterarbeitet (hier bis 68)."""
        assert max(plan_3a_ages(1, 68, 50)) == 68
        assert max(plan_3a_ages(1, 62, 50)) == 65

    def test_own_age_is_kept_and_blocks_its_year(self):
        records = [
            {"pillar": "3a", "current_balance": 50_000, "withdrawal_age": 65},
            {"pillar": "3a", "current_balance": 50_000},
        ]
        ages = [w["age"] for w in SERVICE.capital_withdrawals(records, 50, 65, 0, 0.0)]
        assert ages == [64, 65]


RECORDS = [
    {"pillar": "1", "contribution_years": 30, "average_insured_salary": 100_000},
    {"pillar": "2", "current_balance": 400_000, "annual_contribution": 0,
     "expected_return_rate": 0.0, "capital_share": 0.5, "provider": "PK"},
    *[{"pillar": "3a", "current_balance": 60_000, "annual_contribution": 0,
       "expected_return_rate": 0.0, "provider": f"3a-{i}"} for i in range(3)],
]


class TestCapitalWithdrawals:
    def test_plan_saves_tax_against_a_single_year(self):
        events = SERVICE.capital_withdrawals(RECORDS, 50, 65, 100_000, 0.0)
        assert [(e["source"], e["age"]) for e in events] == [
            ("3a", 62), ("3a", 63), ("3a", 64), ("bvg", 65),
        ]
        staggered = sum(e["tax"] for e in events)
        single = ct.capital_tax(sum(e["amount"] for e in events))
        assert staggered < single

    def test_bvg_capital_share_splits_pension_and_lump_sum(self):
        full, _ = bvg_steps({**RECORDS[1], "capital_share": 0.0}, 0, 50, 65)
        half, _ = bvg_steps(RECORDS[1], 0, 50, 65)
        assert half[-1]["pension"] == pytest.approx(full[-1]["pension"] / 2)
        lump = next(e for e in SERVICE.capital_withdrawals(RECORDS, 50, 65, 0, 0.0) if e["source"] == "bvg")
        assert lump["amount"] == pytest.approx(200_000)

    def test_net_capital_flows_into_wealth(self):
        dob = f"{datetime.now().year - 50}-06-01"
        common = dict(current_net_worth=0, annual_savings=0, annual_income=0, years=20,
                      mean_return=0.0, volatility=0.0, inflation_rate=0.0,
                      date_of_birth=dob, retirement_age=65, runs=10, retirement_spending=0.0)
        r = SERVICE.run(pension_records=RECORDS[2:3], **common)
        event = r["capital_withdrawals"][0]
        idx = event["age"] - 50
        jump = r["p50"][idx + 1] - r["p50"][idx]
        # im Bezugsjahr kommt auch die (geschaetzte) AHV-Rente dazu
        assert jump == pytest.approx(event["amount"] - event["tax"] + r["pension_income"][idx])
        assert r["capital_tax_total"] == pytest.approx(event["tax"])

    def test_canton_changes_the_tax(self):
        zh = sum(e["tax"] for e in SERVICE.capital_withdrawals(RECORDS, 50, 65, 0, 0.0, "ZH"))
        sz = sum(e["tax"] for e in SERVICE.capital_withdrawals(RECORDS, 50, 65, 0, 0.0, "SZ"))
        assert sz != zh


def test_events_name_their_3a_account():
    """Die Oberflaeche ordnet das vorgeschlagene Alter ueber den Konto-Index zu —
    die Liste ist nach Alter sortiert, nicht nach Konto."""
    records = [
        {"pillar": "3a", "current_balance": 10_000, "withdrawal_age": 65},
        {"pillar": "3a", "current_balance": 10_000},
    ]
    events = SERVICE.capital_withdrawals(records, 50, 65, 0, 0.0)
    assert {e["account"]: e["age"] for e in events} == {0: 65, 1: 64}
