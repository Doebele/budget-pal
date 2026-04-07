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
from datetime import datetime, date, timezone
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
from app.services.audit_log import record_activity

router = APIRouter()
categorization_service = CategorizationService()


def _utc_start_of_day(d: date) -> datetime:
    """Inclusive lower bound for TIMESTAMPTZ columns (asyncpg rejects naive datetimes)."""
    return datetime.combine(d, datetime.min.time(), tzinfo=timezone.utc)


def _utc_end_of_day(d: date) -> datetime:
    """Inclusive upper bound for TIMESTAMPTZ columns."""
    return datetime.combine(d, datetime.max.time(), tzinfo=timezone.utc)


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
    periodicity: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class ArchivedTransactionResponse(BaseModel):
    """Soft-deleted transaction for archive / restore UI."""

    id: int
    account_id: int
    account_name: str
    date: datetime
    description: str
    amount: float
    currency: str
    category: Optional[str]
    deleted_at: Optional[datetime]
    is_recurring: bool = False
    periodicity: Optional[str] = None

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
    is_recurring: bool = False
    periodicity: Optional[str] = None  # 'weekly', 'monthly', 'quarterly', 'halfyearly', 'yearly'


class TransactionUpdate(BaseModel):
    description: Optional[str] = None
    amount: Optional[float] = None
    date: Optional[datetime] = None
    category: Optional[str] = None
    subcategory: Optional[str] = None
    notes: Optional[str] = None
    is_transfer: Optional[bool] = None
    is_recurring: Optional[bool] = None
    periodicity: Optional[str] = None
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


class RecurringCostItem(BaseModel):
    description: str
    category: Optional[str]
    amount: float
    periodicity: str
    monthly_equivalent: float


class BudgetAnalysisResponse(BaseModel):
    total_monthly_income: float
    fixed_recurring_costs: float  # Sum of all recurring transactions * periodicity factor
    variable_costs: float  # Sum of all non-recurring transactions
    monthly_budget_limit: float  # Configurable or calculated
    variance: float  # Limit - (Fixed + Variable)
    recurring_items: List[RecurringCostItem]
    period_start: date
    period_end: date


# ── Helper ────────────────────────────────────────────────────

# Periodicity factors to convert to monthly equivalent
PERIODICITY_MONTHLY_FACTOR = {
    "weekly": 4.33,      # ~52 weeks / 12 months
    "monthly": 1.0,
    "quarterly": 1.0 / 3,  # 4 times per year
    "halfyearly": 1.0 / 6,  # 2 times per year
    "yearly": 1.0 / 12,    # 1 time per year
}

_PERIODICITY_LIST_FILTER = frozenset({"weekly", "monthly", "quarterly", "halfyearly", "yearly"})


def _apply_recurrence_list_filters(
    filters: list,
    *,
    is_recurring: Optional[bool],
    periodicity: Optional[str],
) -> None:
    """periodicity implies is_recurring=True and exact periodicity match."""
    if periodicity:
        if periodicity not in _PERIODICITY_LIST_FILTER:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid periodicity filter (allowed: {', '.join(sorted(_PERIODICITY_LIST_FILTER))}).",
            )
        filters.append(Transaction.is_recurring.is_(True))
        filters.append(Transaction.periodicity == periodicity)
    elif is_recurring is not None:
        filters.append(Transaction.is_recurring == is_recurring)

async def get_user_transaction(
    transaction_id: int,
    current_user: User,
    db: AsyncSession,
    *,
    only_active: bool = True,
) -> Transaction:
    """Fetch a transaction that belongs to the current user (excludes archived by default)."""
    filters = [
        Transaction.id == transaction_id,
        Account.user_id == current_user.id,
    ]
    if only_active:
        filters.append(Transaction.is_deleted.isnot(True))
    result = await db.execute(
        select(Transaction)
        .join(Account)
        .where(and_(*filters))
        .options(selectinload(Transaction.account))
    )
    txn = result.scalar_one_or_none()
    if not txn:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    return txn


async def get_user_archived_transaction(
    transaction_id: int,
    current_user: User,
    db: AsyncSession,
) -> Transaction:
    """Fetch a soft-deleted transaction owned by the user."""
    result = await db.execute(
        select(Transaction)
        .join(Account)
        .where(
            Transaction.id == transaction_id,
            Account.user_id == current_user.id,
            Transaction.is_deleted.is_(True),
        )
        .options(selectinload(Transaction.account))
    )
    txn = result.scalar_one_or_none()
    if not txn:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Archived transaction not found.",
        )
    return txn


def _to_archived_response(t: Transaction) -> ArchivedTransactionResponse:
    return ArchivedTransactionResponse(
        id=t.id,
        account_id=t.account_id,
        account_name=t.account.name,
        date=t.date,
        description=t.description,
        amount=t.amount,
        currency=t.currency,
        category=t.category,
        deleted_at=t.deleted_at,
        is_recurring=bool(t.is_recurring),
        periodicity=t.periodicity,
    )


