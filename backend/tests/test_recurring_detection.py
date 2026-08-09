"""
Budget-Pal Backend — Erkennung wiederkehrender Buchungen beim Import

Die Buckets werden aus dem Median-Abstand zwischen Buchungen desselben
Haendlers abgeleitet. `weekly` fehlte, weil der kleinste Bucket bei 22 Tagen
begann — woechentliche Ausgaben blieben damit immer "einmalig".
"""

from datetime import date, timedelta

from app.api.imports import PdfPreviewTransaction, _detect_recurring_periodicity


def rows_every(days: int, count: int = 6, description: str = "Zeitung Abo"):
    """Gleiche Buchung im festen Abstand — so sieht ein Abo im Auszug aus."""
    start = date(2026, 1, 5)
    return [
        PdfPreviewTransaction(
            id=f"r{i}",
            original_date=(start + timedelta(days=days * i)).strftime("%Y-%m-%d"),
            amount=-4.50,
            description=description,
        )
        for i in range(count)
    ]


def detected(days: int) -> str | None:
    result = _detect_recurring_periodicity(rows_every(days))
    return result[0].periodicity


class TestPeriodicityBuckets:
    def test_weekly(self):
        assert detected(7) == "weekly"

    def test_weekly_tolerates_drift(self):
        # Buchungstage verschieben sich um Wochenenden und Feiertage
        assert detected(6) == "weekly"
        assert detected(9) == "weekly"

    def test_monthly(self):
        assert detected(30) == "monthly"

    def test_quarterly(self):
        assert detected(91) == "quarterly"

    def test_halfyearly(self):
        assert detected(182) == "halfyearly"

    def test_yearly(self):
        assert detected(365) == "yearly"

    def test_gap_between_buckets_stays_unclassified(self):
        # 14 Tage liegt zwischen weekly und monthly — lieber nichts behaupten
        assert detected(14) is None

    def test_daily_is_not_weekly(self):
        # Taegliche Buchungen sind kein Abo, sondern z. B. Kaffee
        assert detected(1) is None


class TestFlagging:
    def test_recurring_rows_are_marked(self):
        result = _detect_recurring_periodicity(rows_every(7))
        assert all(r.is_recurring for r in result)

    def test_single_occurrence_is_untouched(self):
        result = _detect_recurring_periodicity(rows_every(7, count=1))
        assert result[0].periodicity is None
        assert result[0].is_recurring is False

    def test_unrelated_descriptions_are_not_grouped(self):
        rows = rows_every(7, count=3, description="Zeitung Abo") + rows_every(
            7, count=3, description="Fitnessstudio"
        )
        result = _detect_recurring_periodicity(rows)
        # Beide Gruppen sind fuer sich woechentlich
        assert {r.periodicity for r in result} == {"weekly"}
