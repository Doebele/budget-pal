"""Ableitungen aus den Wizard-Angaben.

Geteilt von `/wizard/complete` (Pydantic-Payload) und `/recurring-plan/suggestions`
(rohes wizard_data_json), damit beide Konsumenten dieselben Zahlen sehen.
"""

from __future__ import annotations

from typing import Iterable, Optional, Sequence, Tuple


def monthly_amount(amount: Optional[float], period: Optional[str]) -> float:
    """Jahresbeträge auf Monatsbasis umrechnen.

    Der Wizard erfasst die meisten Posten monatlich; einzelne (z.B. die
    Autoversicherung) werden einmal jährlich fällig.
    """
    value = float(amount or 0.0)
    return value / 12 if period == "jahr" else value


def health_insurance_monthly(
    amount: Optional[float],
    mode: Optional[str] = "person",
    premiums: Optional[Iterable[float]] = None,
) -> float:
    """Krankenkassenprämie des Haushalts pro Monat.

    mode "person": Summe der einzeln erfassten Prämien.
    mode "total":  erfasster Betrag ist bereits das Haushaltstotal.

    Ohne Einzelprämien (Payloads vor der Personenliste) zählt der Einzelbetrag.
    """
    value = float(amount or 0.0)
    if mode == "total":
        return value
    items = [float(p or 0.0) for p in (premiums or [])]
    return sum(items) if items else value


def mortgage_interest_monthly(tranches: Iterable[Tuple[float, float]]) -> float:
    """Hypothekarzins pro Monat aus (Schuld, Zinssatz in %)-Paaren.

    Die Amortisation ist ein separater Budgetposten — hier zählt nur der Zins.
    """
    annual = sum(float(debt or 0.0) * float(rate or 0.0) / 100 for debt, rate in tranches)
    return annual / 12


def mortgage_tranches_from_wizard(data: dict) -> Sequence[Tuple[float, float]]:
    """(Schuld, Zinssatz)-Paare aus rohem wizard_data_json lesen.

    Fällt auf die Einzelhypothek aus Schritt 6 zurück, wenn keine Tranchen erfasst sind.
    """
    entries = data.get("mortgageEntries") or []
    pairs = [
        (float(e.get("debtValue") or 0.0), float(e.get("mortgageRate") or 0.0))
        for e in entries
        if float(e.get("debtValue") or 0.0) > 0
    ]
    if pairs:
        return pairs
    debt = float(data.get("outstandingDebt") or data.get("propertyAssetDebt") or 0.0)
    if debt <= 0:
        return []
    return [(debt, float(data.get("mortgageRate") or 0.0))]
