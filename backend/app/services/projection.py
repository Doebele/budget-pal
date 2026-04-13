"""
Financial projection service.

Features:
- Monte Carlo simulation (10,000 runs by default)
- Returns percentile bands (p10, p25, p50, p75, p90) per year
- Swiss AHV pension calculation
- BVG/Pensionskasse projection
- Pillar 3a compound growth
- Inflation adjustment (real CHF values)
- Scenario support
"""
import logging
from datetime import datetime
from typing import Dict, List, Optional, Any

import numpy as np

logger = logging.getLogger(__name__)


# ── BVG Age Brackets ──────────────────────────────────────────
BVG_CONTRIBUTION_RATES = {
    # (min_age, max_age): total_rate (employee + employer combined)
    (25, 34): 0.07,
    (35, 44): 0.10,
    (45, 54): 0.15,
    (55, 65): 0.18,
}

AHV_MAX_PENSION = 2520.0        # CHF/month, 2024 value
AHV_MIN_PENSION = 1260.0
AHV_FULL_YEARS = 44
AHV_CONVERSION_RATE = 0.068     # BVG Umwandlungssatz
BVG_COORD_DEDUCTION = 25725.0   # CHF, 2024


def _bvg_rate_for_age(age: int) -> float:
    """Return the BVG employee contribution rate for a given age."""
    for (min_age, max_age), rate in BVG_CONTRIBUTION_RATES.items():
        if min_age <= age <= max_age:
            return rate
    return 0.0  # under 25 or over 65


