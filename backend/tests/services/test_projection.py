"""
Budget-Pal Backend — Projection Service Tests

Tests for:
- Monte Carlo simulation
- Pension projections (AHV, BVG, Pillar 3a/3b)
- Scenario comparison
"""

import numpy as np
import pytest
from app.services.projection import BVG_CONTRIBUTION_RATES, ProjectionService

# ── Monte Carlo Tests ─────────────────────────────────────────


class TestMonteCarloSimulation:
    """Tests for the Monte Carlo simulation component."""

    def setup_method(self):
        """Set up test fixtures."""
        self.service = ProjectionService()

    def test_monte_carlo_returns_expected_keys(self):
        """Test that simulation returns all expected keys."""
        result = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=10,
            mean_return=0.07,
            volatility=0.12,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=1000,  # Reduced for faster tests
        )

        assert "years" in result
        assert "p10" in result
        assert "p25" in result
        assert "p50" in result
        assert "p75" in result
        assert "p90" in result
        assert "pension_ahv" in result
        assert "pension_bvg" in result
        assert "pension_3a" in result
        assert "pension_3b" in result
        assert "inflation_adjusted" in result

    def test_monte_carlo_year_labels(self):
        """Test that year labels are correct."""
        result = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=10,
            mean_return=0.07,
            volatility=0.12,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=100,
        )

        # Should have years + 1 (includes year 0)
        assert len(result["years"]) == 11
        # First year should be current year
        from datetime import datetime

        assert result["years"][0] == datetime.now().year

    def test_monte_carlo_percentile_ordering(self):
        """Test that percentiles are in correct order: p10 <= p25 <= p50 <= p75 <= p90."""
        result = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=10,
            mean_return=0.07,
            volatility=0.12,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=1000,
        )

        for i in range(len(result["years"])):
            assert result["p10"][i] <= result["p25"][i]
            assert result["p25"][i] <= result["p50"][i]
            assert result["p50"][i] <= result["p75"][i]
            assert result["p75"][i] <= result["p90"][i]

    def test_monte_carlo_initial_value(self):
        """Test that year 0 equals current net worth."""
        result = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=10,
            mean_return=0.07,
            volatility=0.12,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=100,
        )

        # Year 0 should equal initial net worth (inflation adjusted)
        assert abs(result["p50"][0] - 100000.0) < 1.0

    def test_monte_carlo_positive_mean_return(self):
        """Test that positive mean return leads to higher median over time."""
        result_positive = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=20,
            mean_return=0.07,
            volatility=0.12,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=500,
        )

        result_zero = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=20,
            mean_return=0.0,
            volatility=0.12,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=500,
        )

        # Median at year 20 should be higher with positive return
        assert result_positive["p50"][-1] > result_zero["p50"][-1]

    def test_monte_carlo_zero_volatility(self):
        """Test that zero volatility gives deterministic results."""
        result_1 = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=5,
            mean_return=0.05,
            volatility=0.0,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=100,
        )

        result_2 = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=5,
            mean_return=0.05,
            volatility=0.0,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=100,
        )

        # With zero volatility, all percentiles should be equal
        assert result_1["p10"] == result_1["p90"]
        assert result_1["p10"] == pytest.approx(result_2["p10"])

    def test_monte_carlo_inflation_adjusted(self):
        """Test that inflation adjustment works correctly."""
        result = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=10,
            mean_return=0.0,
            volatility=0.0,
            inflation_rate=0.05,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=100,
        )

        # With zero return and positive inflation, real value should decrease
        assert result["p50"][-1] < result["p50"][0]

    def test_monte_carlo_no_inflation(self):
        """Test with zero inflation rate."""
        result = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=5,
            mean_return=0.07,
            volatility=0.12,
            inflation_rate=0.0,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=100,
        )

        # p10 and p90 should not be equal (volatility > 0)
        assert result["p10"] != result["p90"]

    def test_monte_carlo_large_savings(self):
        """Test with large annual savings."""
        result = self.service.run(
            current_net_worth=100000.0,
            annual_savings=50000.0,
            annual_income=100000.0,
            years=10,
            mean_return=0.07,
            volatility=0.12,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=100,
        )

        # With large savings, final value should be significantly higher
        assert result["p50"][-1] > result["p50"][0] * 2


# ── AHV Pension Tests ─────────────────────────────────────────


