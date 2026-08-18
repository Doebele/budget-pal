"""
Anonymer Beispiel-Datensatz.

Zwischen Registrierung und der ersten brauchbaren Zahl stand bisher ein
achtstufiger Wizard mit ueber 50 Feldern. Wer die Unterlagen nicht zur Hand
hat — oder die App nur ansehen will, bevor er ihr Kontoauszuege anvertraut —
bricht ab und sieht nie, was sie kann.

Der Datensatz ist frei erfunden: ein Schweizer Haushalt mit Lohn, Miete,
Krankenkasse, Abos und schwankenden Alltagsausgaben ueber zwoelf Monate.
Keine echten Personen, keine echten IBANs, keine echten Haendler-IDs.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional, Sequence

#: Erkennungszeichen der Beispieldaten. Ueber dieses Feld findet der
#: Loeschweg alles wieder — ohne es muesste man raten, was Demo war.
DEMO_ACCOUNT_MARKER = "demo:beispieldaten"

#: Zwoelf volle Monate rueckwaerts, damit Jahresvergleich und
#: Saisonalitaet etwas zu zeigen haben.
DEMO_MONTHS = 12

#: Fester Startwert — derselbe Aufruf ergibt denselben Datensatz. Ein Demo,
#: das bei jedem Laden andere Zahlen zeigt, ist als Vorfuehrung wertlos.
DEMO_SEED = 20260101


@dataclass(frozen=True)
class DemoEntry:
    """Eine wiederkehrende Position des Beispielhaushalts."""

    description: str
    merchant: str
    amount: float
    category: str
    day: int
    #: Streuung in Prozent — Miete ist fix, Einkaufen nicht.
    jitter: float = 0.0
    #: Nur in diesen Monaten (1–12); leer = jeden Monat.
    months: Sequence[int] = ()


#: Einnahmen und feste Ausgaben eines Einpersonenhaushalts in Zuerich.
#: Groessenordnungen an BFS-Durchschnitten orientiert, Betraege gerundet.
DEMO_ENTRIES: List[DemoEntry] = [
    # ── Einnahmen ──
    DemoEntry("Lohnzahlung", "Arbeitgeber AG", 6_800.00, "Gehalt", 25),
    DemoEntry("Bonuszahlung", "Arbeitgeber AG", 4_000.00, "Bonus", 25, months=(3,)),
    # ── Wohnen ──
    DemoEntry("Mietzins Wohnung", "Immobilien Verwaltung", -1_690.00, "Wohnen", 1),
    DemoEntry("Elektrizitaet", "Stadtwerke", -78.00, "Nebenkosten", 8, jitter=0.25),
    DemoEntry("Serafe Radio/TV", "Serafe", -335.00, "Abgaben", 15, months=(2,)),
    # ── Versicherungen & Gesundheit ──
    DemoEntry("Krankenkasse Praemie", "Krankenversicherung", -412.00, "Krankenkasse", 3),
    DemoEntry("Hausratversicherung", "Versicherung", -23.00, "Weitere Versicherungen", 10),
    DemoEntry("Fitnessabo", "Fitnesscenter", -89.00, "Fitness", 5),
    # ── Mobilitaet ──
    DemoEntry("ÖV-Abonnement", "Verkehrsbetriebe", -85.00, "ÖV-Kosten", 2),
    DemoEntry("Tankstelle", "Tankstelle", -72.00, "Transport", 18, jitter=0.4),
    # ── Abos & Kommunikation ──
    DemoEntry("Mobilfunk", "Telekom", -49.00, "Mobilfunk", 12),
    DemoEntry("Internet Festnetz", "Provider", -59.00, "Internet (Festnetz)", 12),
    DemoEntry("Streaming Video", "Streamingdienst", -18.90, "Streaming", 20),
    DemoEntry("Musikstreaming", "Musikdienst", -12.95, "Musik & Medien", 20),
    # ── Steuern & Sparen ──
    DemoEntry("Steuern Akontozahlung", "Steueramt", -640.00, "Steuern", 28),
    DemoEntry("Einzahlung Saeule 3a", "Vorsorgestiftung", -588.00, "Säule 3A", 27),
    DemoEntry("Sparauftrag", "Sparkonto", -400.00, "Einzahlungen", 26),
]

#: Alltagsausgaben — Anzahl und Betrag schwanken, sonst sieht der Datensatz
#: aus wie ein Dauerauftragskatalog und nicht wie ein gelebter Monat.
DEMO_VARIABLE = [
    ("Lebensmittel Einkauf", "Supermarkt", -68.0, "Lebensmittel", 7),
    ("Restaurant", "Restaurant", -46.0, "Restaurant & Takeaway", 4),
    ("Takeaway Mittag", "Take Away", -19.5, "Restaurant & Takeaway", 5),
    ("Kleidung", "Modehaus", -95.0, "Kleidung", 1),
    ("Apotheke", "Apotheke", -34.0, "Gesundheit", 1),
    ("Kino / Veranstaltung", "Kulturbetrieb", -28.0, "Freizeit & Unterhaltung", 1),
    ("Online-Bestellung", "Onlinehaendler", -74.0, "Shopping", 2),
]


def _month_starts(today: date, months: int) -> List[date]:
    """Die letzten `months` Monatsanfaenge, aeltester zuerst."""
    starts: List[date] = []
    year, month = today.year, today.month
    for _ in range(months):
        starts.append(date(year, month, 1))
        month -= 1
        if month == 0:
            year, month = year - 1, 12
    return list(reversed(starts))


def _safe_day(anchor: date, day: int) -> date:
    """Der 31. existiert nicht in jedem Monat."""
    if anchor.month == 12:
        last = 31
    else:
        last = (date(anchor.year, anchor.month + 1, 1) - timedelta(days=1)).day
    return date(anchor.year, anchor.month, min(day, last))


def build_demo_transactions(
    today: Optional[date] = None,
    months: int = DEMO_MONTHS,
    seed: int = DEMO_SEED,
) -> List[dict]:
    """Baut die Buchungen des Beispielhaushalts — ohne DB, damit testbar."""
    today = today or date.today()
    rng = random.Random(seed)
    rows: List[dict] = []

    for anchor in _month_starts(today, months):
        for entry in DEMO_ENTRIES:
            if entry.months and anchor.month not in entry.months:
                continue
            when = _safe_day(anchor, entry.day)
            if when > today:
                continue
            amount = entry.amount
            if entry.jitter:
                amount *= 1 + rng.uniform(-entry.jitter, entry.jitter)
            rows.append({
                "date": datetime.combine(when, datetime.min.time(), tzinfo=timezone.utc),
                "description": entry.description,
                "merchant_normalized": entry.merchant,
                "amount": round(amount, 2),
                "category": entry.category,
                "is_recurring": True,
            })

        for description, merchant, base, category, per_month in DEMO_VARIABLE:
            count = max(0, per_month + rng.randint(-1, 1))
            for _ in range(count):
                when = _safe_day(anchor, rng.randint(1, 28))
                if when > today:
                    continue
                rows.append({
                    "date": datetime.combine(when, datetime.min.time(), tzinfo=timezone.utc),
                    "description": description,
                    "merchant_normalized": merchant,
                    "amount": round(base * rng.uniform(0.6, 1.5), 2),
                    "category": category,
                    "is_recurring": False,
                })

    rows.sort(key=lambda r: r["date"])
    return rows


def demo_closing_balance(rows: Sequence[dict], opening: float = 8_500.0) -> float:
    """Kontostand, der zu den Buchungen passt — sonst widerspricht sich das Demo."""
    return round(opening + sum(r["amount"] for r in rows), 2)
