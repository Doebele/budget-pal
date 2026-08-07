"""
Settings API — maps wizard budget labels (empirical) to supercategory ids.

GET  /api/settings/category-mappings  → { wizard_label, transaction_category }
  `transaction_category` holds the supercategory id (e.g. wohnen, essen). Legacy DB
  values that stored a transaction category name are normalized to a super id.

PUT  /api/settings/category-mappings  → upsert; empty string clears override (revert to taxonomy default).
"""
from __future__ import annotations

import logging
from typing import List, Optional

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


# ── KI-Provider / Modellauswahl ───────────────────────────────
#
# GET  /api/settings/ai         → aktuelle Auswahl, API-Keys als has_*-Flags maskiert
# PUT  /api/settings/ai         → Teil-Update; Key weglassen = unverändert, "" = löschen
# GET  /api/settings/ai/models  → Modellliste (lokale Provider werden live abgefragt)


class AiSettingsResponse(BaseModel):
    provider: str
    lm_studio_url: str
    lm_studio_model: str
    ollama_url: str
    ollama_model: str
    anthropic_model: str
    openai_model: str
    gemini_model: str
    openrouter_model: str
    # Keys werden nie zurückgegeben — nur ob einer hinterlegt ist
    has_anthropic_key: bool
    has_openai_key: bool
    has_gemini_key: bool
    has_openrouter_key: bool


class AiSettingsRequest(BaseModel):
    provider: Optional[str] = None
    lm_studio_url: Optional[str] = None
    lm_studio_model: Optional[str] = None
    ollama_url: Optional[str] = None
    ollama_model: Optional[str] = None
    anthropic_model: Optional[str] = None
    openai_model: Optional[str] = None
    gemini_model: Optional[str] = None
    openrouter_model: Optional[str] = None
    # None = unverändert lassen, "" = Key löschen
    anthropic_api_key: Optional[str] = None
    openai_api_key: Optional[str] = None
    gemini_api_key: Optional[str] = None
    openrouter_api_key: Optional[str] = None


def _ai_response(cfg: ai_client.AiConfig) -> AiSettingsResponse:
    return AiSettingsResponse(
        provider=cfg.provider,
        lm_studio_url=cfg.lm_studio_url,
        lm_studio_model=cfg.lm_studio_model,
        ollama_url=cfg.ollama_url,
        ollama_model=cfg.ollama_model,
        anthropic_model=cfg.anthropic_model,
        openai_model=cfg.openai_model,
        gemini_model=cfg.gemini_model,
        openrouter_model=cfg.openrouter_model,
        has_anthropic_key=bool(cfg.anthropic_api_key),
        has_openai_key=bool(cfg.openai_api_key),
        has_gemini_key=bool(cfg.gemini_api_key),
        has_openrouter_key=bool(cfg.openrouter_api_key),
    )


@router.get("/ai", response_model=AiSettingsResponse)
async def get_ai_settings(current_user: User = Depends(get_current_user)):
    return _ai_response(ai_client.from_user(current_user))


@router.put("/ai", response_model=AiSettingsResponse)
async def put_ai_settings(
    payload: AiSettingsRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if payload.provider is not None and payload.provider not in ai_client.PROVIDERS:
        raise HTTPException(
            status_code=400,
            detail=f"Unbekannter Provider. Erlaubt: {', '.join(ai_client.PROVIDERS)}",
        )

    cfg = ai_client.from_user(current_user)
    # exclude_unset: weggelassene Felder bleiben unverändert — ein weggelassener
    # API-Key darf den gespeicherten nicht überschreiben
    for field, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(cfg, field, value)

    current_user.ai_config_json = cfg.model_dump()
    await db.commit()
    return _ai_response(cfg)


@router.get("/ai/models", response_model=List[str])
async def get_ai_models(
    provider: Optional[str] = None,
    url: Optional[str] = None,
    current_user: User = Depends(get_current_user),
):
    """Modellliste. `provider`/`url` überschreiben die gespeicherte Konfiguration,
    damit die UI eine Verbindung testen kann, bevor sie gespeichert wird."""
    cfg = ai_client.from_user(current_user)
    if provider:
        if provider not in ai_client.PROVIDERS:
            raise HTTPException(status_code=400, detail="Unbekannter Provider.")
        cfg.provider = provider
    if url:
        if cfg.provider == "lm-studio":
            cfg.lm_studio_url = url
        elif cfg.provider == "ollama":
            cfg.ollama_url = url
    return await ai_client.list_models(cfg)
