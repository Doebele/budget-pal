"""GET /api/taxonomy — merged supercategory taxonomy for the current user."""
from __future__ import annotations

import json
from typing import Any, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.taxonomy import get_taxonomy_file_version, load_merged_taxonomy_for_user, load_base_super_categories
from app.models.models import User

router = APIRouter()


class SuperCategoryOut(BaseModel):
    id: str
    label: str
    color: str
    emoji: str = ""
    txnCategories: List[str]
    wizardLabels: List[str]
    legacyAliases: List[str] = Field(default_factory=list)


class TaxonomyResponse(BaseModel):
    version: int
    superCategories: List[SuperCategoryOut]


class HideLabelPayload(BaseModel):
    sc_id: str
    label: str
    label_type: Literal["txn", "wl"]


class HiddenLabelsResponse(BaseModel):
    hidden: dict[str, list[str]]


def _row_to_out(row: dict[str, Any]) -> SuperCategoryOut:
    return SuperCategoryOut(
        id=row["id"],
        label=row["label"],
        color=row.get("color") or "#94a3b8",
        emoji=row.get("emoji") or "",
        txnCategories=list(row.get("txnCategories") or []),
        wizardLabels=[str(x).lower() for x in (row.get("wizardLabels") or [])],
        legacyAliases=list(row.get("legacyAliases") or []),
    )


def _parse_hidden(user: User) -> dict[str, list[str]]:
    """Parse user.taxonomy_hidden_json → dict. Key format: '{sc_id}:{txn|wl}'."""
    raw = getattr(user, "taxonomy_hidden_json", None)
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


def _apply_hidden(rows: list[dict[str, Any]], hidden: dict[str, list[str]]) -> list[dict[str, Any]]:
    """Remove hidden canonical labels from merged taxonomy rows (modifies copies)."""
    import copy
    rows = copy.deepcopy(rows)
    for row in rows:
        sc_id = row.get("id", "")
        txn_hidden = set(str(x).lower() for x in hidden.get(f"{sc_id}:txn", []))
        wl_hidden = set(str(x).lower() for x in hidden.get(f"{sc_id}:wl", []))
        if txn_hidden:
            row["txnCategories"] = [c for c in (row.get("txnCategories") or []) if c.lower() not in txn_hidden]
        if wl_hidden:
            row["wizardLabels"] = [l for l in (row.get("wizardLabels") or []) if str(l).lower() not in wl_hidden]
    return rows


@router.get("", response_model=TaxonomyResponse)
async def get_taxonomy(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    merged = await load_merged_taxonomy_for_user(db, current_user.id)
    hidden = _parse_hidden(current_user)
    if hidden:
        merged = _apply_hidden(merged, hidden)
    return TaxonomyResponse(
        version=get_taxonomy_file_version(),
        superCategories=[_row_to_out(r) for r in merged],
    )


@router.get("/hidden-labels", response_model=HiddenLabelsResponse)
async def get_hidden_labels(
    current_user: User = Depends(get_current_user),
):
    return HiddenLabelsResponse(hidden=_parse_hidden(current_user))


@router.post("/hide-canonical-label", status_code=status.HTTP_200_OK)
async def hide_canonical_label(
    payload: HideLabelPayload,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Mark a canonical taxonomy label as hidden for this user."""
    # Validate sc_id exists
    base = load_base_super_categories()
    sc_ids = {r["id"] for r in base}
    if payload.sc_id not in sc_ids:
        raise HTTPException(status_code=404, detail=f"Supercategory '{payload.sc_id}' not found.")

    hidden = _parse_hidden(current_user)
    key = f"{payload.sc_id}:{payload.label_type}"
    labels = hidden.get(key, [])
    label_lower = payload.label.strip().lower() if payload.label_type == "wl" else payload.label.strip()
    if label_lower not in [l.lower() for l in labels]:
        labels.append(payload.label.strip())
        hidden[key] = labels

    await db.execute(
        update(User)
        .where(User.id == current_user.id)
        .values(taxonomy_hidden_json=json.dumps(hidden, ensure_ascii=False))
    )
    await db.commit()
    return {"hidden": hidden}


@router.delete("/hide-canonical-label", status_code=status.HTTP_200_OK)
async def unhide_canonical_label(
    payload: HideLabelPayload,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove a canonical taxonomy label from the user's hidden list (restore visibility)."""
    hidden = _parse_hidden(current_user)
    key = f"{payload.sc_id}:{payload.label_type}"
    if key in hidden:
        label_lower = payload.label.strip().lower()
        hidden[key] = [l for l in hidden[key] if l.lower() != label_lower]
        if not hidden[key]:
            del hidden[key]

    await db.execute(
        update(User)
        .where(User.id == current_user.id)
        .values(taxonomy_hidden_json=json.dumps(hidden, ensure_ascii=False) if hidden else None)
    )
    await db.commit()
    return {"hidden": hidden}
