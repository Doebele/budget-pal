"""
Settings API — maps wizard budget labels (empirical) to supercategory ids.

GET  /api/settings/category-mappings  → { wizard_label, transaction_category }
  `transaction_category` holds the supercategory id (e.g. wohnen, essen). Legacy DB
  values that stored a transaction category name are normalized to a super id.

PUT  /api/settings/category-mappings  → upsert; empty string clears override (revert to taxonomy default).
"""
from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.taxonomy import (
    default_super_category_id_for_wizard_label,
    load_merged_taxonomy_for_user,
    normalize_stored_mapping_to_super_id,
)
from app.models.models import Account, Transaction, User, WizardCategoryMapping
from app.services import ai_client

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Pydantic models ───────────────────────────────────────────

class CategoryMappingItem(BaseModel):
    wizard_label: str
    transaction_category: str = ""  # supercategory id; empty = clear override on PUT


class CategoryMappingsResponse(BaseModel):
    mappings: List[CategoryMappingItem]
    wizard_labels: List[str]          # known wizard labels from budgets
    transaction_categories: List[str]  # known txn categories from transactions


class PutMappingsRequest(BaseModel):
    mappings: List[CategoryMappingItem]


# ── Helpers ───────────────────────────────────────────────────

async def _get_wizard_labels(user_id: int, db: AsyncSession) -> list[str]:
    """Return distinct wizard budget labels (notes) for the user's latest batch."""
    from app.models.models import Budget
    ts_result = await db.execute(
        select(func.max(Budget.created_at)).where(Budget.user_id == user_id)
    )
    latest_ts = ts_result.scalar_one_or_none()
    if latest_ts is None:
        return []
    result = await db.execute(
        select(Budget.notes).where(
            and_(Budget.user_id == user_id, Budget.created_at == latest_ts)
        ).distinct()
    )
    return sorted([r for r in result.scalars() if r])


async def _get_txn_categories(user_id: int, db: AsyncSession) -> list[str]:
    """Return distinct transaction categories for the user."""
    result = await db.execute(
        select(Transaction.category)
        .join(Account)
        .where(
            and_(
                Account.user_id == user_id,
                Transaction.is_deleted.isnot(True),
                Transaction.category.isnot(None),
            )
        )
        .distinct()
    )
    return sorted([r for r in result.scalars() if r])


def _mapping_items_for_labels(
    merged: list,
    wizard_labels: list[str],
    user_rows: dict[str, WizardCategoryMapping],
) -> list[CategoryMappingItem]:
    items: list[CategoryMappingItem] = []
    for label in wizard_labels:
        lower = label.lower()
        if lower in user_rows:
            eff = normalize_stored_mapping_to_super_id(merged, user_rows[lower].transaction_category)
        else:
            eff = default_super_category_id_for_wizard_label(merged, label)
        items.append(CategoryMappingItem(wizard_label=label, transaction_category=eff))
    return items


# ── Endpoints ─────────────────────────────────────────────────

@router.get("/category-mappings", response_model=CategoryMappingsResponse)
async def get_category_mappings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return wizard label → supercategory id (effective, with legacy normalization)."""
    result = await db.execute(
        select(WizardCategoryMapping).where(
            WizardCategoryMapping.user_id == current_user.id
        )
    )
    user_rows = {m.wizard_label.lower(): m for m in result.scalars()}

    wizard_labels = await _get_wizard_labels(current_user.id, db)
    txn_categories = await _get_txn_categories(current_user.id, db)
    merged = await load_merged_taxonomy_for_user(db, current_user.id)

    mappings = _mapping_items_for_labels(merged, wizard_labels, user_rows)

    return CategoryMappingsResponse(
        mappings=mappings,
        wizard_labels=wizard_labels,
        transaction_categories=txn_categories,
    )


@router.put("/category-mappings", response_model=CategoryMappingsResponse)
async def put_category_mappings(
    body: PutMappingsRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upsert supercategory mappings; empty `transaction_category` removes the override."""
    result = await db.execute(
        select(WizardCategoryMapping).where(
            WizardCategoryMapping.user_id == current_user.id
        )
    )
    existing = {m.wizard_label.lower(): m for m in result.scalars()}

    for item in body.mappings:
        lower = item.wizard_label.lower()
        val = (item.transaction_category or "").strip()
        if not val:
            if lower in existing:
                await db.delete(existing[lower])
                del existing[lower]
            continue
        if lower in existing:
            existing[lower].transaction_category = val
        else:
            db.add(
                WizardCategoryMapping(
                    user_id=current_user.id,
                    wizard_label=item.wizard_label,
                    transaction_category=val,
                )
            )

    await db.commit()

    wizard_labels = await _get_wizard_labels(current_user.id, db)
    txn_categories = await _get_txn_categories(current_user.id, db)
    merged = await load_merged_taxonomy_for_user(db, current_user.id)

    result2 = await db.execute(
        select(WizardCategoryMapping).where(
            WizardCategoryMapping.user_id == current_user.id
        )
    )
    user_rows2 = {m.wizard_label.lower(): m for m in result2.scalars()}

    mappings = _mapping_items_for_labels(merged, wizard_labels, user_rows2)

    return CategoryMappingsResponse(
        mappings=mappings,
        wizard_labels=wizard_labels,
        transaction_categories=txn_categories,
    )


