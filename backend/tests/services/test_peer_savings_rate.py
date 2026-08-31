"""
Budget-Pal — Sparquote der Vergleichsgruppe.

Die Sparquote wurde vorher gegen eine feste Zahl bewertet: `rate * 4`, also
25 % als Bestwert — gleich, ob jemand 3'800 oder 18'500 im Monat hat. Die
BFS-Erhebung zeigt 8 % bei tiefen und 26 % bei hohen Einkommen; dieselbe
Quote bedeutet je nach Haushalt etwas voellig anderes.
"""

import pytest

from app.services.peer_group import (
    INCOME_MEDIANS,
    SAVINGS_RATES,
    classify_income_level,
    peer_savings_rate,
)


class TestClassifyIncomeLevel:
    def test_median_income_is_medium(self):
        for household, medians in INCOME_MEDIANS.items():
            assert classify_income_level(medians["medium"], household) == "medium"

    def test_low_and_high_medians_land_in_their_bucket(self):
        for household, medians in INCOME_MEDIANS.items():
            assert classify_income_level(medians["low"], household) == "low"
            assert classify_income_level(medians["high"], household) == "high"

    def test_household_type_shifts_the_boundaries(self):
        """6'200 ist fuer eine Einzelperson das mittlere Einkommen, fuer eine
        Familie das untere — sonst vergliche sich ein Vierpersonenhaushalt
        mit den Sparquoten von Singles."""
        assert classify_income_level(6_200, "single") == "medium"
        assert classify_income_level(6_200, "family") == "low"

    def test_unknown_household_falls_back_instead_of_raising(self):
        assert classify_income_level(6_200, "wohngemeinschaft") in SAVINGS_RATES


class TestPeerSavingsRate:
    def test_rate_rises_with_income(self):
        low = peer_savings_rate(3_500, "single")
        mid = peer_savings_rate(6_200, "single")
        high = peer_savings_rate(14_000, "single")
        assert low < mid < high

    def test_values_come_from_the_bfs_table(self):
        assert peer_savings_rate(6_200, "single") == float(SAVINGS_RATES["medium"])

    def test_without_income_the_middle_group_is_the_reference(self):
        """Null Einkommen heisst "unbekannt", nicht "arm" — die tiefe Quote
        waere hier eine Aussage, die die Daten nicht hergeben."""
        assert peer_savings_rate(0.0) == float(SAVINGS_RATES["medium"])
        assert peer_savings_rate(-100.0) == float(SAVINGS_RATES["medium"])

    def test_every_rate_is_a_plausible_percentage(self):
        for household in INCOME_MEDIANS:
            for income in (2_000, 6_000, 12_000, 30_000):
                rate = peer_savings_rate(income, household)
                assert 0 < rate < 100
