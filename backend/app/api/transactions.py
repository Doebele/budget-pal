"""
Transactions API routes.

GET    /transactions               — list with filters
POST   /transactions               — manual create
PUT    /transactions/{id}          — update
DELETE /transactions/{id}          — delete
POST   /transactions/bulk-categorize
GET    /transactions/stats
GET    /transactions/monthly-summary
"""
from datetime import datetime, date
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_, desc
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.models import Transaction, Account, User, Category
from app.services.categorization import CategorizationService

router = APIRouter()
categorization_service = CategorizationService()


# ── Schemas ───────────────────────────────────────────────────

class TransactionResponse(BaseModel):
    id: int
    account_id: int
    account_name: str
    date: datetime
    booking_date: Optional[datetime]
    description: str
    merchant_normalized: Optional[str]
    amount: float
    currency: str
    category: Optional[str]
    subcategory: Optional[str]
    confidence_score: Optional[float]
    user_verified: bool
    notes: Optional[str]
    is_transfer: bool
    is_recurring: bool
    created_at: datetime

    class Config:
        from_attributes = True


class TransactionCreate(BaseModel):
    account_id: int
    date: datetime
    description: str
    amount: float
    currency: str = "CHF"
    category: Optional[str] = None
    subcategory: Optional[str] = None
    notes: Optional[str] = None
    is_transfer: bool = False


class TransactionUpdate(BaseModel):
    description: Optional[str] = None
    amount: Optional[float] = None
    date: Optional[datetime] = None
    category: Optional[str] = None
    subcategory: Optional[str] = None
    notes: Optional[str] = None
    is_transfer: Optional[bool] = None
    is_recurring: Optional[bool] = None
    user_verified: Optional[bool] = None
    merchant_normalized: Optional[str] = None


class BulkCategorizeRequest(BaseModel):
    transaction_ids: List[int]
    force_recategorize: bool = False


class MonthlySummaryItem(BaseModel):
    year: int
    month: int
    income: float
    expenses: float
    net: float
    transaction_count: int


class StatsResponse(BaseModel):
    total_income: float
    total_expenses: float
    net: float
    avg_monthly_expenses: float
    top_categories: List[dict]
    transaction_count: int


# ── Helper ────────────────────────────────────────────────────

async def get_user_transaction(
    transaction_id: int,
    current_user: User,
    db: AsyncSession,
) -> Transaction:
    """Fetch a transaction that belongs to the current user."""
    result = await db.execute(
        select(Transaction)
        .join(Account)
        .where(Transaction.id == transaction_id, Account.user_id == current_user.id)
        .options(selectinload(Transaction.account))
    )
    txn = result.scalar_one_or_none()
    if not txn:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    return txn


# ── Routes ────────────────────────────────────────────────────

