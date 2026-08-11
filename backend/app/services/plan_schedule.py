"""
Fälligkeiten eines Budgetplan-Eintrags.

Die Frage „in welchen Monaten eines Jahres fällt dieser Eintrag an, und wie
oft je Monat" wird an drei Stellen gebraucht: im Plan-Ist-Abgleich, in den
Monatssummen der Budgetplan-Ansicht und in den Fälligkeitswarnungen. Bisher
gab es sie nur im Frontend (`Budgetplan.tsx:getApplicableMonths`) — dort mit
einem Fehler bei `weekly`, das wie `monthly` behandelt wurde und deshalb
einfach statt 4,33-fach in die Summen einging.
"""

from __future__ import annotations

from datetime import date
from typing import List, Optional

#: Wie oft ein Eintrag pro Monat anfällt. 52/12 ≈ 4.33 Wochen je Monat —
#: derselbe Faktor, mit dem `budget_multimodal.py` bereits rechnet.
OCCURRENCES_PER_MONTH = {
    "weekly": 52 / 12,
    "monthly": 1.0,
    "quarterly": 1.0,
    "halfyearly": 1.0,
    "yearly": 1.0,
    "once": 1.0,
}

#: Monatsabstand zwischen zwei Fälligkeiten.
MONTH_STEP = {
    "weekly": 1,
    "monthly": 1,
    "quarterly": 3,
    "halfyearly": 6,
    "yearly": 12,
}


def occurrences_per_month(periodicity: Optional[str]) -> float:
    """Anzahl Fälligkeiten je Monat, in dem der Eintrag anfällt."""
    return OCCURRENCES_PER_MONTH.get(periodicity or "monthly", 1.0)


def applicable_months(
    periodicity: Optional[str],
    start_date: date,
    end_date: Optional[date],
    year: int,
) -> List[int]:
    """Monate (1–12) des Jahres, in denen der Eintrag anfällt.

    Der Ankermonat ist der Startmonat: ein quartalsweiser Eintrag ab März
    fällt im März, Juni, September und Dezember an, nicht im Januar.
    """
    if start_date.year > year:
        return []
    if end_date is not None and end_date.year < year:
        return []

    first = start_date.month if start_date.year == year else 1
    last = end_date.month if end_date is not None and end_date.year == year else 12
    if first > last:
        return []

    step = MONTH_STEP.get(periodicity or "monthly", 1)
    anchor = start_date.month

    if (periodicity or "monthly") == "once":
        return [anchor] if start_date.year == year and first <= anchor <= last else []

    return [m for m in range(first, last + 1) if (m - anchor) % step == 0]


def monthly_equivalent(amount: float, periodicity: Optional[str]) -> float:
    """Betrag auf einen Monatswert umgerechnet — für Vergleiche über Perioden."""
    p = periodicity or "monthly"
    if p == "weekly":
        return amount * OCCURRENCES_PER_MONTH["weekly"]
    step = MONTH_STEP.get(p, 1)
    return amount / step