# ── Routes (specific paths before `/{id}`) ────────────────────

@router.get("/archived", response_model=List[ArchivedTransactionResponse])
async def list_archived_transactions(
    account_id: Optional[int] = Query(None),
    is_recurring: Optional[bool] = Query(
        None, description="If true, only recurring; if false, only non-recurring"
    ),
    periodicity: Optional[str] = Query(
        None,
        description="monthly|quarterly|halfyearly|yearly — implies is_recurring",
    ),
    limit: int = Query(200, le=500),
    offset: int = Query(0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List soft-deleted (archived) transactions for recovery."""
    filters = [
        Account.user_id == current_user.id,
        Transaction.is_deleted.is_(True),
    ]
    if account_id is not None:
        filters.append(Transaction.account_id == account_id)
    _apply_recurrence_list_filters(
        filters, is_recurring=is_recurring, periodicity=periodicity
    )

    result = await db.execute(
        select(Transaction)
        .join(Account)
        .where(and_(*filters))
        .options(selectinload(Transaction.account))
        .order_by(desc(Transaction.deleted_at), desc(Transaction.date))
        .limit(limit)
        .offset(offset)
    )
    rows = result.scalars().all()
    return [_to_archived_response(t) for t in rows]


@router.post("/{transaction_id}/restore", response_model=TransactionResponse)
async def restore_transaction(
    transaction_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Restore a soft-deleted transaction to the main ledger."""
    txn = await get_user_archived_transaction(transaction_id, current_user, db)
    txn.is_deleted = False
    txn.deleted_at = None
    await db.flush()
    await db.refresh(txn)
    await record_activity(
        db,
        user_id=current_user.id,
        action="transaction_restore",
        method="single",
        affected_rows=1,
        detail={"transaction_id": transaction_id, "account_id": txn.account_id},
    )
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
        periodicity=txn.periodicity,
        created_at=txn.created_at,
    )


@router.delete("/archived/{transaction_id}", status_code=status.HTTP_204_NO_CONTENT)
async def purge_archived_transaction(
    transaction_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Permanently remove an archived transaction (hard delete)."""
    txn = await get_user_archived_transaction(transaction_id, current_user, db)
    aid = txn.account_id
    await db.delete(txn)
    await record_activity(
        db,
        user_id=current_user.id,
        action="transaction_purge_archived",
        method="single",
        affected_rows=1,
        detail={"transaction_id": transaction_id, "account_id": aid},
    )


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
    is_recurring: Optional[bool] = Query(
        None, description="If true, only recurring; if false, only non-recurring"
    ),
    periodicity: Optional[str] = Query(
        None,
        description="monthly|quarterly|halfyearly|yearly — recurring with this rhythm",
    ),
    limit: int = Query(100, le=1000),
    offset: int = Query(0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List transactions for the current user with optional filters."""
    # Filter out soft-deleted transactions (is_deleted is False or NULL)
    # SQLite stores booleans as 0/1, so we check for both False and None/NULL
    filters = [
        Account.user_id == current_user.id,
        Transaction.is_deleted.isnot(True)  # Filters out True (1), keeps False (0) and NULL
    ]

    if start:
        filters.append(Transaction.date >= _utc_start_of_day(start))
    if end:
        filters.append(Transaction.date <= _utc_end_of_day(end))
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
    _apply_recurrence_list_filters(
        filters, is_recurring=is_recurring, periodicity=periodicity
    )

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
            periodicity=t.periodicity,
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
        is_recurring=payload.is_recurring,
        periodicity=payload.periodicity,
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
        periodicity=txn.periodicity,
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
        periodicity=txn.periodicity,
        created_at=txn.created_at,
    )


@router.delete("/{transaction_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_transaction(
    transaction_id: int,
    hard: bool = Query(
        False,
        description="Permanent remove from DB. Default false = soft archive (hidden from main views).",
    ),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Remove a transaction. Default: soft-delete (archive). Use ?hard=true only for irreversible purge.
    All paths are audited (activity_log). SQLAlchemy ORM — no string concatenation.
    """
    txn = await get_user_transaction(transaction_id, current_user, db, only_active=True)
    if hard:
        await db.delete(txn)
        await record_activity(
            db,
            user_id=current_user.id,
            action="transaction_hard_delete",
            method="single",
            affected_rows=1,
            detail={"transaction_id": transaction_id, "account_id": txn.account_id},
        )
    else:
        txn.is_deleted = True
        txn.deleted_at = datetime.now(timezone.utc)
        await record_activity(
            db,
            user_id=current_user.id,
            action="transaction_soft_delete",
            method="single",
            affected_rows=1,
            detail={"transaction_id": transaction_id, "account_id": txn.account_id},
        )


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
            Transaction.is_deleted.isnot(True),
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
    filters = [
        Account.user_id == current_user.id,
        Transaction.is_transfer == False,
        Transaction.is_deleted.isnot(True)
    ]
    if start:
        filters.append(Transaction.date >= _utc_start_of_day(start))
    if end:
        filters.append(Transaction.date <= _utc_end_of_day(end))
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
    filters = [
        Account.user_id == current_user.id,
        Transaction.is_transfer == False,
        Transaction.is_deleted.isnot(True)
    ]
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


class MonthlyCategoryItem(BaseModel):
    month: str        # "2025-01"
    category: str
    amount: float     # positive (absolute value of expenses)


@router.get("/monthly-category-breakdown", response_model=List[MonthlyCategoryItem])
async def monthly_category_breakdown(
    months: int = Query(24, ge=1, le=60),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Expense breakdown by category for each of the last N months."""
    from datetime import timedelta
    cutoff = datetime.now(timezone.utc) - timedelta(days=months * 31)

    result = await db.execute(
        select(
            func.extract("year", Transaction.date).label("yr"),
            func.extract("month", Transaction.date).label("mo"),
            Transaction.category,
            func.sum(func.abs(Transaction.amount)).label("amount"),
        )
        .join(Account)
        .where(
            and_(
                Account.user_id == current_user.id,
                Transaction.amount < 0,
                Transaction.is_deleted.isnot(True),
                Transaction.is_transfer.isnot(True),
                Transaction.date >= cutoff,
                Transaction.category.isnot(None),
            )
        )
        .group_by(
            func.extract("year", Transaction.date),
            func.extract("month", Transaction.date),
            Transaction.category,
        )
        .order_by(
            func.extract("year", Transaction.date),
            func.extract("month", Transaction.date),
            desc("amount"),
        )
    )

    return [
        MonthlyCategoryItem(
            month=f"{int(row.yr)}-{int(row.mo):02d}",
            category=row.category,
            amount=float(row.amount),
        )
        for row in result.all()
    ]


@router.get("/budget-analysis", response_model=BudgetAnalysisResponse)
async def budget_analysis(
    start: Optional[date] = Query(None, description="Analysis period start (YYYY-MM-DD)"),
    end: Optional[date] = Query(None, description="Analysis period end (YYYY-MM-DD)"),
    account_id: Optional[int] = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Analyze budget composition with fixed recurring costs vs variable costs.
    Recurring costs are annualized to monthly equivalents based on periodicity.
    """
    # Default to current month if no dates provided
    today = date.today()
    period_start = start or date(today.year, today.month, 1)
    period_end = end or date(today.year, today.month, today.day)

    filters = [
        Account.user_id == current_user.id,
        Transaction.is_transfer == False,
        Transaction.is_deleted.isnot(True)
    ]
    if account_id:
        filters.append(Transaction.account_id == account_id)
    if period_start:
        filters.append(Transaction.date >= _utc_start_of_day(period_start))
    if period_end:
        filters.append(Transaction.date <= _utc_end_of_day(period_end))

    # Get all transactions in the period
    result = await db.execute(
        select(Transaction)
        .join(Account)
        .where(and_(*filters))
        .order_by(desc(Transaction.date))
    )
    transactions = result.scalars().all()

    # Calculate income (positive amounts)
    total_income = sum(
        t.amount for t in transactions if t.amount > 0
    )

    # Separate recurring and non-recurring expenses
    recurring_items: List[RecurringCostItem] = []
    fixed_recurring_total = 0.0
    variable_total = 0.0

    for t in transactions:
        if t.amount >= 0:
            continue  # Skip income

        expense_amount = abs(t.amount)

        if t.is_recurring and t.periodicity:
            # Calculate monthly equivalent
            factor = PERIODICITY_MONTHLY_FACTOR.get(t.periodicity, 1.0)
            monthly_equivalent = expense_amount * factor

            recurring_items.append(
                RecurringCostItem(
                    description=t.description,
                    category=t.category,
                    amount=expense_amount,
                    periodicity=t.periodicity,
                    monthly_equivalent=monthly_equivalent,
                )
            )
            fixed_recurring_total += monthly_equivalent
        else:
            variable_total += expense_amount

    # Calculate budget metrics
    # For a monthly view, variable costs are the actual observed variable expenses
    # In a multi-month view, we average the variable costs
    months_in_period = max(
        1,
        (period_end.year - period_start.year) * 12 + (period_end.month - period_start.month) + 1
    )
    avg_monthly_variable = variable_total / months_in_period

    # Total monthly equivalent costs
    monthly_fixed = fixed_recurring_total
    monthly_variable = avg_monthly_variable

    # Budget limit could be user's configured limit or income-based calculation
    # For now, use 90% of income as suggested budget limit
    monthly_budget_limit = total_income / months_in_period * 0.9 if total_income > 0 else 0

    # Variance = how much room left in budget
    variance = monthly_budget_limit - monthly_fixed - monthly_variable

    return BudgetAnalysisResponse(
        total_monthly_income=total_income / months_in_period,
        fixed_recurring_costs=monthly_fixed,
        variable_costs=monthly_variable,
        monthly_budget_limit=monthly_budget_limit,
        variance=variance,
        recurring_items=recurring_items,
        period_start=period_start,
        period_end=period_end,
    )
