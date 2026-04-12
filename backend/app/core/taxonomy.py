"""
Shared supercategory taxonomy — loaded from repo-root `shared/taxonomy.json`.

Used by GET /api/taxonomy (merged with per-user Category rows) and for
server-side resolution consistent with the frontend.
"""
from __future__ import annotations

import copy
import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any, List, Optional

logger = logging.getLogger(__name__)

_TAXONOMY_PATH = Path(__file__).resolve().parent.parent.parent.parent / "shared" / "taxonomy.json"


@lru_cache(maxsize=1)
def _load_base_raw() -> dict[str, Any]:
    if not _TAXONOMY_PATH.is_file():
        logger.error("taxonomy.json missing at %s", _TAXONOMY_PATH)
        return {"version": 0, "superCategories": []}
    with _TAXONOMY_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def get_taxonomy_file_version() -> int:
    return int(_load_base_raw().get("version", 1))


def load_base_super_categories() -> List[dict[str, Any]]:
    """Return a deep copy of base supercategory rows from JSON."""
    data = _load_base_raw()
    rows = data.get("superCategories") or []
    return copy.deepcopy(rows)


def merge_taxonomy_with_categories(
    base_rows: List[dict[str, Any]],
    db_categories: List[Any],
) -> List[dict[str, Any]]:
    """
    Append user/system Category names into txnCategories / wizardLabels by `icon`:
      - icon == super id  → txnCategories
      - icon == 'wl:'+id  → wizardLabels (stored lowercase)
    """
    rows = copy.deepcopy(base_rows)
    by_id = {r["id"]: r for r in rows}

    for c in db_categories:
        icon = (getattr(c, "icon", None) or "").strip()
        name = (getattr(c, "name", None) or "").strip()
        if not name or not icon:
            continue

        if icon.startswith("wl:"):
            sc_id = icon[3:]
            sc = by_id.get(sc_id)
            if not sc:
                continue
            wl: List[str] = sc.setdefault("wizardLabels", [])
            low = name.lower()
            if not any(str(x).lower() == low for x in wl):
                wl.append(low)
        elif icon in by_id:
            sc = by_id[icon]
            tx: List[str] = sc.setdefault("txnCategories", [])
            if not any(str(x).lower() == name.lower() for x in tx):
                tx.append(name)

    return rows


def resolve_super_category_row(
    rows: List[dict[str, Any]],
    name: str,
    *,
    is_wizard: bool = False,
) -> dict[str, Any]:
    """
    Match a transaction category string or wizard note to a supercategory row.
    Falls back to sonstiges.
    """
    lower = (name or "").lower()
    if not lower:
        return _fallback_sonstiges(rows)

    for sc in rows:
        if sc.get("label", "").lower() == lower:
            return sc
    for sc in rows:
        if sc.get("id", "").lower() == lower:
            return sc

    if is_wizard:
        for sc in rows:
            for w in sc.get("wizardLabels") or []:
                if str(w).lower() == lower:
                    return sc
        for sc in rows:
            for t in sc.get("txnCategories") or []:
                if str(t).lower() == lower:
                    return sc
    else:
        for sc in rows:
            for t in sc.get("txnCategories") or []:
                if str(t).lower() == lower:
                    return sc
        for sc in rows:
            for a in sc.get("legacyAliases") or []:
                if str(a).lower() == lower:
                    return sc
        for sc in rows:
            for w in sc.get("wizardLabels") or []:
                if str(w).lower() == lower:
                    return sc

    return _fallback_sonstiges(rows)


def _fallback_sonstiges(rows: List[dict[str, Any]]) -> dict[str, Any]:
    for sc in rows:
        if sc.get("id") == "sonstiges":
            return sc
    return rows[-1] if rows else {}


def resolve_super_category_id(name: str, *, is_wizard: bool = False) -> str:
    """Resolve using base taxonomy only (no DB merge)."""
    rows = load_base_super_categories()
    return resolve_super_category_row(rows, name, is_wizard=is_wizard).get("id", "sonstiges")


def color_for_category(name: str, *, is_wizard: bool = False) -> str:
    sc = resolve_super_category_row(load_base_super_categories(), name, is_wizard=is_wizard)
    return str(sc.get("color") or "#94a3b8")


# ── Legacy peer keys (exact strings) + defaults by super-id ───────────────
# Used when resolving transaction / wizard labels to peer_benchmark columns.

