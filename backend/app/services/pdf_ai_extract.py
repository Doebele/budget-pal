"""
Budget-Pal — Transaktionen aus unbekannten PDFs per KI extrahieren.

Für UBS, N26, comdirect und UBS-Kreditkarte gibt es dedizierte Parser. Alles
andere lieferte bisher null Zeilen. Diese Stufe greift genau dann: wenn kein
Parser etwas gefunden hat und der Nutzer ein KI-Modell konfiguriert hat.

Ausgabeformat ist bewusst identisch zu den handgeschriebenen Parsern
({"date": "YYYY-MM-DD", "description", "amount", "currency"}), damit der
restliche Import-Pfad — Deduplizierung, Vorschau, Kategorisierung — unverändert
bleibt.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any, Dict, List, Optional

from app.services import ai_client
from app.services.pdf_duplicate_detection import normalize_for_match
from app.services.user_history import CategoryHints

logger = logging.getLogger(__name__)

# Ein Auszug wird stückweise geschickt: Kontextfenster lokaler Modelle sind
# klein, und ein 40-seitiges PDF sprengt jedes davon.
CHUNK_CHARS = 8000
MAX_CHUNKS = 8  # Kostendeckel — ~8 Aufrufe pro Dokument
MAX_TOKENS_PER_CHUNK = 4000

_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.S)
_DATE_FORMATS = ("%Y-%m-%d", "%d.%m.%Y", "%d.%m.%y", "%d/%m/%Y", "%m/%d/%Y")


def _chunks(text: str) -> List[str]:
    """Text an Zeilengrenzen stückeln, damit keine Transaktion zerschnitten wird."""
    lines = (text or "").splitlines()
    out: List[str] = []
    current: List[str] = []
    size = 0

    for line in lines:
        if size + len(line) > CHUNK_CHARS and current:
            out.append("\n".join(current))
            current, size = [], 0
        current.append(line)
        size += len(line) + 1

    if current:
        out.append("\n".join(current))
    return out[:MAX_CHUNKS]


def _parse_date(value: Any) -> Optional[str]:
    """Auf YYYY-MM-DD normalisieren; None wenn unbrauchbar."""
    raw = str(value or "").strip()
    if not raw:
        return None
    for fmt in _DATE_FORMATS:
        try:
            parsed = datetime.strptime(raw[:10], fmt)
        except ValueError:
            continue
        # Zweistellige Jahre: 24 → 2024
        if parsed.year < 100:
            parsed = parsed.replace(year=parsed.year + 2000)
        return parsed.strftime("%Y-%m-%d")
    return None


def _parse_amount(value: Any) -> Optional[float]:
    """Betrag robust lesen — Modelle liefern mal 1'234.50, mal -1.234,50."""
    if isinstance(value, (int, float)):
        return float(value)

    raw = str(value or "").strip()
    if not raw:
        return None

    negative = raw.startswith("-") or raw.endswith("-")
    raw = raw.strip("-").replace("'", "").replace(" ", "").replace("CHF", "").replace("EUR", "")

    # Letztes Trennzeichen ist das Dezimaltrennzeichen
    if "," in raw and "." in raw:
        raw = raw.replace(".", "").replace(",", ".") if raw.rfind(",") > raw.rfind(".") else raw.replace(",", "")
    elif "," in raw:
        raw = raw.replace(",", ".")

    try:
        amount = float(raw)
    except ValueError:
        return None
    return -amount if negative and amount > 0 else amount


def _build_system_prompt(hints: CategoryHints, currency: str) -> str:
    lines = [
        "Du extrahierst Buchungen aus dem Text eines Kontoauszugs oder einer Rechnung.",
        "Antworte ausschliesslich mit JSON in genau dieser Form:",
        '{"transactions": [{"date": "YYYY-MM-DD", "description": "...", '
        '"amount": -12.34, "category": "..."}]}',
        "",
        "Regeln:",
        "- amount ist negativ für Ausgaben und positiv für Eingaenge.",
        "- date im Format YYYY-MM-DD. Fehlt die Jahreszahl, nimm sie aus dem Kontext.",
        "- description ist der Buchungstext, ohne Betraege und Saldi.",
        "- Uebernimm nur echte Buchungen. Salden, Zwischensummen, Ueberschriften,"
        " Gebuehrenuebersichten und Seitenzahlen gehoeren NICHT dazu.",
        "- Findest du keine Buchungen, antworte mit {\"transactions\": []}.",
        "- Erfinde nichts. Was nicht im Text steht, kommt nicht in die Ausgabe.",
    ]

    categories = hints.prompt_categories()
    if categories:
        lines += [
            "",
            "Setze category ausschliesslich auf einen dieser Werte "
            "(die bisher verwendeten Kategorien des Nutzers):",
            ", ".join(categories),
            "Passt nichts, lass category weg.",
        ]

    examples = hints.prompt_examples()
    if examples:
        lines += [
            "",
            "So hat der Nutzer bisher zugeordnet:",
            *[f"- {merchant} → {category}" for merchant, category in examples],
        ]

    lines += ["", f"Standardwaehrung: {currency}."]
    return "\n".join(lines)


def _rows_from_response(raw: str, currency: str) -> List[Dict[str, Any]]:
    match = _JSON_OBJECT_RE.search(raw or "")
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except (ValueError, TypeError):
        logger.warning("KI-Extraktion lieferte kein gültiges JSON")
        return []

    rows: List[Dict[str, Any]] = []
    for item in data.get("transactions") or []:
        if not isinstance(item, dict):
            continue
        date = _parse_date(item.get("date"))
        amount = _parse_amount(item.get("amount"))
        description = str(item.get("description") or "").strip()
        # Ohne Datum, Betrag oder Text ist die Zeile für den Import wertlos
        if not date or amount is None or not description:
            continue

        row: Dict[str, Any] = {
            "date": date,
            "description": description,
            "amount": amount,
            "currency": currency,
        }
        category = str(item.get("category") or "").strip()
        if category:
            row["category"] = category
        rows.append(row)

    return rows


async def extract_transactions(
    ai: Optional[ai_client.AiConfig],
    text: str,
    hints: Optional[CategoryHints] = None,
    *,
    currency: str = "CHF",
) -> List[Dict[str, Any]]:
    """Buchungen aus PDF-Text extrahieren.

    Gibt [] zurück, wenn kein Modell konfiguriert ist oder nichts Verwertbares
    gefunden wurde — der Aufrufer behandelt das wie einen leeren Parser.
    """
    if ai is None or not ai.enabled or not (text or "").strip():
        return []

    hints = hints or CategoryHints()
    system = _build_system_prompt(hints, currency)

    rows: List[Dict[str, Any]] = []
    seen: set[tuple] = set()

    for index, chunk in enumerate(_chunks(text), start=1):
        raw = await ai_client.complete(
            ai,
            system,
            chunk,
            max_tokens=MAX_TOKENS_PER_CHUNK,
            json_mode=True,
        )
        if not raw:
            logger.info("KI-Extraktion: Abschnitt %d lieferte keine Antwort", index)
            continue

        for row in _rows_from_response(raw, currency):
            # Überlappende Abschnitte können dieselbe Buchung doppelt liefern —
            # und sie dabei unterschiedlich formulieren, daher normalisiert
            key = (
                row["date"],
                normalize_for_match(row["description"]),
                round(row["amount"], 2),
            )
            if key not in seen:
                seen.add(key)
                rows.append(row)

    logger.info("KI-Extraktion: %d Buchungen aus %s Zeichen", len(rows), len(text))
    return rows
