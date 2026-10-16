"""Kontoüberträge zwischen eigenen Konten erkennen.

Ein Übertrag erscheint in den realen Angaben zweimal: als Abgang auf dem einen
und als Eingang auf dem anderen Konto. Ohne Abgleich zählt er doppelt, als
Ausgabe und als Einnahme. Hier werden solche Paare gesucht, beide Seiten als
`is_transfer` markiert und über `transfer_pair_id` verbunden; Statistiken,
Budget und Prognosen lassen markierte Buchungen bereits aus.

Ein Paar ist ein Abgang und ein Eingang mit gleichem Betrag auf zwei Konten
derselben Person, höchstens ein paar Tage auseinander:
- gleiche Währung: Betrag auf den Rappen gleich;
- verschiedene Währungen: der von der Bank gelieferte Originalbetrag passt
  genau, sonst passt der Betrag zum heutigen Kurs innerhalb FX_TOLERANCE
  (Bankmarge plus Kursbewegung seit der Buchung).
Damit nicht jede gleich hohe Rückerstattung als Übertrag gilt, braucht ein Paar
ein Zeichen dafür (Kategorie «Kontoübertrag» oder ein Stichwort wie «Übertrag»):
bei gleicher Währung auf einer Seite oder beide Buchungen am selben Tag, beim
Abgleich zum Tageskurs auf beiden Seiten.

Die Person behält das letzte Wort: von Hand kategorisierte Buchungen (ausser als
«Kontoübertrag») und aufgelöste Paare (`transfer_rejected`) bleiben unberührt.
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher
from datetime import timedelta
from typing import Dict, List, Optional, Sequence, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.models import INVEST_CATEGORY, Account, Transaction
from app.services.currency_service import convert_with_eur_rates, get_rate_series, rates_on

TRANSFER_CATEGORY = "Kontoübertrag"
MAX_DAYS = 4
MAX_DAYS_FX = 5
#: Abweichung zum ECB-Kurs des Buchungstags (ohne Netz: heutiger Kurs):
#: Bankmarge ~1–2 % plus etwas Luft
FX_TOLERANCE = 0.04
_KEYWORDS = re.compile(
    r"[üu]e?bertrag|umbuchung|kontoübertrag|transfer|umgetauscht|exchanged|"
    r"dauerauftrag|tagesgeld|eigene[sn]? konto|einzahlung|"
    # Kreditkarte: Lastschrift der Rechnung auf dem Bankkonto, Zahlung aufs Kartenkonto
    r"monatsabrechnung|kartenabrechnung|kreditkarte|lsv-zahlung|\bECA\d",
    re.IGNORECASE,
)
# Bargeld am Automaten ist eine Ausgabe, auch wenn es als Kontoübertrag kategorisiert ist
_NEVER = re.compile(r"\bATM\b|bancomat|geldautomat|bargeld", re.IGNORECASE)
# Kreditkarte im selben Auszug: Summe auf dem Giro, Ausgleich im Kartenteil
_CARD_STATEMENT = re.compile(r"monatsabrechnung|kartenabrechnung", re.IGNORECASE)


def _alike(a: Transaction, b: Transaction) -> bool:
    """Beschreibungen fast gleich (Ziffern und Satzzeichen ignoriert)."""
    norm = lambda t: re.sub(r"[^a-zäöüß]+", " ", (t.description or "").lower()).strip()  # noqa: E731
    return SequenceMatcher(None, norm(a), norm(b)).ratio() >= 0.85


def _hinted(t: Transaction) -> bool:
    return t.category == TRANSFER_CATEGORY or bool(_KEYWORDS.search(t.description or ""))


def _eligible(t: Transaction) -> bool:
    if t.is_deleted or t.is_split or t.transfer_pair_id or t.transfer_rejected or t.is_ignored:
        return False
    # Fonds-, Wertpapier- und Kryptokäufe sind Anlagen, kein Übertrag
    if t.category == INVEST_CATEGORY:
        return False
    return not t.user_verified or t.category == TRANSFER_CATEGORY


def _match_score(out: Transaction, inc: Transaction, rates: Dict[str, float], series=None):
    """None, wenn `out` (Abgang) und `inc` (Eingang) kein Paar sind, sonst ein
    Rang (kleiner ist besser): Tage Abstand, dann Abweichung des Betrags."""
    if _NEVER.search(out.description or "") or _NEVER.search(inc.description or ""):
        return None
    days = abs((out.date.date() - inc.date.date()).days)
    sent, received = -out.amount, inc.amount
    cur_out, cur_in = (out.currency or "CHF").upper(), (inc.currency or "CHF").upper()
    same_account = out.account_id == inc.account_id
    hinted = _hinted(out) or _hinted(inc)

    if cur_out == cur_in:
        if days > MAX_DAYS or abs(sent - received) > 0.005:
            return None
        # Im selben Konto nur Spiegelbuchungen eines Unterkontos im selben
        # Auszug: Comdirect-Tagesgeld (gleicher Tag, fast gleicher Text) oder
        # die Visa-Abrechnung (Summe und Ausgleich). Sonst wären «Lohn hinaus»
        # und «Monatszahlung herein» oder ein Fondskauf und eine gleich hohe
        # Einzahlung ein Paar. Ein Paar über zwei Konten geht vor (Rang +0.5).
        if same_account:
            mirror = days == 0 and _alike(out, inc)
            card = bool(_CARD_STATEMENT.search(out.description or "")) and bool(
                _CARD_STATEMENT.search(inc.description or ""))
            if not (_hinted(out) and _hinted(inc) and (mirror or card)):
                return None
            return (days + 0.5, 0.0)
        return (days, 0.0) if hinted or days == 0 else None

    if same_account or days > MAX_DAYS_FX:
        return None
    # Originalbetrag der Bank in der Währung der Gegenseite
    for a, b, amount in ((out, inc, received), (inc, out, sent)):
        if (a.original_currency or "").upper() == (b.currency or "").upper() and a.original_amount:
            if abs(abs(a.original_amount) - amount) <= 0.005:
                return (days, 0.0)
    # Zum Tageskurs passt vieles ungefähr: hier müssen beide Seiten nach
    # Übertrag aussehen (sonst wurde z. B. eine Krankenkassen-Rechnung mit
    # einem gleich hohen Eingang in Euro verbunden)
    if not (_hinted(out) and _hinted(inc)):
        return None
    day_rates = rates_on(series, out.date.date()) if series else None
    expected = convert_with_eur_rates(day_rates or rates, sent, cur_out, cur_in)
    if not expected:
        return None
    deviation = abs(received - expected) / expected
    return (days, deviation) if deviation <= FX_TOLERANCE else None


def find_transfer_pairs(
    txns: Sequence[Transaction], rates: Dict[str, float], series: Optional[dict] = None
) -> List[Tuple[Transaction, Transaction]]:
    """Paare (Abgang, Eingang), jede Buchung höchstens einmal, das beste
    zuerst. Nimmt die Buchungen einer Person; `series` sind die ECB-Tageskurse
    (currency_service.get_rate_series), sonst gilt `rates` für jeden Tag."""
    pool = [t for t in txns if _eligible(t)]
    outs = [t for t in pool if t.amount < 0]
    ins = [t for t in pool if t.amount > 0]
    # ponytail: O(n·m) über alle Abgänge und Eingänge; nach Datum vorsortieren,
    # wenn eine Person sehr viele Buchungen hat
    candidates = []
    for o in outs:
        for i in ins:
            score = _match_score(o, i, rates, series)
            if score is not None:
                candidates.append((score, o.id, i.id, o, i))
    candidates.sort(key=lambda c: c[:3])
    used: set = set()
    pairs = []
    for _, _, _, o, i in candidates:
        if o.id in used or i.id in used:
            continue
        used.update((o.id, i.id))
        pairs.append((o, i))
    return pairs


def link_pair(out: Transaction, inc: Transaction) -> None:
    for t, other in ((out, inc), (inc, out)):
        t.is_transfer = True
        t.transfer_pair_id = other.id
        if not t.user_verified:
            t.category = TRANSFER_CATEGORY


def unlink_pair(txn: Transaction, pair: Transaction | None) -> None:
    """Die Person löst ein Paar auf: beide Seiten zählen wieder als Ein- bzw.
    Ausgabe und werden nicht mehr automatisch verbunden."""
    for t in (txn, pair):
        if t is None:
            continue
        t.is_transfer = False
        t.transfer_pair_id = None
        t.transfer_rejected = True
        t.user_verified = True


async def _release_orphans(db: AsyncSession, user_id: int) -> None:
    """Ein automatisch verbundenes Paar, dessen Gegenbuchung gelöscht wurde
    (archiviert, oder mit dem Konto entfernt): die übrige Seite zählt wieder.
    Von Hand gesetzte Überträge tragen user_verified und bleiben."""
    rows = (
        await db.execute(
            select(Transaction)
            .join(Account)
            .where(
                Account.user_id == user_id,
                Transaction.is_transfer.is_(True),
                Transaction.user_verified.isnot(True),
                Transaction.is_deleted.isnot(True),
            )
            .options(selectinload(Transaction.transfer_pair))
        )
    ).scalars().all()
    for t in rows:
        if t.transfer_pair is None or t.transfer_pair.is_deleted:
            t.is_transfer = False
            t.transfer_pair_id = None


async def match_transfers(db: AsyncSession, user_id: int, rates: Dict[str, float]) -> int:
    """Sucht neue Paare unter allen Buchungen der Person und verbindet sie.
    Gibt die Zahl der neuen Paare zurück; der Aufrufer committet."""
    await _release_orphans(db, user_id)
    rows = (
        await db.execute(
            select(Transaction)
            .join(Account)
            .where(
                Account.user_id == user_id,
                Transaction.is_deleted.isnot(True),
                Transaction.transfer_pair_id.is_(None),
                Transaction.transfer_rejected.isnot(True),
            )
        )
    ).scalars().all()
    # Tageskurse nur, wenn mehrere Währungen vorkommen (ein Abruf für den Zeitraum)
    series = None
    if len({(t.currency or "CHF").upper() for t in rows}) > 1:
        days = [t.date.date() for t in rows]
        series = await get_rate_series(min(days) - timedelta(days=7), max(days))
    pairs = find_transfer_pairs(rows, rates, series)
    for o, i in pairs:
        link_pair(o, i)
    await db.flush()
    return len(pairs)