TXN_TO_PEER_LEGACY: dict[str, str] = {
    "groceries": "food",
    "food & drink": "food",
    "lebensmittel": "food",
    "restaurant & takeaway": "restaurant",
    "freizeit & restaurant": "restaurant",
    "transport": "transport",
    "travel": "transport",
    "reisen": "transport",
    "öv-abonnements": "transport",
    "öv-kosten": "transport",
    "ov-abonnements": "transport",
    "öv abonnements": "transport",
    "housing": "housing",
    "wohnen": "housing",
    "hypothek": "housing",
    "utilities": "housing",
    "nebenkosten": "housing",
    "insurance": "insurance",
    "versicherungen": "insurance",
    "krankenkasse": "insurance",
    "weitere versicherungen": "insurance",
    "health": "health",
    "gesundheit": "health",
    "fitness": "health",
    "entertainment": "leisure",
    "unterhaltung": "leisure",
    "freizeit & unterhaltung": "leisure",
    "abonnements": "leisure",
    "streaming": "leisure",
    "musik & medien": "leisure",
    "nachrichten & medien": "leisure",
    "cloud & backup": "leisure",
    "software & apps": "leisure",
    "treue & mitgliedschaften": "leisure",
    "bildung & weiterbildung": "leisure",
    "beruflich": "leisure",
    "kommunikation": "communication",
    "internet (festnetz)": "communication",
    "mobilfunk": "communication",
    "kleidung": "clothing",
    "shopping": "clothing",
    "shopping & lieferdienste": "clothing",
}

WIZARD_TO_PEER_LEGACY: dict[str, str] = {
    "miete": "housing",
    "miete & nebenkosten": "housing",
    "hypothek": "housing",
    "hypothek amortisation": "housing",
    "hypothek & amortisation": "housing",
    "hypothekarzins": "housing",
    "amortisation": "housing",
    "nebenkosten": "housing",
    "hausverwaltung": "housing",
    "stockwerkeigentum": "housing",
    "parkplatz": "housing",          # home parking = housing cost
    "krankenkasse": "insurance",
    "zusatzversicherung": "insurance",
    "hausrat & haftpflicht": "insurance",
    "autoversicherung": "insurance",
    "lebensmittel": "food",
    "freizeit & restaurant": "food",
    "abonnements": "leisure",
    "benzin / strom (auto)": "transport",
    "auto-amortisation": "transport",
    "sbb halbtax": "transport",
    "sbb ga 2. klasse": "transport",
}

# Default super-id → peer column (when no legacy txn match)
SUPER_ID_TO_PEER: dict[str, Optional[str]] = {
    "wohnen": "housing",
    "essen": "food",
    "mobilitaet": "transport",
    "versicherungen": "insurance",
    "freizeit": "leisure",
    "abos": "communication",
    "shopping": "clothing",
    "bildung": "leisure",
    "steuern": None,
    "sparen": None,
    "sonstiges": None,
}

# Wizard notes (lower) → canonical transaction category name (explicit overrides)
DEFAULT_WIZARD_TO_TXN: dict[str, str] = {
    # Wohnen
    "miete": "Wohnen",
    "miete & nebenkosten": "Wohnen",
    "hausverwaltung": "Wohnen",
    "stockwerkeigentum": "Wohnen",
    "parkplatz": "Wohnen",           # home garage/parking space = Wohnkosten
    "nebenkosten": "Nebenkosten",
    # Hypothek (eigene txnKategorie unter Wohnen)
    "hypothek": "Hypothek",
    "hypothek amortisation": "Hypothek",
    "hypothek & amortisation": "Hypothek",
    "hypothekarzins": "Hypothek",
    "amortisation": "Hypothek",
    # Versicherungen
    "krankenkasse": "Versicherungen",
    "zusatzversicherung": "Versicherungen",
    "hausrat & haftpflicht": "Versicherungen",
    "autoversicherung": "Versicherungen",
    # Essen
    "lebensmittel": "Lebensmittel",
    "freizeit & restaurant": "Restaurant & Takeaway",
    # Abos
    "abonnements": "Abonnements",
    # Mobilität
    "benzin / strom (auto)": "Transport",
    "auto-amortisation": "Transport",
    "sbb halbtax": "ÖV-Kosten",
    "sbb ga 2. klasse": "ÖV-Kosten",
    # Sparen
    "säule 3a": "Säule 3A",
    "säule 3a einzahlung": "Säule 3A",
    "pillar 3a": "Säule 3A",
    "3. säule": "Säule 3A",
}


def peer_key_for_transaction_category(
    merged_rows: List[dict[str, Any]],
    category_name: str,
) -> Optional[str]:
    """Map a real transaction category string to a peer_benchmark column key."""
    lower = (category_name or "").strip().lower()
    if not lower:
        return None
    if lower in TXN_TO_PEER_LEGACY:
        return TXN_TO_PEER_LEGACY[lower]
    if "restaurant" in lower or "takeaway" in lower:
        return "restaurant"
    sc = resolve_super_category_row(merged_rows, category_name, is_wizard=False)
    return SUPER_ID_TO_PEER.get(sc.get("id"))