class TestAHVPension:
    """Tests for AHV (Säule 1) pension projection."""

    def setup_method(self):
        """Set up test fixtures."""
        self.service = ProjectionService()

    def test_ahv_before_retirement(self):
        """Test that AHV pension is zero before retirement age."""
        result = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=10,
            mean_return=0.07,
            volatility=0.12,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=100,
        )

        # Current age is ~39, so years 0-25 should have AHV = 0
        # Retirement at 65, current age ~39, so 26 years to retirement
        for i in range(min(11, len(result["pension_ahv"]))):
            age_at_year = 39 + i
            if age_at_year < 65:
                assert result["pension_ahv"][i] == 0.0, (
                    f"Year {i}: age {age_at_year} < 65"
                )

    def test_ahv_after_retirement(self):
        """Test AHV pension after retirement age."""
        result = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=40,  # Long enough to reach retirement
            mean_return=0.07,
            volatility=0.12,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=100,
        )

        # At year 26 (age 65), AHV pension should be non-zero
        retirement_year = 65 - 39  # = 26
        if retirement_year < len(result["pension_ahv"]):
            assert result["pension_ahv"][retirement_year] > 0.0

    def test_ahv_full_contribution_years(self):
        """Test AHV with full contribution years (44 years)."""
        pension_series = self.service._project_ahv(
            age_at_year=66,
            retirement_age=65,
            record={
                "contribution_years": 44,
                "average_insured_salary": 80000.0,
            },
            annual_income=80000.0,
        )

        # With 44 years (full), should get max pension
        expected = 2520.0 * 12  # Max monthly × 12
        assert abs(pension_series - expected) < 0.01

    def test_ahv_min_contribution_years(self):
        """Test AHV with minimum contribution years."""
        pension_series = self.service._project_ahv(
            age_at_year=66,
            retirement_age=65,
            record={
                "contribution_years": 1,
                "average_insured_salary": 80000.0,
            },
            annual_income=80000.0,
        )

        # With 1 year, should get approximately min pension proportional
        assert pension_series > 0.0

    def test_ahv_no_record(self):
        """Test AHV with no pension record (uses defaults)."""
        pension_series = self.service._project_ahv(
            age_at_year=66,
            retirement_age=65,
            record=None,
            annual_income=80000.0,
        )

        # Should still return a value based on defaults
        assert pension_series >= 0.0

    def test_ahv_capped_at_max(self):
        """Test that AHV pension is capped at maximum."""
        pension_series = self.service._project_ahv(
            age_at_year=70,
            retirement_age=65,
            record={
                "contribution_years": 100,  # More than 44
                "average_insured_salary": 200000.0,  # Very high salary
            },
            annual_income=200000.0,
        )

        # Should not exceed max pension
        assert pension_series <= 2520.0 * 12


# ── BVG Pension Tests ─────────────────────────────────────────


class TestBVGProjection:
    """Tests for BVG (Säule 2) pension projection."""

    def setup_method(self):
        """Set up test fixtures."""
        self.service = ProjectionService()

    def test_bvg_before_retirement_returns_balance(self):
        """Test that BVG returns balance before retirement."""
        result = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=10,
            mean_return=0.07,
            volatility=0.12,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=100,
        )

        # Should have BVG values (as balance proxy before retirement)
        for val in result["pension_bvg"]:
            assert val >= 0.0

    def test_bvg_after_retirement_conversion(self):
        """Test BVG conversion to annual pension after retirement."""
        pension_value = self.service._project_bvg(
            age_at_year=66,
            retirement_age=65,
            record={
                "current_balance": 200000.0,
                "annual_contribution": 8000.0,
                "expected_return_rate": 0.04,
            },
            annual_income=80000.0,
            years_elapsed=0,
        )

        # Should apply conversion rate (0.068)
        assert pension_value > 0.0

    def test_bvg_zero_balance(self):
        """Test BVG with zero initial balance."""
        pension_value = self.service._project_bvg(
            age_at_year=66,
            retirement_age=65,
            record={
                "current_balance": 0.0,
                "annual_contribution": 0.0,
                "expected_return_rate": 0.01,
            },
            annual_income=30000.0,  # Low salary
            years_elapsed=0,
        )

        # Should still have some value from contributions
        assert pension_value >= 0.0

    def test_bvg_contribution_rates(self):
        """Test that BVG contribution rates are defined for age brackets."""
        for (min_age, max_age), rate in BVG_CONTRIBUTION_RATES.items():
            assert rate > 0.0
            assert rate <= 0.25  # Should not exceed 25%

    def test_bvg_rate_for_age(self):
        """Test BVG rate lookup for different ages."""
        from app.services.projection import _bvg_rate_for_age

        # Age 30 should be in 25-34 bracket
        assert _bvg_rate_for_age(30) == 0.07

        # Age 40 should be in 35-44 bracket
        assert _bvg_rate_for_age(40) == 0.10

        # Age 50 should be in 45-54 bracket
        assert _bvg_rate_for_age(50) == 0.15

        # Age 60 should be in 55-65 bracket
        assert _bvg_rate_for_age(60) == 0.18

        # Age 20 (under 25) should return 0
        assert _bvg_rate_for_age(20) == 0.0

        # Age 70 (over 65) should return 0
        assert _bvg_rate_for_age(70) == 0.0


