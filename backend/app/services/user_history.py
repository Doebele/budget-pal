"""
Budget-Pal — Kategorien aus den bereits erfassten Transaktionen ableiten.

Die eigene Historie ist das beste Signal für die Kategorisierung: wer "COOP
PRONTO" einmal als "Lebensmittel" bestätigt hat, meint das beim nächsten Mal
wieder. Diese Hinweise werden an zwei Stellen genutzt:

- categorization.py: exakter Treffer auf einen bekannten Händler, bevor
  generische Regeln greifen (die "manual override cache"-Stufe, die die
  Pipeline-Doku seit jeher verspricht)
- pdf_ai_extract.py: als Few-Shot-Beispiele und als erlaubte Kategorieliste
  im Prompt, damit das Modell die Kategorien des Nutzers trifft statt
  eigene zu erfinden
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from sqlalchemy import case, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Account, Transaction

logger = logging.getLogger(__name__)

# Obergrenzen: die Hinweise landen in einem Prompt, der bezahlt wird
MAX_MERCHANT_PAIRS = 400
MAX_PROMPT_EXAMPLES = 40
MAX_PROMPT_CATEGORIES = 40


@dataclass
class CategoryHints:
    """Was dieser Nutzer bisher tatsächlich verwendet hat.

    `confirmed` und `seen` sind bewusst getrennt: nur vom Nutzer bestätigte
    Zuordnungen dürfen die Regel-Pipeline überstimmen. Würde man automatisch
    vergebene Kategorien gleich behandeln, zementierte sich jeder Fehlgriff
    selbst — die Pipeline würde ihre eigene Ausgabe als Beleg lesen.
    """

    # Kategorien nach Häufigkeit, häufigste zuerst
    categories: List[str] = field(default_factory=list)
    # merchant_normalized (uppercase) → Kategorie, nur user_verified
    confirmed: Dict[str, str] = field(default_factory=dict)
    # dito, aber inkl. automatisch vergebener — nur als Prompt-Kontext
    seen: Dict[str, str] = field(default_factory=dict)

    @property
    def is_empty(self) -> bool:
        return not self.categories and not self.seen

    def lookup_confirmed(self, description: str) -> Optional[str]:
        """Bestätigte Kategorie für einen Buchungstext, sonst None.

        Erst exakt, dann Teilstring — Buchungstexte tragen oft Zusätze
        ("COOP PRONTO ZUERICH HB 12.05").
        """
        if not self.confirmed:
            return None
        text = (description or "").strip().upper()
        if not text:
            return None
        if text in self.confirmed:
            return self.confirmed[text]
        # Längste Händler zuerst, damit "COOP PRONTO" vor "COOP" greift
        for merchant in sorted(self.confirmed, key=len, reverse=True):
            if len(merchant) >= 4 and merchant in text:
                return self.confirmed[merchant]
        return None

    def prompt_categories(self) -> List[str]:
        return self.categories[:MAX_PROMPT_CATEGORIES]

    def prompt_examples(self) -> List[tuple[str, str]]:
        """Händler→Kategorie-Paare als Few-Shot-Beispiele fürs Modell.
        Bestätigte zuerst, danach der Rest."""
        pairs = list(self.confirmed.items())
        pairs += [(m, c) for m, c in self.seen.items() if m not in self.confirmed]
        return pairs[:MAX_PROMPT_EXAMPLES]


async def load_category_hints(db: AsyncSession, user_id: int) -> CategoryHints:
    """Händler- und Kategorie-Statistik des Nutzers laden.

    Vom Nutzer bestätigte Zuordnungen (`user_verified`) schlagen automatisch
    vergebene, danach entscheidet die Häufigkeit.
    """
    verified_rank = func.max(
        case((Transaction.user_verified.is_(True), 1), else_=0)
    ).label("verified")
    hits = func.count().label("hits")

    stmt = (
        select(
            Transaction.merchant_normalized,
            Transaction.category,
            hits,
            verified_rank,
        )
        .join(Account, Transaction.account_id == Account.id)
        .where(
            Account.user_id == user_id,
            Transaction.is_deleted.isnot(True),
            Transaction.category.isnot(None),
            Transaction.category != "",
        )
        .group_by(Transaction.merchant_normalized, Transaction.category)
        .order_by(desc("verified"), desc(hits))
        .limit(MAX_MERCHANT_PAIRS)
    )

    try:
        rows = (await db.execute(stmt)).all()
    except Exception as e:  # Hinweise sind optional — nie den Import blockieren
        logger.warning("Kategorie-Hinweise konnten nicht geladen werden: %s", e)
        return CategoryHints()

    confirmed: Dict[str, str] = {}
    seen: Dict[str, str] = {}
    category_counts: Dict[str, int] = {}

    for merchant, category, count, verified in rows:
        category_counts[category] = category_counts.get(category, 0) + int(count)
        if not merchant:
            continue
        key = merchant.strip().upper()
        if not key:
            continue
        # Zeilen kommen sortiert (verified, dann Häufigkeit) — erster Treffer gewinnt
        if key not in seen:
            seen[key] = category
        if verified and key not in confirmed:
            confirmed[key] = category

    categories = sorted(category_counts, key=lambda c: category_counts[c], reverse=True)
    return CategoryHints(categories=categories, confirmed=confirmed, seen=seen)
