"""GET /api/taxonomy — merged supercategory taxonomy for the current user."""
from __future__ import annotations

from typing import Any, List

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.taxonomy import get_taxonomy_file_version, load_merged_taxonomy_for_user
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


@router.get("", response_model=TaxonomyResponse)
async def get_taxonomy(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    merged = await load_merged_taxonomy_for_user(db, current_user.id)
    return TaxonomyResponse(
        version=get_taxonomy_file_version(),
        superCategories=[_row_to_out(r) for r in merged],
    )
