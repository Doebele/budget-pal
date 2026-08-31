"""
Budget-Pal — Periodizitaet aus Buchungshaeufigkeit erraten.

Die frühere Staffelung hatte eine Luecke: 6 bis 9 verschiedene Monate fielen
durch alle Zweige und landeten auf "yearly". Eine Zahlung, die in acht Monaten
des Jahres auftaucht, ist alles andere als jaehrlich — der Vorbefuellen-Dialog
schlug sie mit falscher Periodizitaet vor.
"""

import pytest

from app.api.recurring_plan import _infer_periodicity


class TestInferPeriodicity:
    @pytest.mark.parametrize("months", [8, 9, 10, 11, 12])
    def test_frequent_months_are_monthly(self, months):
        assert _infer_periodicity(months) == "monthly"

    @pytest.mark.parametrize("months", [3, 4, 5, 6, 7])
    def test_middle_range_is_quarterly(self, months):
        """Der Bereich 6-9 fiel vorher auf "yearly" durch."""
        assert _infer_periodicity(months) == "quarterly"

    def test_two_months_are_halfyearly(self):
        assert _infer_periodicity(2) == "halfyearly"

    @pytest.mark.parametrize("months", [0, 1])
    def test_rare_months_are_yearly(self, months):
        assert _infer_periodicity(months) == "yearly"

    def test_every_month_count_yields_a_known_periodicity(self):
        """Kein Monatswert darf ins Leere laufen."""
        valid = {"monthly", "quarterly", "halfyearly", "yearly"}
        assert all(_infer_periodicity(m) in valid for m in range(0, 13))

    def test_result_is_monotone(self):
        """Mehr Buchungsmonate duerfen nie eine seltenere Periodizitaet ergeben."""
        rank = {"yearly": 0, "halfyearly": 1, "quarterly": 2, "monthly": 3}
        ranks = [rank[_infer_periodicity(m)] for m in range(0, 13)]
        assert ranks == sorted(ranks)
