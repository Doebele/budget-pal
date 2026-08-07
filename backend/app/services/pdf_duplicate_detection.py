"""
Match PDF preview rows against stored transactions (PostgreSQL or SQLite).
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Transaction

from app.services.pdf_import_row_match import DUPLICATE_AMOUNT_TOLERANCE

logger = logging.getLogger(__name__)

# Ab diesem Ähnlichkeitswert (0–100) gelten zwei Buchungstexte am selben Tag
# mit demselben Betrag als dieselbe Buchung. Bewusst hoch: ein Fehlalarm
# unterschlaegt eine echte Buchung, und zwei gleich hohe Zahlungen am selben
# Tag an denselben Haendler sind real (zweimal tanken, zweimal Kaffee).
DESCRIPTION_SIMILARITY_THRESHOLD = 88

_NOISE_RE = re.compile(r"[^A-Z0-9 ]+")


def normalize_for_match(text: str) -> str:
    """Buchungstext auf das Vergleichbare reduzieren.

    Verschiedene Quellen schreiben dieselbe Buchung unterschiedlich: ein
    Parser liefert "COOP PRONTO ZUERICH HB", eine KI-Extraktion vielleicht
    "Coop Pronto, Zürich HB". Gross-/Kleinschreibung und Satzzeichen sind für
    die Identitaet der Buchung irrelevant.
    """
    upper = (text or "").upper().replace("Ü", "UE").replace("Ö", "OE").replace("Ä", "AE")
    return " ".join(_NOISE_RE.sub(" ", upper).split())


def _descriptions_match(a: str, b: str) -> bool:
    """Gleiche Buchung trotz abweichender Schreibweise?"""
    norm_a, norm_b = normalize_for_match(a), normalize_for_match(b)
    if not norm_a or not norm_b:
        return False
    if norm_a == norm_b:
        return True

    try:
        from rapidfuzz import fuzz
    except ImportError:  # ohne rapidfuzz bleibt es beim exakten Vergleich
        return False

    # token_set_ratio ignoriert Wortreihenfolge und zusaetzliche Tokens —
    # genau die Freiheiten, die sich verschiedene Extraktionswege nehmen
    return fuzz.token_set_ratio(norm_a, norm_b) >= DESCRIPTION_SIMILARITY_THRESHOLD


async def find_database_duplicate_transaction_id(
    db: AsyncSession,
    account_id: int,
    original_date: str,
    amount: float,
    description: str,
    import_hash: str,
) -> Optional[int]:
    """
    Return an active transaction id that matches this preview row.

    Drei Stufen, von streng nach tolerant:
    1. import_hash (indiziert) — identische Zeile aus demselben Importweg
    2. Datum + Betrag + exakt gleicher Text — Altdaten ohne Hash
    3. Datum + Betrag + aehnlicher Text — dieselbe Buchung, anders geschrieben

    Stufe 3 ist noetig, seit Zeilen auch per KI aus unbekannten PDFs extrahiert
    werden: deren Buchungstext weicht von dem ab, was ein Parser gespeichert
    haette, womit Stufe 1 und 2 beide danebengreifen und beim erneuten Import
    desselben Auszugs Duplikate entstuenden.
    """
    q_hash = (
        await db.execute(
            select(Transaction.id)
            .where(
                Transaction.account_id == account_id,
                Transaction.is_deleted.isnot(True),
                Transaction.import_hash == import_hash,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if q_hash is not None:
        return q_hash

    try:
        d_only: date = datetime.strptime(original_date.strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return None

    desc = description.strip()
    am = float(amount)

    # Tagesgrenzen statt CAST(date AS DATE): der Cast ist auf SQLite nicht
    # lauffähig (der Ergebnistyp kommt nicht als String zurück und SQLAlchemys
    # Date-Prozessor wirft), und die App muss laut CLAUDE.md auf Postgres UND
    # SQLite laufen. Der Bereichsvergleich nutzt ausserdem den Index auf date.
    day_start = datetime.combine(d_only, time.min, tzinfo=timezone.utc)
    day_end = day_start + timedelta(days=1)

    # Alle Kandidaten desselben Tages mit passendem Betrag holen — an einem Tag
    # sind das sehr wenige, also ist ein Textvergleich in Python guenstiger als
    # dialektspezifisches SQL.
    candidates = (
        await db.execute(
            select(Transaction.id, Transaction.description)
            .where(
                Transaction.account_id == account_id,
                Transaction.is_deleted.isnot(True),
                Transaction.date >= day_start,
                Transaction.date < day_end,
                func.abs(Transaction.amount - am) < DUPLICATE_AMOUNT_TOLERANCE,
            )
            .limit(50)
        )
    ).all()

    for txn_id, existing_desc in candidates:
        if (existing_desc or "").strip() == desc:
            return txn_id

    for txn_id, existing_desc in candidates:
        if _descriptions_match(desc, existing_desc or ""):
            logger.info(
                "Duplikat ueber Textaehnlichkeit erkannt: %r ~ %r", desc, existing_desc
            )
            return txn_id

    return None
