"""Idempotent seed: system categories aligned with wizard peer-group buckets and subscription types."""

from __future__ import annotations

from typing import Any, Dict, List

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Category

# Mirrors PeerGroupCard + full PeerGroupDefaults expense keys (German labels, stable slugs).
# Income-side rows use icon "sparen" (Super «Sparen»). Säule-3A-Einzahlungen gehören zur Super «Steuern & Abgaben».
PEER_SYSTEM_CATEGORIES: List[Dict[str, Any]] = [
    {"slug": "einnahmen-gehalt", "name": "Gehalt", "icon": "sparen", "color": "#10B981", "sort_order": 1},
    {"slug": "einnahmen-investitionen", "name": "Investitionen", "icon": "sparen", "color": "#10B981", "sort_order": 2},
    {"slug": "einnahmen-dividende", "name": "Dividende", "icon": "sparen", "color": "#10B981", "sort_order": 3},
    {"slug": "einnahmen-zinsen", "name": "Zinsen", "icon": "sparen", "color": "#10B981", "sort_order": 4},
    {"slug": "einnahmen-rueckerstattung", "name": "Rückerstattung", "icon": "sparen", "color": "#10B981", "sort_order": 5},
    {"slug": "einnahmen-erstattung", "name": "Erstattung", "icon": "sparen", "color": "#10B981", "sort_order": 6},
    {"slug": "einnahmen-bonus", "name": "Bonus", "icon": "sparen", "color": "#10B981", "sort_order": 7},
    {"slug": "einnahmen-einzahlung", "name": "Einzahlungen", "icon": "sparen", "color": "#10B981", "sort_order": 8},
    {"slug": "einnahmen-kontouebertrag", "name": "Kontoübertrag", "icon": "sparen", "color": "#10B981", "sort_order": 9},
    {"slug": "einnahmen-sonstige", "name": "Sonstige Einnahmen", "icon": "sparen", "color": "#10B981", "sort_order": 10},
    {"slug": "steuern-saeule-3a", "name": "Säule 3A", "icon": "steuern", "color": "#f43f5e", "sort_order": 11},
    {"slug": "wohnen", "name": "Wohnen", "icon": "🏠", "color": "#3B82F6", "sort_order": 12},
    {"slug": "lebensmittel", "name": "Lebensmittel", "icon": "🛒", "color": "#22C55E", "sort_order": 20},
    {"slug": "transport", "name": "Transport", "icon": "🚂", "color": "#EAB308", "sort_order": 30},
    {"slug": "krankenkasse", "name": "Krankenkasse", "icon": "🏥", "color": "#EF4444", "sort_order": 40},
    {
        "slug": "weitere-versicherungen",
        "name": "Weitere Versicherungen",
        "icon": "🛡️",
        "color": "#F97316",
        "sort_order": 50,
    },
    {
        "slug": "kommunikation",
        "name": "Kommunikation",
        "icon": "📱",
        "color": "#06B6D4",
        "sort_order": 60,
    },
    {
        "slug": "restaurant-takeaway",
        "name": "Restaurant & Takeaway",
        "icon": "🍽️",
        "color": "#A855F7",
        "sort_order": 70,
    },
    {
        "slug": "freizeit-unterhaltung",
        "name": "Freizeit & Unterhaltung",
        "icon": "🎬",
        "color": "#EC4899",
        "sort_order": 80,
    },
    {"slug": "kleidung", "name": "Kleidung", "icon": "👕", "color": "#8B5CF6", "sort_order": 90},
    {"slug": "reisen", "name": "Reisen", "icon": "✈️", "color": "#14B8A6", "sort_order": 100},
    {
        "slug": "bildung-weiterbildung",
        "name": "Bildung & Weiterbildung",
        "icon": "📚",
        "color": "#6366F1",
        "sort_order": 110,
    },
    {"slug": "abonnements", "name": "Abonnements", "icon": "📺", "color": "#64748B", "sort_order": 120},
    # Subscription catalog buckets (COMMON_SUBSCRIPTIONS.category)
    {"slug": "abo-streaming", "name": "Streaming", "icon": "📺", "color": "#7C3AED", "sort_order": 200},
    {"slug": "abo-musik", "name": "Musik & Medien", "icon": "🎵", "color": "#DB2777", "sort_order": 210},
    {"slug": "abo-nachrichten", "name": "Nachrichten & Medien", "icon": "📰", "color": "#0D9488", "sort_order": 220},
    {"slug": "abo-cloud", "name": "Cloud & Backup", "icon": "☁️", "color": "#0284C7", "sort_order": 230},
    {"slug": "abo-software", "name": "Software & Apps", "icon": "💻", "color": "#CA8A04", "sort_order": 240},
    {"slug": "abo-treue", "name": "Treue & Mitgliedschaften", "icon": "🎁", "color": "#EA580C", "sort_order": 250},
    {"slug": "abo-internet", "name": "Internet (Festnetz)", "icon": "🌐", "color": "#2563EB", "sort_order": 260},
    {"slug": "abo-mobilfunk", "name": "Mobilfunk", "icon": "📶", "color": "#059669", "sort_order": 270},
    {"slug": "abo-oev", "name": "ÖV-Abonnements", "icon": "🎫", "color": "#D97706", "sort_order": 280},
    {"slug": "abo-fitness", "name": "Fitness", "icon": "💪", "color": "#DC2626", "sort_order": 290},
    {"slug": "abo-beruflich", "name": "Beruflich", "icon": "💼", "color": "#4F46E5", "sort_order": 300},
    {"slug": "abo-shopping", "name": "Shopping & Lieferdienste", "icon": "📦", "color": "#BE185D", "sort_order": 310},
]


async def seed_peer_group_system_categories(session: AsyncSession) -> int:
    # Legacy slug was under «einnahmen»/Sparen; taxonomy + UI expect Steuern & Abgaben.
    await session.execute(
        update(Category)
        .where(
            Category.slug == "einnahmen-saeule-3a",
            Category.user_id.is_(None),
            Category.is_system.is_(True),  # noqa: E712
        )
        .values(slug="steuern-saeule-3a", icon="steuern", color="#f43f5e")
    )

    inserted = 0
    for row in PEER_SYSTEM_CATEGORIES:
        slug = row["slug"]
        res = await session.execute(
            select(Category.id).where(
                Category.slug == slug,
                Category.user_id.is_(None),
                Category.is_system == True,  # noqa: E712
            )
        )
        if res.first():
            continue
        session.add(
            Category(
                user_id=None,
                name=row["name"],
                slug=slug,
                parent_id=None,
                color=row.get("color"),
                icon=row.get("icon"),
                is_system=True,
                sort_order=int(row.get("sort_order", 0)),
            )
        )
        inserted += 1
    return inserted
