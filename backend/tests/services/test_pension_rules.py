"""Rentenregeln der Schweiz, wie sie die Prognose rechnet.

Beispielhaushalt: 50 Jahre, Lohn 100'000, 30 AHV-Jahre, BVG 300'000 +
20'000/Jahr, zwei 3a-Konten a 50'000 + 3'629/Jahr.
"""
from datetime import datetime

import pytest

from app.services.projection import (
    AHV_MIN_PENSION,
    PAYOUT_YEARS,
    ProjectionService,
    ahv_full_monthly,
)

SERVICE = ProjectionService()
DOB_50 = f"{datetime.now().year - 50}-06-01"
RECORDS = [
    {"pillar": "1", "contribution_years": 30, "average_insured_salary": 100_000},
    {"pillar": "2", "current_balance": 300_000, "annual_contribution": 20_000,
     "expected_return_rate": 0.0125},
    {"pillar": "3a", "current_balance": 50_000, "annual_contribution": 3_629, "expected_return_rate": 0.03},
    {"pillar": "3a", "current_balance": 50_000, "annual_contribution": 3_629, "expected_return_rate": 0.03},
]


def _series(retirement_age: int, inflation: float = 0.0, records=RECORDS):
    ahv, bvg, p3a, _p3b, idx = SERVICE._project_pensions(
        records, 40, 100_000, DOB_50, retirement_age, inflation
    )
    return ahv, bvg, p3a, idx


def at(series, age):
    return series[age - 50]


class TestAhvFormula:
    """Zweistufige Rentenformel (Rentenskala 44), Werte 2025/2026."""

    @pytest.mark.parametrize(
        "income, monthly",
        [
            (0, 1_260.0),          # Minimalrente
            (15_120, 1_260.0),     # 12 x Minimalrente
            (45_360, 1_915.2),     # Knick bei 36 x Minimalrente
            (90_720, 2_520.0),     # Maximalrente ab 72 x Minimalrente
            (150_000, 2_520.0),    # darueber gedeckelt
        ],
    )
    def test_breakpoints(self, income, monthly):
        assert ahv_full_monthly(income) == pytest.approx(monthly)

    def test_middle_segment_is_below_the_old_straight_line(self):
        """Die alte lineare Naeherung ueberschaetzte mittlere Einkommen."""
        linear = AHV_MIN_PENSION + 30_000 / 90_720 * AHV_MIN_PENSION
        assert ahv_full_monthly(30_000) < linear

    def test_thirteen_payments_per_year(self):
        ahv, *_ = _series(65)
        assert at(ahv, 65) == pytest.approx(2_520 * 13)  # 44 Jahre erreicht, Lohn > 90'720

    def test_ahv_is_not_deflated(self):
        """Die AHV folgt dem Mischindex — in heutigen CHF bleibt sie gleich."""
        ahv_infl, *_ = _series(65, inflation=0.02)
        ahv_flat, *_ = _series(65, inflation=0.0)
        assert at(ahv_infl, 65) == pytest.approx(at(ahv_flat, 65))
        assert at(ahv_infl, 85) == pytest.approx(at(ahv_infl, 65))


class TestAfterRetirement:
    """Nach der Pensionierung wird nichts mehr einbezahlt."""

    def test_bvg_pension_is_fixed_after_retirement(self):
        _, bvg, _, _ = _series(65)
        assert at(bvg, 70) == pytest.approx(at(bvg, 65))
        assert at(bvg, 90) == pytest.approx(at(bvg, 65))

    def test_bvg_pension_loses_real_value(self):
        """Pensionskassenrenten werden in der Regel nicht der Teuerung angepasst."""
        _, bvg, _, _ = _series(65, inflation=0.015)
        assert at(bvg, 80) < at(bvg, 65)

    def test_3a_stays_capital_until_withdrawn(self):
        """Zwei Konten, gestaffelt mit 64 und 65 bezogen: danach 0."""
        _, _, p3a, _ = _series(65)
        assert at(p3a, 63) > at(p3a, 64) > 0   # das erste Konto ist mit 64 weg
        assert at(p3a, 65) == 0.0

    def test_early_retirement_means_less_bvg(self):
        """Wer mit 62 aufhoert, zahlt drei Jahre weniger ein. Frueher hatte er
        ab 65 dieselbe Rente wie jemand, der bis 65 gearbeitet hat."""
        _, bvg62, _, _ = _series(62)
        _, bvg65, _, _ = _series(65)
        assert at(bvg62, 66) < at(bvg65, 66)

    def test_early_retirement_ahv_starts_at_63(self):
        ahv, *_ = _series(62)
        assert at(ahv, 62) == 0.0
        assert at(ahv, 63) > 0.0
        assert at(ahv, 70) == pytest.approx(at(ahv, 63))  # steht ab Rentenbeginn fest


