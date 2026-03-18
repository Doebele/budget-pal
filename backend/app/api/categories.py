"""Categories API."""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_
from app.core.database import get_db
from app.core.security import get_current_user
from app.models.models import Category, User

router = APIRouter()


class CategoryCreate(BaseModel):
    name: str
    slug: str
    parent_id: Optional[int] = None
    color: Optional[str] = None
    icon: Optional[str] = None


class CategoryResponse(BaseModel):
    id: int
    name: str
    slug: str
    parent_id: Optional[int]
    color: Optional[str]
    icon: Optional[str]
    is_system: bool


@router.get("", response_model=List[CategoryResponse])
async def list_categories(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Category).where(
            or_(Category.user_id == current_user.id, Category.is_system == True)
        ).order_by(Category.sort_order, Category.name)
    )
    cats = result.scalars().all()
    return [
        CategoryResponse(
            id=c.id, name=c.name, slug=c.slug,
            parent_id=c.parent_id, color=c.color,
            icon=c.icon, is_system=c.is_system,
        ) for c in cats
    ]


@router.post("", response_model=CategoryResponse, status_code=status.HTTP_201_CREATED)
async def create_category(
    payload: CategoryCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cat = Category(user_id=current_user.id, **payload.model_dump())
    db.add(cat)
    await db.flush()
    await db.refresh(cat)
    return CategoryResponse(
        id=cat.id, name=cat.name, slug=cat.slug,
        parent_id=cat.parent_id, color=cat.color,
        icon=cat.icon, is_system=cat.is_system,
    )


@router.put("/{category_id}", response_model=CategoryResponse)
async def update_category(
    category_id: int,
    payload: CategoryCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Category).where(Category.id == category_id, Category.user_id == current_user.id)
    )
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found.")
    for k, v in payload.model_dump().items():
        setattr(cat, k, v)
    await db.flush()
    await db.refresh(cat)
    return CategoryResponse(
        id=cat.id, name=cat.name, slug=cat.slug,
        parent_id=cat.parent_id, color=cat.color,
        icon=cat.icon, is_system=cat.is_system,
    )


@router.delete("/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_category(
    category_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Category).where(Category.id == category_id, Category.user_id == current_user.id, Category.is_system == False)
    )
    cat = result.scalar_one_or_none()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found or is a system category.")
    await db.delete(cat)
