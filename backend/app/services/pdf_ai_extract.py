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
from typing import Any, Awaitable, Callable, Dict, List, Optional

from typing import NamedTuple

from app.services import ai_client
from app.services.pdf_duplicate_detection import normalize_for_match
from app.services.user_history import CategoryHints

logger = logging.getLogger(__name__)

# Ein Auszug wird stückweise geschickt: Kontextfenster lokaler Modelle sind
# klein, und ein 40-seitiges PDF sprengt jedes davon.
# Rueckfall, wenn das Kontextfenster des Modells unbekannt ist. Der echte Wert
# wird pro Lauf aus ai_client.resolve_chunk_chars() bestimmt — ein Modell mit
# grossem Fenster nimmt ein ganzes Dokument in einem Durchgang.
CHUNK_CHARS = ai_client.DEFAULT_CHUNK_CHARS
MAX_CHUNKS = 8  # Kostendeckel — ~8 Aufrufe pro Dokument
# Gemessen an einem 4-seitigen Auszug mit 52 Buchungen: ein Reasoning-Modell
# (ornith-35b) braucht fuer einen Abschnitt 6536 Completion-Tokens — Denken plus
# JSON. Mit 4000 lief es ins Limit und lieferte gar nichts. Der Wert ist eine
# Obergrenze; abgerechnet wird nur Erzeugtes.
MAX_TOKENS_PER_CHUNK = 12000

_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.S)
_DATE_FORMATS = ("%Y-%m-%d", "%d.%m.%Y", "%d.%m.%y", "%d/%m/%Y", "%m/%d/%Y")


# (fertige Abschnitte, Abschnitte gesamt) — die UI zeigt daraus den Fortschritt
ProgressCallback = Callable[[int, int], Awaitable[None]]


class ExtractionResult(NamedTuple):
    """Buchungen plus Verbrauch — die Vorschau zeigt Modell und Tokens an."""

    rows: List[Dict[str, Any]]
    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    # Wurde das Dokument am Kostendeckel abgeschnitten? Dann fehlen Buchungen,
    # und der Nutzer MUSS das erfahren — sonst importiert er ein halbes Dokument
    # im Glauben, es sei vollstaendig.
    chunks_processed: int = 0
    chunks_total: int = 0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    @property
    def truncated(self) -> bool:
        return self.chunks_total > self.chunks_processed


def _chunks(text: str, chunk_chars: int = CHUNK_CHARS) -> List[str]:
    """Text an Zeilengrenzen stückeln, damit keine Transaktion zerschnitten wird.

    Gibt ALLE Abschnitte zurück; der Kostendeckel wird erst beim Verarbeiten
    angewandt, damit der Aufrufer merkt, dass etwas weggelassen wurde.
    """
    lines = (text or "").splitlines()
    out: List[str] = []
    current: List[str] = []
    size = 0

    for line in lines:
        if size + len(line) > chunk_chars and current:
            out.append("\n".join(current))
            current, size = [], 0
        current.append(line)
        size += len(line) + 1

    if current:
        out.append("\n".join(current))
    return out


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
    data = ai_client.parse_json_object(raw)
    if data is None:
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
    on_progress: Optional[ProgressCallback] = None,
) -> ExtractionResult:
    """Buchungen aus PDF-Text extrahieren.

    Liefert leere `rows`, wenn kein Modell konfiguriert ist oder nichts
    Verwertbares gefunden wurde — der Aufrufer behandelt das wie einen leeren
    Parser.
    """
    if ai is None or not ai.enabled or not (text or "").strip():
        return ExtractionResult([])

    hints = hints or CategoryHints()
    system = _build_system_prompt(hints, currency)

    rows: List[Dict[str, Any]] = []
    seen: set[tuple] = set()
    model = ""
    prompt_tokens = completion_tokens = 0

    chunk_chars = await ai_client.resolve_chunk_chars(ai, MAX_TOKENS_PER_CHUNK)
    all_chunks = _chunks(text, chunk_chars)
    logger.info(
        "KI-Extraktion: %d Zeichen, %d pro Anfrage → %d Abschnitt(e)",
        len(text), chunk_chars, len(all_chunks),
    )
    chunks = all_chunks[:MAX_CHUNKS]
    if len(all_chunks) > len(chunks):
        logger.warning(
            "Dokument zu lang: nur %d von %d Abschnitten ausgewertet "
            "(MAX_CHUNKS=%d). Spaetere Buchungen fehlen.",
            len(chunks), len(all_chunks), MAX_CHUNKS,
        )

    for index, chunk in enumerate(chunks, start=1):
        if on_progress is not None:
            await on_progress(index - 1, len(chunks))
        completion = await ai_client.complete_detailed(
            ai,
            system,
            chunk,
            max_tokens=MAX_TOKENS_PER_CHUNK,
            json_mode=True,
        )
        model = completion.model or model
        prompt_tokens += completion.prompt_tokens
        completion_tokens += completion.completion_tokens
        raw = completion.text
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

    if on_progress is not None:
        await on_progress(len(chunks), len(chunks))

    logger.info(
        "KI-Extraktion: %d Buchungen aus %d Zeichen (%s, %d Tokens)",
        len(rows),
        len(text),
        model or "unbekanntes Modell",
        prompt_tokens + completion_tokens,
    )
    return ExtractionResult(
        rows, model, prompt_tokens, completion_tokens,
        chunks_processed=len(chunks), chunks_total=len(all_chunks),
    )
