"""Accounts API — CRUD for bank accounts."""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.core.database import get_db
from app.core.security import get_current_user
from app.models.models import Account, AccountType, User

router = APIRouter()


class AccountCreate(BaseModel):
    name: str
    bank: str
    account_number: Optional[str] = None
    iban: Optional[str] = None
    currency: str = "CHF"
    balance: float = 0.0
    account_type: AccountType = AccountType.checking
    color: Optional[str] = None
    notes: Optional[str] = None


class AccountResponse(BaseModel):
    id: int
    name: str
    bank: str
    account_number: Optional[str]
    iban: Optional[str]
    currency: str
    balance: float
    account_type: str
    is_active: bool
    color: Optional[str]
    notes: Optional[str]


@router.get("", response_model=List[AccountResponse])
async def list_accounts(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Account).where(Account.user_id == current_user.id, Account.is_active == True)
    )
    accounts = result.scalars().all()
    return [
        AccountResponse(
            id=a.id, name=a.name, bank=a.bank,
            account_number=a.account_number, iban=a.iban,
            currency=a.currency, balance=a.balance,
            account_type=a.account_type.value,
            is_active=a.is_active, color=a.color, notes=a.notes,
        ) for a in accounts
    ]


@router.post("", response_model=AccountResponse, status_code=status.HTTP_201_CREATED)
async def create_account(
    payload: AccountCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    account = Account(user_id=current_user.id, **payload.model_dump())
    db.add(account)
    await db.flush()
    await db.refresh(account)
    return AccountResponse(
        id=account.id, name=account.name, bank=account.bank,
        account_number=account.account_number, iban=account.iban,
        currency=account.currency, balance=account.balance,
        account_type=account.account_type.value,
        is_active=account.is_active, color=account.color, notes=account.notes,
    )


@router.put("/{account_id}", response_model=AccountResponse)
async def update_account(
    account_id: int,
    payload: AccountCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Account).where(Account.id == account_id, Account.user_id == current_user.id)
    )
    account = result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found.")
    for k, v in payload.model_dump().items():
        setattr(account, k, v)
    await db.flush()
    await db.refresh(account)
    return AccountResponse(
        id=account.id, name=account.name, bank=account.bank,
        account_number=account.account_number, iban=account.iban,
        currency=account.currency, balance=account.balance,
        account_type=account.account_type.value,
        is_active=account.is_active, color=account.color, notes=account.notes,
    )


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    account_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Account).where(Account.id == account_id, Account.user_id == current_user.id)
    )
    account = result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found.")
    account.is_active = False  # Soft delete
    await db.flush()