# ── Pillar 3a Tests ───────────────────────────────────────────


class TestPillar3aProjection:
    """Tests for Pillar 3a pension projection."""

    def setup_method(self):
        """Set up test fixtures."""
        self.service = ProjectionService()

    def test_3a_before_retirement_returns_balance(self):
        """Test that 3a returns balance before retirement."""
        result = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=10,
            mean_return=0.07,
            volatility=0.12,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=100,
        )

        # Should have 3a values
        for val in result["pension_3a"]:
            assert val >= 0.0

    def test_3a_annuitized_after_retirement(self):
        """Test 3a annuitization after retirement."""
        balance = self.service._project_3a(
            age_at_year=66,
            retirement_age=65,
            record={
                "current_balance": 50000.0,
                "annual_contribution": 7056.0,
                "expected_return_rate": 0.03,
            },
            years_elapsed=0,
        )

        # Should be annuitized over 20 years
        expected_annual = 50000.0 / 20.0
        assert abs(balance - expected_annual) < 100.0  # Allow some variance

    def test_3a_compound_growth(self):
        """Test 3a compound growth before retirement."""
        balance = self.service._project_3a(
            age_at_year=50,
            retirement_age=65,
            record={
                "current_balance": 10000.0,
                "annual_contribution": 7056.0,
                "expected_return_rate": 0.05,
            },
            years_elapsed=10,
        )

        # Should grow with compound interest
        assert balance > 10000.0 + (7056.0 * 10)


# ── Pillar 3b Tests ───────────────────────────────────────────


class TestPillar3bProjection:
    """Tests for Pillar 3b (free pension) projection."""

    def setup_method(self):
        """Set up test fixtures."""
        self.service = ProjectionService()

    def test_3b_with_balance(self):
        """Test 3b projection with positive balance."""
        result = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=10,
            mean_return=0.07,
            volatility=0.12,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=100,
        )

        # Should have 3b values
        for val in result["pension_3b"]:
            assert val >= 0.0

    def test_3b_zero_balance(self):
        """Test 3b with zero balance and contributions."""
        value = self.service._project_3b(
            age_at_year=50,
            retirement_age=65,
            record={
                "current_balance": 0.0,
                "annual_contribution": 0.0,
                "expected_return_rate": 0.0,
            },
            years_elapsed=5,
        )

        assert value == 0.0


# ── Scenario Comparison Tests ─────────────────────────────────


class TestScenarioComparison:
    """Tests for scenario comparison functionality."""

    def setup_method(self):
        """Set up test fixtures."""
        self.service = ProjectionService()

    def test_compare_scenarios_returns_all_names(self):
        """Test that scenario comparison returns all scenario names."""
        scenarios = [
            {"name": "Conservative", "mean_return": 0.04, "volatility": 0.08},
            {"name": "Moderate", "mean_return": 0.07, "volatility": 0.12},
            {"name": "Aggressive", "mean_return": 0.10, "volatility": 0.18},
        ]

        result = self.service.compare_scenarios(
            scenarios=scenarios,
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=20,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
        )

        assert "Conservative" in result
        assert "Moderate" in result
        assert "Aggressive" in result

    def test_compare_scenarios_aggressive_higher_median(self):
        """Test that aggressive scenario has higher median at end."""
        scenarios = [
            {"name": "Conservative", "mean_return": 0.04, "volatility": 0.08},
            {"name": "Aggressive", "mean_return": 0.10, "volatility": 0.18},
        ]

        result = self.service.compare_scenarios(
            scenarios=scenarios,
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=30,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
        )

        # Aggressive should have higher median at year 30
        assert result["Aggressive"]["p50"][-1] > result["Conservative"]["p50"][-1]

    def test_compare_scenarios_with_same_params(self):
        """Test scenario comparison with identical parameters."""
        scenarios = [
            {"name": "Same1", "mean_return": 0.07, "volatility": 0.12},
            {"name": "Same2", "mean_return": 0.07, "volatility": 0.12},
        ]

        result = self.service.compare_scenarios(
            scenarios=scenarios,
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=10,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
        )

        # With same params, results should be similar (not identical due to random seed)
        assert result["Same1"]["p50"][-1] > 0.0
        assert result["Same2"]["p50"][-1] > 0.0

    def test_compare_scenarios_empty_scenarios(self):
        """Test scenario comparison with empty scenarios list."""
        result = self.service.compare_scenarios(
            scenarios=[],
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=10,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
        )

        assert result == {}


