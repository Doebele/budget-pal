"""Assets API — property, stocks, crypto, etc."""

from datetime import datetime
from typing import List, Optional

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.models import Asset, AssetType, User
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter()


class AssetCreate(BaseModel):
    asset_type: AssetType
    name: str
    current_value: float
    currency: str = "CHF"
    as_of_date: Optional[datetime] = None
    expected_return_rate: Optional[float] = None
    notes: Optional[str] = None


class AssetResponse(BaseModel):
    id: int
    asset_type: str
    name: str
    current_value: float
    currency: str
    as_of_date: Optional[datetime]
    expected_return_rate: Optional[float]
    notes: Optional[str]


@router.get("", response_model=List[AssetResponse])
async def list_assets(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Asset).where(Asset.user_id == current_user.id))
    assets = result.scalars().all()
    return [
        AssetResponse(
            id=a.id,
            asset_type=a.asset_type.value,
            name=a.name,
            current_value=a.current_value,
            currency=a.currency,
            as_of_date=a.as_of_date,
            expected_return_rate=a.expected_return_rate,
            notes=a.notes,
        )
        for a in assets
    ]


@router.post("", response_model=AssetResponse, status_code=status.HTTP_201_CREATED)
async def create_asset(
    payload: AssetCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    asset = Asset(user_id=current_user.id, **payload.model_dump())
    db.add(asset)
    await db.flush()
    await db.commit()
    await db.refresh(asset)
    return AssetResponse(
        id=asset.id,
        asset_type=asset.asset_type.value,
        name=asset.name,
        current_value=asset.current_value,
        currency=asset.currency,
        as_of_date=asset.as_of_date,
        expected_return_rate=asset.expected_return_rate,
        notes=asset.notes,
    )


@router.put("/{asset_id}", response_model=AssetResponse)
async def update_asset(
    asset_id: int,
    payload: AssetCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Asset).where(Asset.id == asset_id, Asset.user_id == current_user.id)
    )
    asset = result.scalar_one_or_none()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found.")
    for k, v in payload.model_dump().items():
        setattr(asset, k, v)
    await db.flush()
    await db.commit()
    await db.refresh(asset)
    return AssetResponse(
        id=asset.id,
        asset_type=asset.asset_type.value,
        name=asset.name,
        current_value=asset.current_value,
        currency=asset.currency,
        as_of_date=asset.as_of_date,
        expected_return_rate=asset.expected_return_rate,
        notes=asset.notes,
    )


@router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset(
    asset_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Asset).where(Asset.id == asset_id, Asset.user_id == current_user.id)
    )
    asset = result.scalar_one_or_none()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found.")
    await db.delete(asset)
