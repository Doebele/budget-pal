"""Ableitungen aus den Wizard-Angaben — Jahresbeträge, Haushaltsprämie, Hypothekarzins."""

import pytest

from app.services.wizard_derive import (
    health_insurance_monthly,
    monthly_amount,
    mortgage_interest_monthly,
    mortgage_tranches_from_wizard,
)


def test_yearly_amount_is_converted_to_monthly():
    assert monthly_amount(2_000, "jahr") == pytest.approx(166.666, abs=0.01)
    assert monthly_amount(2_000, "monat") == 2_000
    # Fehlende Angabe = wie bisher monatlich (Rückwärtskompatibilität alter Payloads)
    assert monthly_amount(2_000, None) == 2_000


def test_health_insurance_sums_individual_premiums():
    assert health_insurance_monthly(0, "person", [420, 380, 75, 75]) == 950
    # Total-Modus ignoriert die Einzelprämien
    assert health_insurance_monthly(950, "total", [420, 380]) == 950
    # Ohne Personenliste zählt der Einzelbetrag (Payloads vor der Personenliste)
    assert health_insurance_monthly(420, "person", []) == 420
    assert health_insurance_monthly(420, None, None) == 420


def test_mortgage_interest_sums_tranches():
    # 280k@1.05% + 225k@0.5% + 180k@0.5% = 4_965/Jahr
    tranches = [(280_000, 1.05), (225_000, 0.5), (180_000, 0.5)]
    assert mortgage_interest_monthly(tranches) == pytest.approx(413.75, abs=0.01)
    assert mortgage_interest_monthly([]) == 0.0


def test_tranches_fall_back_to_single_mortgage():
    data = {"mortgageEntries": [], "outstandingDebt": 500_000, "mortgageRate": 1.8}
    assert mortgage_tranches_from_wizard(data) == [(500_000.0, 1.8)]
    # Tranchen haben Vorrang vor der Einzelangabe
    data["mortgageEntries"] = [{"debtValue": 100_000, "mortgageRate": 1.0}]
    assert mortgage_tranches_from_wizard(data) == [(100_000.0, 1.0)]
    assert mortgage_tranches_from_wizard({}) == []