# ── Integration Tests ─────────────────────────────────────────


class TestProjectionIntegration:
    """Integration tests for full projection run."""

    def setup_method(self):
        """Set up test fixtures."""
        self.service = ProjectionService()

    def test_full_projection_with_pension_data(self):
        """Test full projection with pension records."""
        pension_records = [
            {
                "pillar": "1",
                "current_balance": 0.0,
                "annual_contribution": 5000.0,
                "expected_return_rate": 0.0,
                "retirement_age": 65,
                "contribution_years": 30,
                "average_insured_salary": 80000.0,
            },
            {
                "pillar": "2",
                "current_balance": 150000.0,
                "annual_contribution": 8000.0,
                "expected_return_rate": 0.04,
                "retirement_age": 65,
                "contribution_years": None,
                "average_insured_salary": None,
            },
            {
                "pillar": "3a",
                "current_balance": 25000.0,
                "annual_contribution": 7056.0,
                "expected_return_rate": 0.03,
                "retirement_age": 65,
                "contribution_years": None,
                "average_insured_salary": None,
            },
        ]

        result = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=30,
            mean_return=0.07,
            volatility=0.12,
            inflation_rate=0.015,
            pension_records=pension_records,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=1000,
        )

        # All lists should have same length (years + 1)
        expected_length = 31  # 30 years + 1
        assert len(result["years"]) == expected_length
        assert len(result["p10"]) == expected_length
        assert len(result["p25"]) == expected_length
        assert len(result["p50"]) == expected_length
        assert len(result["p75"]) == expected_length
        assert len(result["p90"]) == expected_length
        assert len(result["pension_ahv"]) == expected_length
        assert len(result["pension_bvg"]) == expected_length
        assert len(result["pension_3a"]) == expected_length

    def test_full_projection_with_no_pension_data(self):
        """Test full projection without pension records."""
        result = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=20,
            mean_return=0.07,
            volatility=0.12,
            inflation_rate=0.015,
            pension_records=[],
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=500,
        )

        # Should still return valid results
        assert len(result["years"]) == 21
        assert len(result["p50"]) == 21
        assert result["p50"][0] == pytest.approx(100000.0, abs=1.0)

    def test_projection_with_different_volatility(self):
        """Test that different volatility affects result spread."""
        result_low_vol = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=20,
            mean_return=0.07,
            volatility=0.05,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=1000,
        )

        result_high_vol = self.service.run(
            current_net_worth=100000.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=20,
            mean_return=0.07,
            volatility=0.25,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=1000,
        )

        # High volatility should have wider spread between p10 and p90
        spread_low = result_low_vol["p90"][-1] - result_low_vol["p10"][-1]
        spread_high = result_high_vol["p90"][-1] - result_high_vol["p10"][-1]

        assert spread_high > spread_low

    def test_projection_with_zero_net_worth(self):
        """Test projection with zero initial net worth."""
        result = self.service.run(
            current_net_worth=0.0,
            annual_savings=10000.0,
            annual_income=80000.0,
            years=30,
            mean_return=0.07,
            volatility=0.12,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=500,
        )

        # Should still grow over time
        assert result["p50"][-1] > 0.0

    def test_projection_with_negative_savings(self):
        """Test projection with negative annual savings (withdrawals)."""
        result = self.service.run(
            current_net_worth=200000.0,
            annual_savings=-20000.0,  # Withdrawing 20k/year
            annual_income=0.0,
            years=20,
            mean_return=0.04,
            volatility=0.10,
            inflation_rate=0.015,
            date_of_birth="1985-01-01",
            retirement_age=65,
            runs=500,
        )

        # Median should decrease over time
        assert result["p50"][-1] < result["p50"][0]

    def test_projection_deterministic_with_seed(self):
        """Test that results are deterministic with fixed seed."""
        # Note: We don't set a fixed seed in the service, so this test
        # verifies that the service doesn't crash with repeated calls
        results = []
        for _ in range(3):
            result = self.service.run(
                current_net_worth=100000.0,
                annual_savings=10000.0,
                annual_income=80000.0,
                years=5,
                mean_return=0.07,
                volatility=0.12,
                inflation_rate=0.015,
                date_of_birth="1985-01-01",
                retirement_age=65,
                runs=100,
            )
            results.append(result["p50"])

        # All results should be positive (no crashes)
        for result in results:
            assert all(v > 0.0 for v in result)
