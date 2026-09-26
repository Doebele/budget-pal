"""Steuer auf Kapitalleistungen aus Vorsorge (Pensionskasse, Saeule 3a).

Kapitalbezuege werden getrennt vom uebrigen Einkommen besteuert, jeweils fuer
das Kalenderjahr der Auszahlung. Alle Kapitalbezuege desselben Jahres werden
zusammengezaehlt (bei Ehepaaren auch die beider Partner) — darum lohnt es sich,
3a-Konten und Pensionskassenkapital auf mehrere Jahre zu verteilen.

- Bundessteuer: ein Fuenftel des ordentlichen Tarifs (Art. 38 DBG), Tarif 2026
  (ESTV Form. 58c). Die geplante Verschaerfung aus dem Entlastungspaket 27 hat
  das Parlament im Maerz 2026 gestrichen.
- Kantons- und Gemeindesteuer: Werte des ESTV-Steuerrechners fuer den
  Kantonshauptort (data/capital_tax_2026.json), zwischen den Stuetzbetraegen
  linear im Steuersatz interpoliert.

Alles in heutigen CHF: Tarife werden laufend an die Teuerung angepasst (kalte
Progression), ein realer Betrag bleibt damit ungefaehr gleich belastet.
"""
from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

#: Direkte Bundessteuer 2026, Art. 36 DBG: (ab Einkommen, Steuer dort, Satz je 100 CHF).
#: Hoechstens 11.5 % des Einkommens (Tarifende). Quelle: ESTV Form. 58c-2026.
FEDERAL_TARIFF_2026: Dict[bool, List[Tuple[int, float, float]]] = {
    False: [  # Alleinstehende
        (15_200, 0.00, 0.77), (33_200, 138.60, 0.88), (43_500, 229.20, 2.64),
        (58_000, 612.00, 2.97), (76_200, 1_152.50, 5.94), (82_100, 1_502.95, 6.60),
        (108_900, 3_271.75, 8.80), (141_500, 6_140.55, 11.00), (185_100, 10_936.55, 13.20),
    ],
    True: [  # Verheiratete und Einelternfamilien
        (29_700, 0.0, 1.0), (53_400, 237.0, 2.0), (61_300, 395.0, 3.0), (79_100, 929.0, 4.0),
        (94_900, 1_561.0, 5.0), (108_700, 2_251.0, 6.0), (120_600, 2_965.0, 7.0),
        (130_500, 3_658.0, 8.0), (138_400, 4_290.0, 9.0), (144_300, 4_821.0, 10.0),
        (148_300, 5_221.0, 11.0), (150_400, 5_452.0, 12.0), (152_400, 5_692.0, 13.0),
    ],
}
FEDERAL_MAX_RATE = 0.115
#: Art. 38 DBG: Kapitalleistungen aus Vorsorge zu einem Fuenftel des Tarifs.
FEDERAL_CAPITAL_SHARE = 0.2
#: Ohne bekannten Kanton — Zuerich als verbreitetster Wohnkanton.
DEFAULT_CANTON = "ZH"

_DATA_FILE = Path(__file__).parent / "data" / "capital_tax_2026.json"


def federal_income_tax(income: float, married: bool = False) -> float:
    """Direkte Bundessteuer nach dem ordentlichen Tarif. Restbetraege unter 100
    CHF fallen weg, die Steuer wird auf 5 Rappen abgerundet."""
    taxable = math.floor(max(0.0, income) / 100) * 100
    tax = 0.0
    for lower, base, rate in FEDERAL_TARIFF_2026[married]:
        if taxable >= lower:
            tax = base + (taxable - lower) / 100 * rate
    tax = min(tax, taxable * FEDERAL_MAX_RATE)
    return math.floor(tax * 20 + 1e-6) / 20


def federal_capital_tax(amount: float, married: bool = False) -> float:
    return federal_income_tax(amount, married) * FEDERAL_CAPITAL_SHARE


@lru_cache(maxsize=1)
def _cantonal_table() -> dict:
    return json.loads(_DATA_FILE.read_text(encoding="utf-8"))


def known_cantons() -> List[str]:
    return sorted(_cantonal_table()["cantons"])


def cantonal_capital_tax(amount: float, canton: str = DEFAULT_CANTON, married: bool = False) -> float:
    """Kantons- und Gemeindesteuer im Kantonshauptort.

    ponytail: Stuetzwerte fuer 50'000 bis 2 Mio., dazwischen linear im
    Steuersatz; darunter der Satz von 50'000 (leicht zu hoch), darueber der von
    2 Mio. Die Gemeinde am Wohnort weicht vom Kantonshauptort ab.
    """
    if amount <= 0:
        return 0.0
    table = _cantonal_table()
    row = table["cantons"].get((canton or DEFAULT_CANTON).upper()) or table["cantons"][DEFAULT_CANTON]
    amounts = table["amounts"]
    rates = [tax / amt for tax, amt in zip(row["married" if married else "single"], amounts)]
    if amount <= amounts[0]:
        return amount * rates[0]
    if amount >= amounts[-1]:
        return amount * rates[-1]
    for (a0, r0), (a1, r1) in zip(zip(amounts, rates), zip(amounts[1:], rates[1:])):
        if a0 <= amount <= a1:
            return amount * (r0 + (r1 - r0) * (amount - a0) / (a1 - a0))
    return amount * rates[-1]  # nicht erreichbar


def capital_tax(amount: float, canton: str = DEFAULT_CANTON, married: bool = False) -> float:
    """Gesamte Steuer auf einen Kapitalbezug (Bund + Kanton + Gemeinde)."""
    return federal_capital_tax(amount, married) + cantonal_capital_tax(amount, canton, married)


def tax_profile(wizard_params: Optional[dict]) -> Tuple[str, bool]:
    """Kanton und Tarif aus dem Wizard-Szenario.

    ponytail: der Wizard kennt den Haushaltstyp, nicht den Zivilstand. Paar
    und Familie gelten als verheiratet, Alleinerziehende bekommen den
    Verheiratetentarif ohnehin (Einelternfamilie) — ein unverheiratetes Paar
    ohne Kinder rechnet damit etwas zu guenstig.
    """
    p = wizard_params or {}
    canton = str(p.get("kanton") or DEFAULT_CANTON).upper()
    married = p.get("household_type") in ("couple", "family", "single-parent")
    return canton, married


def tax_by_year(
    withdrawals: Iterable[Tuple[int, float]], canton: str = DEFAULT_CANTON, married: bool = False
) -> Dict[int, float]:
    """Steuer je Kalenderjahr: alle Bezuege eines Jahres werden zusammengezaehlt."""
    per_year: Dict[int, float] = {}
    for year, amount in withdrawals:
        per_year[year] = per_year.get(year, 0.0) + amount
    return {year: capital_tax(total, canton, married) for year, total in per_year.items()}
