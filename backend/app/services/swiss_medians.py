"""Vergleichswerte: wo steht man im Vergleich zum Median?

- Freies Vermoegen nach Alter: Median des Aequivalenz-Reinvermoegens nach
  Alter der Referenzperson, Steuerdaten Kanton Luzern 2020 (LUSTAT, FinSit
  2024). Ohne Pensionskasse und nicht bezogene 3a — wie das freie Vermoegen der
  Prognose. Eine schweizweite Reihe nach Alter gibt es nicht: die ESTV erhaelt
  von den Kantonen keine Altersangaben.
  ponytail: Luzern als Naeherung fuer die Schweiz; ab 75 fehlt der Wert.
- Neurenten 2024 (BFS, Statistik der beruflichen Vorsorge, 27.11.2025): Median
  der Pensionskassen-Rente und des Kapitalbezugs, nach Geschlecht.
- Einkommen im Ruhestand: Median des verfuegbaren Aequivalenzeinkommens der
  Personen ab 65, SILC 2018 (BFS, "Armut im Alter", 2020): 44'899 CHF/Jahr
  (Erwerbsalter 53'141). Verfuegbar = nach Steuern, Sozialbeitraegen und
  Krankenkasse; Vermoegensertrag zaehlt, Kapitalverzehr nicht.
  ponytail: aktuellste Zahl nach Alter; ein Paar hat das 1.5-fache.
"""
from typing import Optional

import numpy as np

#: (von Alter, bis Alter, Median CHF) je Haushalt mit einer Person
WEALTH_BY_AGE = [
    (18, 25, 15_800), (26, 34, 26_000), (35, 44, 26_900),
    (45, 54, 49_700), (55, 64, 104_600), (65, 74, 240_700),
]
#: Aequivalenzskala (modifizierte OECD): zweite erwachsene Person 0.5
COUPLE_FACTOR = 1.5

NEW_PENSIONS_2024 = {
    "bvg_monthly": {"men": 2_042, "women": 1_227},
    "bvg_capital": {"men": 201_825, "women": 82_942},
}


#: verfuegbares Aequivalenzeinkommen ab 65, CHF pro Jahr (SILC 2018)
RETIREE_INCOME_MEDIAN = 44_899


def retiree_income_monthly(married: bool = False) -> float:
    """Median-Einkommen eines Rentnerhaushalts pro Monat."""
    return RETIREE_INCOME_MEDIAN / 12 * (COUPLE_FACTOR if married else 1.0)


def median_wealth(age: int, married: bool = False) -> Optional[float]:
    """Median des freien Vermoegens im Alter `age` (Haushalt), linear zwischen
    den Mitten der Altersgruppen; ausserhalb 18-74 keiner."""
    lo, hi = WEALTH_BY_AGE[0][0], WEALTH_BY_AGE[-1][1]
    if not lo <= age <= hi:
        return None
    mids = [(a + b) / 2 for a, b, _ in WEALTH_BY_AGE]
    values = [v for _, _, v in WEALTH_BY_AGE]
    return float(np.interp(age, mids, values)) * (COUPLE_FACTOR if married else 1.0)