@router.delete("/category-mappings", status_code=204)
async def reset_category_mappings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Reset all user-specific mappings (reverts to defaults)."""
    result = await db.execute(
        select(WizardCategoryMapping).where(
            WizardCategoryMapping.user_id == current_user.id
        )
    )
    for row in result.scalars():
        await db.delete(row)
    await db.commit()


# ── KI-Anbieter / Modellauswahl ───────────────────────────────
#
# GET  /api/settings/ai            → aktiver Anbieter + ein Profil je Anbieter
#                                     (API-Keys maskiert zu has_key)
# PUT  /api/settings/ai            → Teil-Update; Key weglassen = unverändert, "" = löschen
# GET  /api/settings/ai/providers  → Anbieterliste (Katalog, wie fintools)
# GET  /api/settings/ai/models     → Modellliste live vom Anbieter
# POST /api/settings/ai/test       → Endpunkt/Key prüfen, Modell anpingen


class AiProfileOut(BaseModel):
    endpoint: str
    model: str
    # Keys werden nie zurückgegeben — nur ob einer hinterlegt ist
    has_key: bool
    ok: bool


class AiSettingsResponse(BaseModel):
    provider: str
    profiles: Dict[str, AiProfileOut]
    # 0 = automatisch. Daneben der erkannte Wert, damit die UI zeigen kann,
    # was ohne Uebersteuerung passieren wuerde.
    context_chars_override: int = 0
    detected_context_tokens: Optional[int] = None
    effective_context_chars: int = 0


class AiProfileIn(BaseModel):
    endpoint: Optional[str] = None
    model: Optional[str] = None
    # None = unverändert lassen, "" = Key löschen
    key: Optional[str] = None
    # Vom Client gemeldet: der Test mit genau diesen Werten war erfolgreich.
    # Nur ein Haken in der eigenen Anzeige — keine Sicherheitsfrage.
    ok: Optional[bool] = None


class AiSettingsRequest(BaseModel):
    provider: Optional[str] = None
    profiles: Optional[Dict[str, AiProfileIn]] = None
    context_chars_override: Optional[int] = None


class AiProviderOut(BaseModel):
    id: str
    label: str
    url: str
    key_url: str
    placeholder: str
    note: str
    local: bool


class AiTestRequest(BaseModel):
    provider: str
    # Weggelassen = gespeicherter Wert. Der Key MUSS weglassbar sein: der
    # Browser kennt den gespeicherten nicht, er bekommt ihn nie zurück.
    endpoint: Optional[str] = None
    model: Optional[str] = None
    key: Optional[str] = None


class AiTestResponse(BaseModel):
    ok: bool
    models: Optional[List[str]] = None
    model: str = ""
    reply: str = ""
    latency_ms: int = 0
    error: str = ""


def _check_provider(provider: str, *, allow_none: bool = True) -> None:
    allowed = ai_client.PROVIDERS if allow_none else tuple(ai_client.CATALOG)
    if provider not in allowed:
        raise HTTPException(status_code=400, detail=f"Unbekannter Anbieter: {provider}")


def _check_endpoint(endpoint: Optional[str]) -> None:
    """Nur http(s). Der Server ruft diese Adresse selbst auf."""
    if endpoint and not re.match(r"^https?://[^\s/]+", endpoint.strip()):
        raise HTTPException(status_code=400, detail="Endpunkt muss mit http:// oder https:// beginnen")


def _with_overrides(
    cfg: ai_client.AiConfig,
    provider: str,
    endpoint: Optional[str] = None,
    model: Optional[str] = None,
    key: Optional[str] = None,
) -> ai_client.AiConfig:
    """Kopie der Konfiguration mit anderem Anbieter und ungespeicherten Werten —
    fuer Modellliste und Test, bevor gespeichert wird."""
    stored = cfg.profiles.get(provider) or ai_client.AiProfile()
    profile = stored.model_copy(update={
        k: v for k, v in {"endpoint": endpoint, "model": model, "key": key}.items()
        if v is not None
    })
    # Ein gespeicherter Key geht nur an den Endpunkt, mit dem er gespeichert
    # wurde. Sonst liesse sich mit einem gestohlenen Session-Token jeder Key
    # abgreifen: Test mit fremdem Endpunkt, ohne Key — und der Server schickt
    # den gespeicherten dorthin. Die Maskierung in den Antworten waere dann
    # wertlos. (fintools hat dieselbe Luecke.)
    if key is None and ai_client.endpoint_moves(provider, stored, endpoint):
        profile.key = ""
    return cfg.model_copy(update={
        "provider": provider,
        "profiles": {**cfg.profiles, provider: profile},
    })


async def _ai_response(cfg: ai_client.AiConfig) -> AiSettingsResponse:
    from app.services.pdf_ai_extract import MAX_TOKENS_PER_CHUNK

    detected = await ai_client.detect_context_tokens(cfg)
    effective = await ai_client.resolve_chunk_chars(cfg, MAX_TOKENS_PER_CHUNK)
    return AiSettingsResponse(
        provider=cfg.provider,
        profiles={
            pid: AiProfileOut(
                endpoint=prof.endpoint,
                model=prof.model,
                has_key=bool(prof.key),
                ok=prof.ok,
            )
            for pid, prof in cfg.profiles.items()
        },
        context_chars_override=cfg.context_chars_override,
        detected_context_tokens=detected,
        effective_context_chars=effective,
    )


@router.get("/ai", response_model=AiSettingsResponse)
async def get_ai_settings(current_user: User = Depends(get_current_user)):
    return await _ai_response(ai_client.from_user(current_user))


@router.put("/ai", response_model=AiSettingsResponse)
async def put_ai_settings(
    payload: AiSettingsRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if payload.provider is not None:
        _check_provider(payload.provider)

    cfg = ai_client.from_user(current_user)
    if payload.provider is not None:
        cfg.provider = payload.provider
    if payload.context_chars_override is not None:
        cfg.context_chars_override = payload.context_chars_override

    for pid, change in (payload.profiles or {}).items():
        _check_provider(pid, allow_none=False)
        _check_endpoint(change.endpoint)
        stored = cfg.profiles.get(pid) or ai_client.AiProfile()
        # Dieselbe Bindung wie beim Test: der gespeicherte Key zieht nicht
        # stillschweigend an einen neuen Endpunkt um.
        if stored.key and change.key is None and ai_client.endpoint_moves(pid, stored, change.endpoint):
            raise HTTPException(
                status_code=400,
                detail="Endpunkt geändert — bitte den API-Key erneut eingeben.",
            )
        # exclude_unset: weggelassene Felder bleiben unverändert — ein
        # weggelassener API-Key darf den gespeicherten nicht überschreiben
        updates = {k: v for k, v in change.model_dump(exclude_unset=True).items() if v is not None}
        values_changed = any(
            k in updates and updates[k] != getattr(stored, k)
            for k in ("endpoint", "model", "key")
        )
        # Wer Endpunkt, Modell oder Key aendert, verliert den Test-Haken —
        # es sei denn, er meldet im selben Zug einen erfolgreichen Test.
        if values_changed and "ok" not in updates:
            updates["ok"] = False
        cfg.profiles[pid] = stored.model_copy(update=updates)

    # model_dump statt Referenz: SQLAlchemy erkennt Aenderungen an JSON-Spalten
    # nur bei neuer Zuweisung.
    current_user.ai_config_json = cfg.model_dump()
    await db.commit()
    return await _ai_response(cfg)


@router.get("/ai/providers", response_model=List[AiProviderOut])
async def get_ai_providers(current_user: User = Depends(get_current_user)):
    """Anbieterliste. Eine Quelle fuer Backend und Oberflaeche — fintools
    haelt sie nur im Frontend, dort koennen Server und UI auseinanderlaufen."""
    return [
        AiProviderOut(
            id=p.id, label=p.label, url=p.url, key_url=p.key_url,
            placeholder=p.placeholder, note=p.note, local=p.local,
        )
        for p in ai_client.PROVIDER_CATALOG
    ]


@router.get("/ai/models", response_model=List[str])
async def get_ai_models(
    provider: Optional[str] = None,
    endpoint: Optional[str] = None,
    current_user: User = Depends(get_current_user),
):
    """Modellliste live vom Anbieter. `provider`/`endpoint` überschreiben die
    gespeicherte Auswahl, der Key kommt immer aus dem gespeicherten Profil."""
    cfg = ai_client.from_user(current_user)
    if provider:
        _check_provider(provider)
        _check_endpoint(endpoint)
        cfg = _with_overrides(cfg, provider, endpoint=endpoint)
    return await ai_client.list_models(cfg)


@router.post("/ai/test", response_model=AiTestResponse)
async def test_ai_connection(
    payload: AiTestRequest,
    current_user: User = Depends(get_current_user),
):
    """Verbindung pruefen, ohne zu speichern. Antwortet 200 auch bei einem
    fehlgeschlagenen Test — die Anfrage selbst hat ja funktioniert."""
    _check_provider(payload.provider, allow_none=False)
    _check_endpoint(payload.endpoint)
    cfg = _with_overrides(
        ai_client.from_user(current_user),
        payload.provider,
        endpoint=payload.endpoint,
        model=payload.model,
        key=payload.key or None,
    )
    result = await ai_client.check_connection(cfg)
    return AiTestResponse(**result._asdict())