@router.get("", response_model=List[TransactionResponse])
async def list_transactions(
    start: Optional[date] = Query(None, description="Filter from date (YYYY-MM-DD)"),
    end: Optional[date] = Query(None, description="Filter to date (YYYY-MM-DD)"),
    category: Optional[str] = Query(None),
    account_id: Optional[int] = Query(None),
    q: Optional[str] = Query(None, description="Full-text search in description"),
    min_amount: Optional[float] = Query(None),
    max_amount: Optional[float] = Query(None),
    is_transfer: Optional[bool] = Query(None),
    limit: int = Query(100, le=1000),
    offset: int = Query(0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List transactions for the current user with optional filters."""
    filters = [Account.user_id == current_user.id]

    if start:
        filters.append(Transaction.date >= datetime.combine(start, datetime.min.time()))
    if end:
        filters.append(Transaction.date <= datetime.combine(end, datetime.max.time()))
    if category:
        filters.append(Transaction.category == category)
    if account_id:
        filters.append(Transaction.account_id == account_id)
    if q:
        filters.append(
            or_(
                Transaction.description.ilike(f"%{q}%"),
                Transaction.merchant_normalized.ilike(f"%{q}%"),
            )
        )
    if min_amount is not None:
        filters.append(Transaction.amount >= min_amount)
    if max_amount is not None:
        filters.append(Transaction.amount <= max_amount)
    if is_transfer is not None:
        filters.append(Transaction.is_transfer == is_transfer)

    query = (
        select(Transaction)
        .join(Account)
        .where(and_(*filters))
        .options(selectinload(Transaction.account))
        .order_by(desc(Transaction.date))
        .limit(limit)
        .offset(offset)
    )
    result = await db.execute(query)
    transactions = result.scalars().all()

    return [
        TransactionResponse(
            id=t.id,
            account_id=t.account_id,
            account_name=t.account.name,
            date=t.date,
            booking_date=t.booking_date,
            description=t.description,
            merchant_normalized=t.merchant_normalized,
            amount=t.amount,
            currency=t.currency,
            category=t.category,
            subcategory=t.subcategory,
            confidence_score=t.confidence_score,
            user_verified=t.user_verified,
            notes=t.notes,
            is_transfer=t.is_transfer,
            is_recurring=t.is_recurring,
            created_at=t.created_at,
        )
        for t in transactions
    ]


@router.post("", response_model=TransactionResponse, status_code=status.HTTP_201_CREATED)
async def create_transaction(
    payload: TransactionCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Manually create a transaction."""
    # Verify account belongs to user
    acct_result = await db.execute(
        select(Account).where(Account.id == payload.account_id, Account.user_id == current_user.id)
    )
    account = acct_result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found.")

    cat = payload.category
    subcat = payload.subcategory
    confidence: Optional[float] = None
    merchant_normalized: Optional[str] = None

    # Run categorization if no category provided
    if not cat:
        result = await categorization_service.categorize(payload.description)
        cat = result["category"]
        subcat = result.get("subcategory")
        confidence = result["confidence_score"]
        merchant_normalized = result.get("merchant_normalized")

    txn = Transaction(
        account_id=payload.account_id,
        date=payload.date,
        description=payload.description,
        amount=payload.amount,
        currency=payload.currency,
        category=cat,
        subcategory=subcat,
        confidence_score=confidence,
        merchant_normalized=merchant_normalized,
        notes=payload.notes,
        is_transfer=payload.is_transfer,
        user_verified=bool(payload.category),
    )
    db.add(txn)
    await db.flush()
    await db.refresh(txn)

    return TransactionResponse(
        id=txn.id,
        account_id=txn.account_id,
        account_name=account.name,
        date=txn.date,
        booking_date=txn.booking_date,
        description=txn.description,
        merchant_normalized=txn.merchant_normalized,
        amount=txn.amount,
        currency=txn.currency,
        category=txn.category,
        subcategory=txn.subcategory,
        confidence_score=txn.confidence_score,
        user_verified=txn.user_verified,
        notes=txn.notes,
        is_transfer=txn.is_transfer,
        is_recurring=txn.is_recurring,
        created_at=txn.created_at,
    )


@router.put("/{transaction_id}", response_model=TransactionResponse)
async def update_transaction(
    transaction_id: int,
    payload: TransactionUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update a transaction. Setting category marks it as user_verified."""
    txn = await get_user_transaction(transaction_id, current_user, db)

    update_data = payload.model_dump(exclude_unset=True)
    if "category" in update_data and update_data["category"] is not None:
        update_data.setdefault("user_verified", True)

    for field, value in update_data.items():
        setattr(txn, field, value)

    await db.flush()
    await db.refresh(txn)

    return TransactionResponse(
        id=txn.id,
        account_id=txn.account_id,
        account_name=txn.account.name,
        date=txn.date,
        booking_date=txn.booking_date,
        description=txn.description,
        merchant_normalized=txn.merchant_normalized,
        amount=txn.amount,
        currency=txn.currency,
        category=txn.category,
        subcategory=txn.subcategory,
        confidence_score=txn.confidence_score,
        user_verified=txn.user_verified,
        notes=txn.notes,
        is_transfer=txn.is_transfer,
        is_recurring=txn.is_recurring,
        created_at=txn.created_at,
    )


@router.delete("/{transaction_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_transaction(
    transaction_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a transaction."""
    txn = await get_user_transaction(transaction_id, current_user, db)
    await db.delete(txn)


@router.post("/bulk-categorize")
async def bulk_categorize(
    payload: BulkCategorizeRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Re-run AI categorization on a selection of transactions."""
    result = await db.execute(
        select(Transaction)
        .join(Account)
        .where(
            Transaction.id.in_(payload.transaction_ids),
            Account.user_id == current_user.id,
        )
    )
    transactions = result.scalars().all()

    updated = 0
    for txn in transactions:
        if txn.user_verified and not payload.force_recategorize:
            continue
        cat_result = await categorization_service.categorize(txn.description)
        txn.category = cat_result["category"]
        txn.subcategory = cat_result.get("subcategory")
        txn.confidence_score = cat_result["confidence_score"]
        txn.merchant_normalized = cat_result.get("merchant_normalized")
        updated += 1

    await db.flush()
    return {"updated": updated, "skipped": len(transactions) - updated}


@router.get("/stats", response_model=StatsResponse)
async def get_stats(
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    account_id: Optional[int] = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Aggregated transaction statistics for the given period."""
    filters = [Account.user_id == current_user.id, Transaction.is_transfer == False]
    if start:
        filters.append(Transaction.date >= datetime.combine(start, datetime.min.time()))
    if end:
        filters.append(Transaction.date <= datetime.combine(end, datetime.max.time()))
    if account_id:
        filters.append(Transaction.account_id == account_id)

    # Total income (positive amounts)
    income_result = await db.execute(
        select(func.coalesce(func.sum(Transaction.amount), 0.0))
        .join(Account)
        .where(and_(*filters, Transaction.amount > 0))
    )
    total_income = float(income_result.scalar())

    # Total expenses (negative amounts)
    expense_result = await db.execute(
        select(func.coalesce(func.sum(Transaction.amount), 0.0))
        .join(Account)
        .where(and_(*filters, Transaction.amount < 0))
    )
    total_expenses = float(expense_result.scalar())

    # Count
    count_result = await db.execute(
        select(func.count(Transaction.id))
        .join(Account)
        .where(and_(*filters))
    )
    txn_count = int(count_result.scalar())

    # Top categories by spending
    cat_result = await db.execute(
        select(Transaction.category, func.sum(Transaction.amount).label("total"))
        .join(Account)
        .where(and_(*filters, Transaction.amount < 0, Transaction.category.isnot(None)))
        .group_by(Transaction.category)
        .order_by(func.sum(Transaction.amount))
        .limit(10)
    )
    top_categories = [
        {"category": row.category, "total": abs(float(row.total))}
        for row in cat_result.all()
    ]

    # Average monthly expenses (rough)
    avg_monthly = total_expenses / 12 if total_expenses else 0.0

    return StatsResponse(
        total_income=total_income,
        total_expenses=abs(total_expenses),
        net=total_income + total_expenses,
        avg_monthly_expenses=abs(avg_monthly),
        top_categories=top_categories,
        transaction_count=txn_count,
    )


@router.get("/monthly-summary", response_model=List[MonthlySummaryItem])
async def monthly_summary(
    year: Optional[int] = Query(None),
    account_id: Optional[int] = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Monthly income vs expense summary."""
    filters = [Account.user_id == current_user.id, Transaction.is_transfer == False]
    if year:
        filters.append(func.extract("year", Transaction.date) == year)
    if account_id:
        filters.append(Transaction.account_id == account_id)

    result = await db.execute(
        select(
            func.extract("year", Transaction.date).label("year"),
            func.extract("month", Transaction.date).label("month"),
            func.coalesce(
                func.sum(Transaction.amount).filter(Transaction.amount > 0), 0.0
            ).label("income"),
            func.coalesce(
                func.sum(Transaction.amount).filter(Transaction.amount < 0), 0.0
            ).label("expenses"),
            func.count(Transaction.id).label("transaction_count"),
        )
        .join(Account)
        .where(and_(*filters))
        .group_by(
            func.extract("year", Transaction.date),
            func.extract("month", Transaction.date),
        )
        .order_by(
            func.extract("year", Transaction.date),
            func.extract("month", Transaction.date),
        )
    )

    rows = result.all()
    return [
        MonthlySummaryItem(
            year=int(row.year),
            month=int(row.month),
            income=float(row.income),
            expenses=abs(float(row.expenses)),
            net=float(row.income) + float(row.expenses),
            transaction_count=int(row.transaction_count),
        )
        for row in rows
    ]