class TestConversionRate:
    def _bvg_pension(self, conversion_rate=None):
        record = {"current_balance": 500_000, "annual_contribution": 0,
                  "expected_return_rate": 0.0}
        if conversion_rate is not None:
            record["conversion_rate"] = conversion_rate
        return SERVICE._project_bvg(66, 65, record, 0, 0)

    def test_default_is_53_percent(self):
        """6.8 % gilt nur fuer den obligatorischen Teil — Vorgabe ist der
        typische umhuellende Satz."""
        assert self._bvg_pension() == pytest.approx(500_000 * 0.053)

    def test_own_rate_from_the_pension_certificate_wins(self):
        assert self._bvg_pension(0.058) == pytest.approx(500_000 * 0.058)


class TestEstimate:
    def test_matches_the_projection(self):
        """Wizard und Finanzplan zeigen dieselben Zahlen wie das Diagramm."""
        est = SERVICE.estimate_at_retirement(RECORDS, 50, 65, 100_000, 0.015)
        ahv, bvg, p3a, _p3b, _ = SERVICE._project_pensions(
            RECORDS, 40, 100_000, DOB_50, 65, 0.015
        )
        assert est["ahv_monthly"] * 12 == pytest.approx(at(ahv, 65))
        assert est["bvg_monthly"] * 12 == pytest.approx(at(bvg, 65))
        # 3a ist Kapital, keine Rente — zwei Konten, gestaffelt bezogen
        assert [w["source"] for w in est["capital_withdrawals"]] == ["3a", "3a"]
        assert est["total_monthly"] == pytest.approx(
            est["ahv_monthly"] + est["bvg_monthly"] + est["pillar_3b_monthly"]
        )

    def test_reports_when_ahv_starts(self):
        est = SERVICE.estimate_at_retirement(RECORDS, 50, 60, 100_000, 0.0)
        assert est["ahv_start_age"] == 63


# ── Schritt 2: Auszahlphase ───────────────────────────────────

from app.services.projection import (  # noqa: E402
    BVG_CONVERSION_RATE_DEFAULT,
    BVG_CONVERSION_STEP,
    CARE_REPLACES_SHARE,
    ahv_nonemployed_contribution,
    build_annual_flows,
    default_retirement_spending,
)


def _run(**kw):
    """Deterministisch: keine Streuung, keine Rendite, keine Teuerung."""
    params = dict(
        current_net_worth=500_000, annual_savings=20_000, annual_income=0,
        years=40, mean_return=0.0, volatility=0.0, inflation_rate=0.0,
        date_of_birth=DOB_50, retirement_age=65, runs=20, retirement_spending=0.0,
    )
    params.update(kw)
    return SERVICE.run(**params)


class TestWealthAfterRetirement:
    def test_savings_stop_at_retirement(self):
        """Frueher lief die Sparrate lebenslang weiter. Ab 65 kommt nur noch
        die Rente dazu (hier ohne Lebenskosten)."""
        r = _run()
        assert at(r["p50"], 65) == pytest.approx(500_000 + 15 * 20_000)
        assert at(r["p50"], 66) - at(r["p50"], 65) == pytest.approx(at(r["pension_income"], 65))

    def test_spending_minus_pensions_is_withdrawn(self):
        r = _run(pension_records=RECORDS, annual_income=100_000, retirement_spending=100_000)
        income = at(r["pension_income"], 70)
        assert income > 0
        drop = at(r["p50"], 70) - at(r["p50"], 71)
        assert drop == pytest.approx(100_000 - income, rel=1e-6)

    def test_depletion_age_and_success_rate(self):
        # Heute 65, ohne AHV-Anspruch: 100'000 reichen fuenf Jahre a 20'000
        no_ahv = [{"pillar": "1", "contribution_years": 0, "average_insured_salary": 0}]
        dob_65 = f"{datetime.now().year - 65}-06-01"
        common = dict(date_of_birth=dob_65, pension_records=no_ahv, annual_savings=0,
                      retirement_spending=20_000, years=25)
        r = _run(current_net_worth=100_000, **common)
        assert r["depletion_age"] == 70
        assert r["success_rate"] == 0.0
        rich = _run(current_net_worth=5_000_000, **common)
        assert rich["depletion_age"] is None and rich["success_rate"] == 1.0

    def test_wealth_never_goes_negative(self):
        r = _run(current_net_worth=10_000, annual_savings=0, retirement_spending=50_000)
        assert min(r["p10"]) >= 0.0

    def test_default_spending_comes_from_income_and_savings(self):
        assert default_retirement_spending(100_000, 12_000) == pytest.approx(0.8 * (72_000 - 12_000))
        assert default_retirement_spending(0, 10_000) == 0.0


