"""Accounts API — CRUD for bank accounts."""

from datetime import datetime, timezone
from typing import List, Optional

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.models import Account, AccountType, Transaction, User
from app.services.audit_log import record_activity
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import delete, desc, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter()


class AccountCreate(BaseModel):
    name: str
    bank: str
    account_number: Optional[str] = None
    iban: Optional[str] = None
    # Backward compatible default: many clients relied on CHF implicitly.
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
        select(Account).where(
            Account.user_id == current_user.id, Account.is_active == True
        )
    )
    accounts = result.scalars().all()
    return [
        AccountResponse(
            id=a.id,
            name=a.name,
            bank=a.bank,
            account_number=a.account_number,
            iban=a.iban,
            currency=a.currency,
            balance=a.balance,
            account_type=a.account_type.value,
            is_active=a.is_active,
            color=a.color,
            notes=a.notes,
        )
        for a in accounts
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
    await db.commit()
    await db.refresh(account)
    return AccountResponse(
        id=account.id,
        name=account.name,
        bank=account.bank,
        account_number=account.account_number,
        iban=account.iban,
        currency=account.currency,
        balance=account.balance,
        account_type=account.account_type.value,
        is_active=account.is_active,
        color=account.color,
        notes=account.notes,
    )


@router.put("/{account_id}", response_model=AccountResponse)
async def update_account(
    account_id: int,
    payload: AccountCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Account).where(
            Account.id == account_id, Account.user_id == current_user.id
        )
    )
    account = result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found.")
    for k, v in payload.model_dump().items():
        setattr(account, k, v)
    await db.flush()
    await db.commit()
    await db.refresh(account)
    return AccountResponse(
        id=account.id,
        name=account.name,
        bank=account.bank,
        account_number=account.account_number,
        iban=account.iban,
        currency=account.currency,
        balance=account.balance,
        account_type=account.account_type.value,
        is_active=account.is_active,
        color=account.color,
        notes=account.notes,
    )


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    account_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Account).where(
            Account.id == account_id, Account.user_id == current_user.id
        )
    )
    account = result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found.")
    account.is_active = False  # Soft delete
    await db.flush()
    await db.commit()


class BulkDeletePreviewResponse(BaseModel):
    transaction_count: int
    total_amount: float
    date_range: dict
    sample_transactions: List[dict]


class BulkDeleteResponse(BaseModel):
    deleted_count: int
    hard_delete: bool
    account_id: int


async def _build_bulk_delete_preview(
    db: AsyncSession,
    current_user: User,
    account_id: int,
) -> BulkDeletePreviewResponse:
    acct_result = await db.execute(
        select(Account).where(
            Account.id == account_id, Account.user_id == current_user.id
        )
    )
    account = acct_result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found.")

    count_result = await db.execute(
        select(func.count(Transaction.id)).where(
            Transaction.account_id == account_id,
            Transaction.is_deleted.isnot(True),
        )
    )
    transaction_count = count_result.scalar()

    total_result = await db.execute(
        select(
            func.coalesce(func.sum(Transaction.amount), 0.0),
            func.min(Transaction.date),
            func.max(Transaction.date),
        ).where(
            Transaction.account_id == account_id,
            Transaction.is_deleted.isnot(True),
        )
    )
    total_row = total_result.one()
    total_amount = float(total_row[0])
    min_date = total_row[1]
    max_date = total_row[2]

    sample_result = await db.execute(
        select(Transaction)
        .where(
            Transaction.account_id == account_id,
            Transaction.is_deleted.isnot(True),
        )
        .order_by(desc(Transaction.date))
        .limit(5)
    )
    sample_transactions = [
        {
            "id": t.id,
            "date": t.date.isoformat() if t.date else None,
            "description": t.description,
            "amount": t.amount,
            "category": t.category,
        }
        for t in sample_result.scalars().all()
    ]

    return BulkDeletePreviewResponse(
        transaction_count=transaction_count,
        total_amount=total_amount,
        date_range={
            "from": min_date.isoformat() if min_date else None,
            "to": max_date.isoformat() if max_date else None,
        },
        sample_transactions=sample_transactions,
    )


async def _execute_bulk_delete_transactions(
    db: AsyncSession,
    current_user: User,
    account_id: int,
    hard: bool,
) -> BulkDeleteResponse:
    acct_result = await db.execute(
        select(Account).where(
            Account.id == account_id, Account.user_id == current_user.id
        )
    )
    account = acct_result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found.")

    count_result = await db.execute(
        select(func.count(Transaction.id)).where(
            Transaction.account_id == account_id,
            Transaction.is_deleted.isnot(True),
        )
    )
    delete_count = count_result.scalar()

    if delete_count == 0:
        return BulkDeleteResponse(
            deleted_count=0,
            hard_delete=hard,
            account_id=account_id,
        )

    if hard:
        await db.execute(
            delete(Transaction).where(
                Transaction.account_id == account_id,
                Transaction.is_deleted.isnot(True),
            )
        )
    else:
        await db.execute(
            update(Transaction)
            .where(
                Transaction.account_id == account_id,
                Transaction.is_deleted.isnot(True),
            )
            .values(
                is_deleted=True,
                deleted_at=datetime.now(timezone.utc),
            )
        )

    await db.flush()
    await db.commit()
    await record_activity(
        db,
        user_id=current_user.id,
        action="account_transactions_hard_delete"
        if hard
        else "account_transactions_archive",
        method="bulk",
        affected_rows=delete_count,
        detail={"account_id": account_id, "hard": hard},
    )

    return BulkDeleteResponse(
        deleted_count=delete_count,
        hard_delete=hard,
        account_id=account_id,
    )


@router.get("/bulk-delete/preview", response_model=BulkDeletePreviewResponse)
async def preview_bulk_delete_by_query(
    account_id: int = Query(..., gt=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Preview transactions affected by bulk archive/delete.
    Uses a shallow path so reverse proxies reliably reach this handler.
    """
    return await _build_bulk_delete_preview(db, current_user, account_id)


@router.delete("/bulk-delete/transactions", response_model=BulkDeleteResponse)
async def delete_all_transactions_by_query(
    account_id: int = Query(..., gt=0),
    hard: bool = Query(False),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Bulk archive (soft) or hard-delete all active transactions for an account.
    Shallow path for proxy compatibility.
    """
    return await _execute_bulk_delete_transactions(db, current_user, account_id, hard)


@router.get(
    "/{account_id}/transactions/preview", response_model=BulkDeletePreviewResponse
)
async def preview_transactions_for_deletion(
    account_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Legacy nested path — identical behaviour as GET /bulk-delete/preview."""
    return await _build_bulk_delete_preview(db, current_user, account_id)


@router.delete("/{account_id}/transactions", response_model=BulkDeleteResponse)
async def delete_all_transactions_for_account(
    account_id: int,
    hard: bool = False,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Legacy nested path — identical behaviour as DELETE /bulk-delete/transactions."""
    return await _execute_bulk_delete_transactions(db, current_user, account_id, hard)