def peer_key_for_wizard_label(
    merged_rows: List[dict[str, Any]],
    label: str,
) -> Optional[str]:
    """Map a wizard budget `notes` label to a peer_benchmark column key."""
    lower = (label or "").strip().lower()
    if not lower:
        return None
    if lower in WIZARD_TO_PEER_LEGACY:
        return WIZARD_TO_PEER_LEGACY[lower]
    sc = resolve_super_category_row(merged_rows, label, is_wizard=True)
    return SUPER_ID_TO_PEER.get(sc.get("id"))


def default_transaction_category_for_wizard_label(
    merged_rows: List[dict[str, Any]],
    wizard_label: str,
) -> str:
    """
    Default Ist-Kategorie for a wizard label: explicit table → first txn in resolved super.
    """
    lower = (wizard_label or "").strip().lower()
    if not lower:
        return ""
    if lower in DEFAULT_WIZARD_TO_TXN:
        return DEFAULT_WIZARD_TO_TXN[lower]
    sc = resolve_super_category_row(merged_rows, wizard_label, is_wizard=True)
    txns = [str(t) for t in (sc.get("txnCategories") or []) if t]
    return txns[0] if txns else ""


def is_super_category_id(rows: List[dict[str, Any]], value: str) -> bool:
    """True if `value` matches a supercategory row id (case-insensitive)."""
    if not (value or "").strip():
        return False
    v = value.strip().lower()
    return any(str(r.get("id", "")).lower() == v for r in rows)


def first_txn_category_for_super(rows: List[dict[str, Any]], super_id: str) -> str:
    """First canonical transaction-category label under this super (for Ist lookups)."""
    sid = super_id.strip().lower()
    for r in rows:
        if str(r.get("id", "")).lower() == sid:
            txns = [str(t) for t in (r.get("txnCategories") or []) if t]
            return txns[0] if txns else ""
    return ""


def default_super_category_id_for_wizard_label(
    merged_rows: List[dict[str, Any]],
    wizard_label: str,
) -> str:
    """Supercategory id inferred from a wizard budget label (notes)."""
    sc = resolve_super_category_row(merged_rows, wizard_label, is_wizard=True)
    return str(sc.get("id") or "sonstiges")


def normalize_stored_mapping_to_super_id(
    merged_rows: List[dict[str, Any]],
    raw: str,
) -> str:
    """
    Normalize DB value to a supercategory id for API/UI.
    New rows store super ids; legacy rows may store a transaction category name.
    """
    s = (raw or "").strip()
    if not s:
        return ""
    if is_super_category_id(merged_rows, s):
        for r in merged_rows:
            if str(r.get("id", "")).lower() == s.lower():
                return str(r.get("id"))
        return s
    sc = resolve_super_category_row(merged_rows, s, is_wizard=False)
    return str(sc.get("id") or "sonstiges")


def resolve_mapping_value_to_txn_category(
    merged_rows: List[dict[str, Any]],
    stored: str,
    wizard_label: str,
) -> str:
    """
    Map stored user mapping to a concrete transaction category for Ist/actual comparison.
    Accepts supercategory id (preferred) or legacy transaction category name.
    """
    s = (stored or "").strip()
    if not s:
        return default_transaction_category_for_wizard_label(merged_rows, wizard_label)
    if is_super_category_id(merged_rows, s):
        txn = first_txn_category_for_super(merged_rows, s)
        if txn:
            return txn
        return default_transaction_category_for_wizard_label(merged_rows, wizard_label)
    return s


def peer_key_for_wizard_mapping(
    merged_rows: List[dict[str, Any]],
    wizard_label: str,
    stored_mapping: Optional[str],
) -> Optional[str]:
    """Peer benchmark column: explicit super assignment wins; else derive from wizard label."""
    s = (stored_mapping or "").strip()
    if s and is_super_category_id(merged_rows, s):
        for r in merged_rows:
            if str(r.get("id", "")).lower() == s.lower():
                return SUPER_ID_TO_PEER.get(str(r.get("id")))
        return SUPER_ID_TO_PEER.get(s.lower())
    return peer_key_for_wizard_label(merged_rows, wizard_label)


async def load_merged_taxonomy_for_user(session: Any, user_id: int) -> List[dict[str, Any]]:
    """Base taxonomy.json merged with Category rows for this user (same rules as GET /api/taxonomy)."""
    from sqlalchemy import func, or_, select

    from app.models.models import Category, Transaction

    base = load_base_super_categories()
    result = await session.execute(
        select(Category, func.count(Transaction.id).label("txn_count"))
        .outerjoin(
            Transaction,
            (Transaction.category_id == Category.id) & (Transaction.is_deleted == False),  # noqa: E712
        )
        .where(or_(Category.user_id == user_id, Category.is_system == True))  # noqa: E712
        .group_by(Category.id)
    )
    cats = [c for c, _ in result.all()]
    return merge_taxonomy_with_categories(base, cats)