class TestEarlyRetirementCosts:
    def test_ahv_contributions_until_65(self):
        """Wer mit 62 aufhoert, zahlt bis 65 AHV als Nichterwerbstaetiger —
        bemessen an Vermoegen plus 20-fachem Renteneinkommen."""
        r = _run(retirement_age=62, annual_savings=0, current_net_worth=1_000_000)
        for age in (62, 63, 64):
            income = at(r["pension_income"], age)
            basis = at(r["p50"], age) + 20 * income
            step = at(r["p50"], age + 1) - at(r["p50"], age)
            assert step == pytest.approx(income - float(ahv_nonemployed_contribution(basis)))
        # ab 65 nur noch die Rente
        assert at(r["p50"], 66) - at(r["p50"], 65) == pytest.approx(at(r["pension_income"], 65))

    @pytest.mark.parametrize(
        "basis, contribution",
        [(0, 530), (349_999, 530), (350_000, 636), (1_000_000, 530 + 14 * 106), (20_000_000, 26_500)],
    )
    def test_nonemployed_contribution_table(self, basis, contribution):
        assert float(ahv_nonemployed_contribution(basis)) == pytest.approx(contribution)

    def test_bvg_starts_at_58_with_a_lower_conversion_rate(self):
        record = {"current_balance": 400_000, "annual_contribution": 0, "expected_return_rate": 0.0}
        assert SERVICE._project_bvg(57, 55, record, 0, 2) == pytest.approx(400_000)  # noch Kapital
        rate = BVG_CONVERSION_RATE_DEFAULT - 7 * BVG_CONVERSION_STEP
        assert SERVICE._project_bvg(58, 55, record, 0, 3) == pytest.approx(400_000 * rate)

    def test_3a_withdrawal_needs_age_60(self):
        """Wer mit 55 aufhoert, bezieht die 3a trotzdem erst ab 60; bis dahin
        verzinst sie sich ohne Beitraege."""
        record = {"current_balance": 100_000, "annual_contribution": 7_258, "expected_return_rate": 0.0}
        assert SERVICE._project_3a(59, 55, record, 9) == pytest.approx(100_000 + 5 * 7_258)
        ages = SERVICE.capital_withdrawals([{"pillar": "3a", **record}], 50, 55, 0, 0.0)
        assert ages[0]["age"] >= 60

    def test_capital_before_payout_is_not_income(self):
        """Mit 55 in Rente: BVG und 3a sind bis 58/60 Kapital, kein Einkommen."""
        r = _run(pension_records=RECORDS, annual_income=100_000, retirement_age=55)
        assert r["payout_start_idx"] == {"1": 13, "2": 8, "3b": 5}
        assert at(r["pension_income"], 56) == 0.0
        assert at(r["pension_income"], 58) == pytest.approx(at(r["pension_bvg"], 58))


class TestCareCosts:
    def test_care_replaces_part_of_living_costs(self):
        flows = build_annual_flows(
            ["care_costs_at_80"], years=3, current_age=80, retirement_age=65,
            care_cost_annual=72_000, retirement_spending=50_000, inflation_rate=0.0,
        )
        assert flows[0] == pytest.approx(-(72_000 - CARE_REPLACES_SHARE * 50_000))

    def test_care_never_saves_money(self):
        flows = build_annual_flows(
            ["care_costs_at_80"], years=1, current_age=80, retirement_age=65,
            care_cost_annual=20_000, retirement_spending=100_000, inflation_rate=0.0,
        )
        assert flows[0] == 0.0