class ProjectionService:
    """Runs Monte Carlo + Swiss pension projections."""

    def run(
        self,
        current_net_worth: float,
        annual_savings: float,
        annual_income: float,
        years: int,
        mean_return: float = 0.07,
        volatility: float = 0.12,
        inflation_rate: float = 0.015,
        pension_records: Optional[List[Dict]] = None,
        date_of_birth: Optional[str] = None,
        retirement_age: int = 65,
        runs: int = 10_000,
    ) -> Dict[str, Any]:
        """
        Run Monte Carlo simulation and pension projections.

        Returns dict with:
          years, p10, p25, p50, p75, p90,
          pension_ahv, pension_bvg, pension_3a,
          inflation_adjusted
        """
        # ── Monte Carlo ────────────────────────────────────────
        np.random.seed(None)

        # Random annual returns: log-normal distribution
        # ln(1+r) ~ Normal(mu, sigma)
        log_mean = np.log(1 + mean_return) - 0.5 * volatility**2
        annual_log_returns = np.random.normal(
            loc=log_mean,
            scale=volatility,
            size=(runs, years),
        )
        annual_returns = np.exp(annual_log_returns) - 1  # shape (runs, years)

        # Simulate net worth year by year
        portfolio = np.full(runs, current_net_worth, dtype=np.float64)
        all_values = np.zeros((runs, years + 1), dtype=np.float64)
        all_values[:, 0] = portfolio

        # Savings may grow with inflation
        for yr in range(years):
            inflation_factor = (1 + inflation_rate) ** yr
            yr_savings = annual_savings * inflation_factor
            portfolio = portfolio * (1 + annual_returns[:, yr]) + yr_savings
            all_values[:, yr + 1] = portfolio

        # Inflation adjust all values to today's CHF (real terms)
        inflation_deflators = np.array(
            [(1 + inflation_rate) ** i for i in range(years + 1)]
        )
        real_values = all_values / inflation_deflators  # broadcasting

        # Compute percentile bands
        p10 = np.percentile(real_values, 10, axis=0).tolist()
        p25 = np.percentile(real_values, 25, axis=0).tolist()
        p50 = np.percentile(real_values, 50, axis=0).tolist()
        p75 = np.percentile(real_values, 75, axis=0).tolist()
        p90 = np.percentile(real_values, 90, axis=0).tolist()

        year_labels = list(range(datetime.now().year, datetime.now().year + years + 1))

        # ── Pension Projections ───────────────────────────────
        pension_ahv, pension_bvg, pension_3a, pension_3b = self._project_pensions(
            pension_records=pension_records or [],
            years=years,
            annual_income=annual_income,
            date_of_birth=date_of_birth,
            retirement_age=retirement_age,
            inflation_rate=inflation_rate,
        )

        return {
            "years": year_labels,
            "p10": p10,
            "p25": p25,
            "p50": p50,
            "p75": p75,
            "p90": p90,
            "pension_ahv": pension_ahv,
            "pension_bvg": pension_bvg,
            "pension_3a": pension_3a,
            "pension_3b": pension_3b,
            "inflation_adjusted": True,
        }

    def _project_pensions(
        self,
        pension_records: List[Dict],
        years: int,
        annual_income: float,
        date_of_birth: Optional[str],
        retirement_age: int,
        inflation_rate: float,
    ) -> tuple:
        """
        Project AHV, BVG, Pillar 3a and Pillar 3b pension values per year.

        Returns four lists (length = years+1) of annual pension income / capital
        in real CHF. Before retirement: projected balance. After: annual income.
        """
        current_year = datetime.now().year

        # Determine current age
        current_age = 40  # fallback
        if date_of_birth:
            try:
                dob = datetime.fromisoformat(date_of_birth)
                current_age = int((datetime.now() - dob).days / 365.25)
            except Exception:
                pass

        years_to_retirement = max(0, retirement_age - current_age)

        # Extract pension records by pillar
        ahv_record = next((r for r in pension_records if r["pillar"] == "1"), None)
        bvg_record = next((r for r in pension_records if r["pillar"] == "2"), None)
        p3a_records = [r for r in pension_records if r["pillar"] == "3a"]
        p3b_records = [r for r in pension_records if r["pillar"] == "3b"]

        pension_ahv_series = []
        pension_bvg_series = []
        pension_3a_series = []
        pension_3b_series = []

        for yr in range(years + 1):
            age_at_year = current_age + yr
            inflation_deflator = (1 + inflation_rate) ** yr

            # ── AHV ────────────────────────────────────────
            ahv_annual = self._project_ahv(
                age_at_year=age_at_year,
                retirement_age=retirement_age,
                record=ahv_record,
                annual_income=annual_income,
            )
            pension_ahv_series.append(ahv_annual / inflation_deflator)

            # ── BVG ────────────────────────────────────────
            bvg_annual = self._project_bvg(
                age_at_year=age_at_year,
                retirement_age=retirement_age,
                record=bvg_record,
                annual_income=annual_income,
                years_elapsed=yr,
            )
            pension_bvg_series.append(bvg_annual / inflation_deflator)

            # ── Pillar 3a ──────────────────────────────────
            p3a_total = sum(
                self._project_3a(
                    age_at_year=age_at_year,
                    retirement_age=retirement_age,
                    record=r,
                    years_elapsed=yr,
                )
                for r in p3a_records
            )
            pension_3a_series.append(p3a_total / inflation_deflator)

            # ── Pillar 3b (Lebensversicherung / freie Vorsorge) ────
            p3b_total = sum(
                self._project_3b(
                    age_at_year=age_at_year,
                    retirement_age=retirement_age,
                    record=r,
                    years_elapsed=yr,
                )
                for r in p3b_records
            )
            pension_3b_series.append(p3b_total / inflation_deflator)

        return pension_ahv_series, pension_bvg_series, pension_3a_series, pension_3b_series

    def _project_ahv(
        self,
        age_at_year: int,
        retirement_age: int,
        record: Optional[Dict],
        annual_income: float,
    ) -> float:
        """
        Calculate projected AHV monthly pension (× 12 for annual).
        Returns annual AHV pension income in nominal CHF.
        """
        if age_at_year < retirement_age:
            return 0.0

        if record:
            contribution_years = record.get("contribution_years") or max(0, age_at_year - 18)
            avg_salary = record.get("average_insured_salary") or annual_income
        else:
            contribution_years = max(0, age_at_year - 18)
            avg_salary = annual_income

        contribution_years = min(contribution_years, AHV_FULL_YEARS)
        completeness = contribution_years / AHV_FULL_YEARS

        # Simplified AHV formula: between min and max pension based on completeness
        pension_monthly = AHV_MIN_PENSION + completeness * (AHV_MAX_PENSION - AHV_MIN_PENSION)
        pension_monthly = min(pension_monthly, AHV_MAX_PENSION)
        pension_monthly = max(pension_monthly, AHV_MIN_PENSION * completeness)

        return pension_monthly * 12

    def _project_bvg(
        self,
        age_at_year: int,
        retirement_age: int,
        record: Optional[Dict],
        annual_income: float,
        years_elapsed: int,
    ) -> float:
        """
        Project BVG pension balance and eventual annual pension.
        Before retirement: returns projected capital (not income).
        After retirement: returns annual pension = capital × conversion_rate.
        """
        if record:
            current_balance = record.get("current_balance", 0.0)
            annual_contribution = record.get("annual_contribution", 0.0)
            return_rate = record.get("expected_return_rate", 0.01)
        else:
            # Estimate from salary
            insured_salary = max(0, annual_income - BVG_COORD_DEDUCTION)
            bvg_rate = _bvg_rate_for_age(age_at_year)
            current_balance = 0.0
            annual_contribution = insured_salary * bvg_rate
            return_rate = 0.01  # minimum guarantee

        # Project balance using compound growth + contributions
        balance = current_balance
        for yr in range(years_elapsed):
            age_in_sim = (age_at_year - years_elapsed) + yr
            insured_salary = max(0, annual_income - BVG_COORD_DEDUCTION)
            contrib = annual_contribution or insured_salary * _bvg_rate_for_age(age_in_sim)
            balance = balance * (1 + return_rate) + contrib

        if age_at_year < retirement_age:
            return balance  # return balance as proxy before retirement

        # At/after retirement: convert capital to annual pension
        return balance * AHV_CONVERSION_RATE

    def _project_3a(
        self,
        age_at_year: int,
        retirement_age: int,
        record: Dict,
        years_elapsed: int,
    ) -> float:
        """
        Project Pillar 3a balance with compound growth.
        Before retirement: accumulated balance. After: annuitized (balance / 20 years).
        """
        current_balance = record.get("current_balance", 0.0)
        annual_contribution = record.get("annual_contribution", 0.0)
        return_rate = record.get("expected_return_rate", 0.03)
        rec_retirement = record.get("retirement_age", retirement_age)

        balance = current_balance
        for _ in range(years_elapsed):
            balance = balance * (1 + return_rate) + annual_contribution

        if age_at_year < rec_retirement:
            return balance  # return balance as proxy

        # Annuitize over ~20 years (simple)
        return balance / 20.0

    def _project_3b(
        self,
        age_at_year: int,
        retirement_age: int,
        record: Dict,
        years_elapsed: int,
    ) -> float:
        """
        Project Pillar 3b (Lebensversicherung / freie Vorsorge).

        For Kapital-/Gemischt-Lebensversicherungen: current_balance holds the
        guaranteed Ablaufleistung (fixed payout sum). We grow it by the
        expected_return_rate until retirement, then annuitize over 20 years.
        For Risiko-LV: current_balance = 0 (no capital component), returns 0.
        """
        current_balance = record.get("current_balance", 0.0)
        annual_contribution = record.get("annual_contribution", 0.0)
        return_rate = record.get("expected_return_rate", 0.0)

        if current_balance <= 0 and annual_contribution <= 0:
            return 0.0

        balance = current_balance
        for _ in range(years_elapsed):
            balance = balance * (1 + return_rate) + annual_contribution

        if age_at_year < retirement_age:
            return balance  # proxy: projected capital

        # Annuitize over 20 years (conservative payout estimate)
        return balance / 20.0

    def compare_scenarios(
        self,
        scenarios: List[Dict],
        **base_kwargs,
    ) -> Dict[str, Any]:
        """
        Run multiple scenarios and return median (p50) series for each.

        Args:
            scenarios: List of dicts, each with {"name": str, overrides: ...}
            base_kwargs: Default parameters shared across scenarios.
        """
        results = {}
        for scenario in scenarios:
            name = scenario.pop("name", "Unnamed")
            params = {**base_kwargs, **scenario}
            result = self.run(**params)
            results[name] = {
                "years": result["years"],
                "p50": result["p50"],
                "p10": result["p10"],
                "p90": result["p90"],
            }
        return results
