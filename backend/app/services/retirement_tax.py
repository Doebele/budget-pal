"""Steuern im Ruhestand: Einkommenssteuer auf Renten und Vermoegenssteuer.

Renten aus AHV und Pensionskasse sind zu 100 % steuerbares Einkommen. Dazu
kommt der Ertrag des freien Vermoegens (Dividenden, Zinsen; Kursgewinne sind
steuerfrei) und die Vermoegenssteuer. Kapitalbezuege werden getrennt davon
besteuert (capital_tax).

Werte aus dem ESTV-Steuerrechner 2026 fuer den Kantonshauptort, ohne
Kirchensteuer, Alter 65 (data/income_tax_2026.json): Bund + Kanton + Gemeinde
inklusive der ueblichen Abzuege fuer Rentner. Zwischen den Stuetzwerten linear,
darueber mit dem Satz des hoechsten Stuetzwerts. In heutigen Franken — die
Tarife werden an die Teuerung angepasst.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

import numpy as np

from app.services.capital_tax import DEFAULT_CANTON

_DATA_FILE = Path(__file__).parent / "data" / "income_tax_2026.json"

#: Steuerbarer Ertrag des freien Vermoegens pro Jahr (Dividenden, Zinsen).
#: ponytail: typische Ausschuettung eines breit gestreuten Portfolios; die
#: Kursgewinne sind fuer Privatanleger steuerfrei.
INVESTMENT_YIELD: float = 0.02


@lru_cache(maxsize=1)
def _table() -> dict:
    return json.loads(_DATA_FILE.read_text(encoding="utf-8"))


def _row(canton: str) -> dict:
    cantons = _table()["cantons"]
    return cantons.get((canton or DEFAULT_CANTON).upper()) or cantons[DEFAULT_CANTON]


def _lookup(amounts, taxes, value):
    """Steuer fuer `value` (Skalar oder Array): linear zwischen (0, 0) und den
    Stuetzwerten, darueber mit dem letzten Durchschnittssatz."""
    value = np.maximum(np.asarray(value, dtype=np.float64), 0.0)
    xs = np.concatenate(([0.0], np.asarray(amounts, dtype=np.float64)))
    ys = np.concatenate(([0.0], np.asarray(taxes, dtype=np.float64)))
    inside = np.interp(value, xs, ys)
    return np.where(value > xs[-1], value * ys[-1] / xs[-1], inside)


def income_tax(income, canton: str = DEFAULT_CANTON, married: bool = False):
    """Einkommenssteuer (Bund, Kanton, Gemeinde) auf Renteneinkommen pro Jahr."""
    row = _row(canton)
    return _lookup(_table()["income_amounts"], row["income_married" if married else "income_single"], income)


def wealth_tax(wealth, canton: str = DEFAULT_CANTON, married: bool = False):
    """Vermoegenssteuer (Kanton, Gemeinde) pro Jahr; der Bund kennt keine."""
    row = _row(canton)
    return _lookup(_table()["wealth_amounts"], row["wealth_married" if married else "wealth_single"], wealth)


def retirement_tax(pension_income, wealth, canton: str = DEFAULT_CANTON, married: bool = False):
    """Jaehrliche Steuer im Ruhestand: Renten plus Vermoegensertrag als
    Einkommen, dazu die Vermoegenssteuer. Nimmt Skalare oder Arrays."""
    wealth = np.maximum(np.asarray(wealth, dtype=np.float64), 0.0)
    taxable = np.asarray(pension_income, dtype=np.float64) + INVESTMENT_YIELD * wealth
    return income_tax(taxable, canton, married) + wealth_tax(wealth, canton, married)
