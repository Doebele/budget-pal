"""
Budget-Pal — Fälligkeiten eines Budgetplan-Eintrags.

Diese Logik lag bisher nur im Frontend (`Budgetplan.tsx:getApplicableMonths`)
und war ungetestet, obwohl sie die kniffligste Rechnung des Features ist. Sie
hatte dort zwei Fehler, die die Monatssummen verfälschten — beide sind hier
festgehalten.
"""

from datetime import date

import pytest

from app.services.plan_schedule import (
    applicable_months,
    monthly_equivalent,
    occurrences_per_month,
)


class TestApplicableMonths:
    def test_monthly_covers_the_whole_year(self):
        months = applicable_months("monthly", date(2026, 1, 1), None, 2026)
        assert months == list(range(1, 13))

    def test_quarterly_anchors_on_the_start_month(self):
        """Ein quartalsweiser Eintrag ab März fällt im März an, nicht im Januar."""
        months = applicable_months("quarterly", date(2026, 3, 1), None, 2026)
        assert months == [3, 6, 9, 12]

    def test_halfyearly_anchors_too(self):
        assert applicable_months("halfyearly", date(2026, 2, 1), None, 2026) == [2, 8]

    def test_yearly_hits_the_anchor_month_only(self):
        assert applicable_months("yearly", date(2026, 7, 15), None, 2026) == [7]

    def test_start_in_a_later_year_yields_nothing(self):
        assert applicable_months("monthly", date(2027, 1, 1), None, 2026) == []

    def test_end_in_an_earlier_year_yields_nothing(self):
        assert applicable_months(
            "monthly", date(2024, 1, 1), date(2025, 12, 31), 2026
        ) == []

    def test_start_mid_year_begins_at_the_start_month(self):
        months = applicable_months("monthly", date(2026, 5, 10), None, 2026)
        assert months == [5, 6, 7, 8, 9, 10, 11, 12]

    def test_end_mid_year_stops_at_the_end_month(self):
        months = applicable_months(
            "monthly", date(2025, 1, 1), date(2026, 4, 30), 2026
        )
        assert months == [1, 2, 3, 4]

    def test_ongoing_entry_from_an_earlier_year_covers_everything(self):
        months = applicable_months("monthly", date(2020, 6, 1), None, 2026)
        assert months == list(range(1, 13))

    def test_quarterly_from_an_earlier_year_keeps_its_anchor(self):
        """Der Anker bleibt der Startmonat, auch über Jahresgrenzen hinweg."""
        months = applicable_months("quarterly", date(2024, 2, 1), None, 2026)
        assert months == [2, 5, 8, 11]


class TestOccurrencesPerMonth:
    def test_weekly_counts_more_than_once(self):
        """Der Fehler im Frontend: `weekly` wurde wie `monthly` behandelt, ein
        wöchentlicher Eintrag ging damit einfach statt 4,33-fach in die
        Monatssumme ein."""
        assert occurrences_per_month("weekly") == pytest.approx(52 / 12)

    def test_others_are_once(self):
        for p in ("monthly", "quarterly", "halfyearly", "yearly"):
            assert occurrences_per_month(p) == 1.0

    def test_unknown_falls_back_to_once(self):
        assert occurrences_per_month(None) == 1.0
        assert occurrences_per_month("irgendwas") == 1.0


class TestMonthlyEquivalent:
    def test_weekly_scales_up(self):
        assert monthly_equivalent(100, "weekly") == pytest.approx(100 * 52 / 12)

    def test_yearly_scales_down(self):
        assert monthly_equivalent(1_200, "yearly") == pytest.approx(100)

    def test_quarterly_scales_down(self):
        assert monthly_equivalent(300, "quarterly") == pytest.approx(100)

    def test_monthly_is_unchanged(self):
        assert monthly_equivalent(250, "monthly") == 250
