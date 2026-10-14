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
from typing import Dict, List, Sequence, Tuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.models import Account, Transaction
from app.services.currency_service import convert_with_eur_rates

TRANSFER_CATEGORY = "Kontoübertrag"
MAX_DAYS = 4
MAX_DAYS_FX = 5
#: ponytail: es gibt nur den heutigen Kurs, keine historischen. 4 % deckt
#: Bankmarge (~1–2 %) und die übliche Kursbewegung über Monate; bei grossen
#: Kurssprüngen historische ECB-Kurse nachladen.
FX_TOLERANCE = 0.04
_KEYWORDS = re.compile(
    r"[üu]e?bertrag|umbuchung|kontoübertrag|transfer|umgetauscht|exchanged|"
    r"dauerauftrag|tagesgeld|eigene[sn]? konto",
    re.IGNORECASE,
)


def _hinted(t: Transaction) -> bool:
    return t.category == TRANSFER_CATEGORY or bool(_KEYWORDS.search(t.description or ""))


def _eligible(t: Transaction) -> bool:
    if t.is_deleted or t.is_split or t.transfer_pair_id or t.transfer_rejected:
        return False
    return not t.user_verified or t.category == TRANSFER_CATEGORY


def _match_score(out: Transaction, inc: Transaction, rates: Dict[str, float]):
    """None, wenn `out` (Abgang) und `inc` (Eingang) kein Paar sind, sonst ein
    Rang (kleiner ist besser): Tage Abstand, dann Abweichung des Betrags."""
    days = abs((out.date.date() - inc.date.date()).days)
    sent, received = -out.amount, inc.amount
    cur_out, cur_in = (out.currency or "CHF").upper(), (inc.currency or "CHF").upper()
    same_account = out.account_id == inc.account_id
    hinted = _hinted(out) or _hinted(inc)

    if cur_out == cur_in:
        if days > MAX_DAYS or abs(sent - received) > 0.005:
            return None
        # Spiegelbuchungen innerhalb eines Kontos (Unterkonto im selben Auszug)
        if same_account and not (days == 0 and _hinted(out) and _hinted(inc)):
            return None
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
    expected = convert_with_eur_rates(rates, sent, cur_out, cur_in)
    if not expected:
        return None
    deviation = abs(received - expected) / expected
    return (days, deviation) if deviation <= FX_TOLERANCE else None


def find_transfer_pairs(
    txns: Sequence[Transaction], rates: Dict[str, float]
) -> List[Tuple[Transaction, Transaction]]:
    """Paare (Abgang, Eingang), jede Buchung höchstens einmal, das beste
    zuerst. Nimmt die Buchungen einer Person."""
    pool = [t for t in txns if _eligible(t)]
    outs = [t for t in pool if t.amount < 0]
    ins = [t for t in pool if t.amount > 0]
    # ponytail: O(n·m) über alle Abgänge und Eingänge; nach Datum vorsortieren,
    # wenn eine Person sehr viele Buchungen hat
    candidates = []
    for o in outs:
        for i in ins:
            score = _match_score(o, i, rates)
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
    pairs = find_transfer_pairs(rows, rates)
    for o, i in pairs:
        link_pair(o, i)
    await db.flush()
    return len(pairs)
