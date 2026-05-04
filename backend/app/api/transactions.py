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
from collections import defaultdict
from datetime import datetime, date, timezone
from typing import List, Optional, Dict, Any
import base64
import json

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_, or_, desc, tuple_
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.models import Transaction, Account, User, Category
from app.services.categorization import CategorizationService
from app.services.audit_log import record_activity
from app.services.currency_service import (
    currency_service,
    normalize_reference_currency,
    convert_with_eur_rates,
)

router = APIRouter()
categorization_service = CategorizationService()


def _utc_start_of_day(d: date) -> datetime:
    """Inclusive lower bound for TIMESTAMPTZ columns (asyncpg rejects naive datetimes)."""
    return datetime.combine(d, datetime.min.time(), tzinfo=timezone.utc)


def _utc_end_of_day(d: date) -> datetime:
    """Inclusive upper bound for TIMESTAMPTZ columns."""
    return datetime.combine(d, datetime.max.time(), tzinfo=timezone.utc)


def _merge_stats_category_totals(rows: list, *, limit: int) -> List[dict]:
    """
    Combine category keys that only differ by case/whitespace (e.g. Krankenkasse vs krankenkasse).
    Keeps the first-seen display string; sums totals. Caller should fetch enough rows before merging.
    """
    merged: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        raw = (getattr(row, "category", None) or "").strip()
        if not raw:
            continue
        key = raw.lower()
        val = abs(float(row.total))
        if key not in merged:
            merged[key] = {"category": raw, "total": val}
        else:
            merged[key]["total"] += val
            prev = merged[key]["category"]
            if raw and prev and raw[0].isupper() and not prev[0].isupper():
                merged[key]["category"] = raw
    out = [{"category": m["category"], "total": round(m["total"], 2)} for m in merged.values()]
    out.sort(key=lambda x: -x["total"])
    return out[:limit]


def _merge_stats_top_categories(rows: list) -> List[dict]:
    return _merge_stats_category_totals(rows, limit=10)


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
    account_currency: str
    amount_reference: float
    reference_currency: str
    category: Optional[str]
    subcategory: Optional[str]
    confidence_score: Optional[float]
    user_verified: bool
    notes: Optional[str]
    is_transfer: bool
    is_recurring: bool
    periodicity: Optional[str] = None
    created_at: datetime
    # Split fields
    parent_id: Optional[int] = None
    is_split: bool = False
    split_count: int = 0  # number of children (only set on parent rows)

    class Config:
        from_attributes = True


class SplitEntry(BaseModel):
    description: str
    amount: float
    category: Optional[str] = None
    notes: Optional[str] = None


class SplitRequest(BaseModel):
    splits: List[SplitEntry]


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
    top_income_categories: List[dict]
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
    reference_currency: str


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

def _transaction_to_response(txn: Transaction, user: User, rates: Dict[str, float]) -> TransactionResponse:
    ref = normalize_reference_currency(user.currency)
    acct = txn.account
    acct_cur = (acct.currency if acct else txn.currency or "CHF").strip().upper()
    txn_cur = (txn.currency or acct_cur).strip().upper()
    amt_ref = convert_with_eur_rates(rates, txn.amount, txn_cur, ref)
    return TransactionResponse(
        id=txn.id,
        account_id=txn.account_id,
        account_name=acct.name if acct else "",
        date=txn.date,
        booking_date=txn.booking_date,
        description=txn.description,
        merchant_normalized=txn.merchant_normalized,
        amount=txn.amount,
        currency=txn_cur,
        account_currency=acct_cur,
        amount_reference=amt_ref,
        reference_currency=ref,
        category=txn.category,
        subcategory=txn.subcategory,
        confidence_score=txn.confidence_score,
        user_verified=txn.user_verified,
        notes=txn.notes,
        is_transfer=txn.is_transfer,
        is_recurring=txn.is_recurring,
        periodicity=txn.periodicity,
        created_at=txn.created_at,
        parent_id=txn.parent_id,
        is_split=txn.is_split,
        split_count=len(txn.split_children) if txn.split_children else 0,
    )


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
    rates = await currency_service.get_rates("EUR")
    return _transaction_to_response(txn, current_user, rates)


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

def _encode_cursor(txn_date: datetime, txn_id: int) -> str:
    """Encode a keyset cursor as a URL-safe base64 string."""
    payload = json.dumps({"d": txn_date.isoformat(), "i": txn_id})
    return base64.urlsafe_b64encode(payload.encode()).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, int] | None:
    """Decode a cursor string; returns None on any error."""
    try:
        payload = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        return datetime.fromisoformat(payload["d"]), int(payload["i"])
    except Exception:
        return None


@router.get("", response_model=List[TransactionResponse])
async def list_transactions(
    response: Response,
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
    limit: int = Query(100, le=500),
    offset: int = Query(0, description="Legacy offset; ignored when cursor is provided"),
    cursor: Optional[str] = Query(None, description="Opaque keyset cursor from X-Next-Cursor header"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List transactions with cursor-based keyset pagination.

    Pagination flow:
      1. First page: omit cursor; receive results + X-Next-Cursor / X-Total-Count headers.
      2. Next pages: pass cursor=<value from X-Next-Cursor>.
      3. When X-Next-Cursor is absent the last page has been reached.

    Legacy offset pagination is still accepted (pass offset without cursor).
    """
    filters = [
        Account.user_id == current_user.id,
        Transaction.is_deleted.isnot(True),
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
        # PostgreSQL full-text search via ILIKE (fast with pg_trgm index; see migration)
        filters.append(
            or_(
                Transaction.description.ilike(f"%{q}%"),
                Transaction.merchant_normalized.ilike(f"%{q}%"),
                Transaction.notes.ilike(f"%{q}%"),
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

    # ── Total count (for X-Total-Count header) ──────────────────
    count_q = select(func.count()).select_from(Transaction).join(Account).where(and_(*filters))
    total: int = (await db.execute(count_q)).scalar_one()
    response.headers["X-Total-Count"] = str(total)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Next-Cursor"

    # ── Keyset cursor pagination ─────────────────────────────────
    decoded = _decode_cursor(cursor) if cursor else None
    if decoded:
        cursor_date, cursor_id = decoded
        # Rows that come *after* the cursor in (date DESC, id DESC) order:
        # (date < cursor_date) OR (date = cursor_date AND id < cursor_id)
        filters.append(
            or_(
                Transaction.date < cursor_date,
                and_(Transaction.date == cursor_date, Transaction.id < cursor_id),
            )
        )
        page_query = (
            select(Transaction)
            .join(Account)
            .where(and_(*filters))
            .options(selectinload(Transaction.account), selectinload(Transaction.split_children))
            .order_by(desc(Transaction.date), desc(Transaction.id))
            .limit(limit)
        )
    else:
        page_query = (
            select(Transaction)
            .join(Account)
            .where(and_(*filters))
            .options(selectinload(Transaction.account), selectinload(Transaction.split_children))
            .order_by(desc(Transaction.date), desc(Transaction.id))
            .limit(limit)
            .offset(offset)
        )

    result = await db.execute(page_query)
    transactions = result.scalars().all()

    # ── Next-cursor header ───────────────────────────────────────
    if len(transactions) == limit:
        last = transactions[-1]
        response.headers["X-Next-Cursor"] = _encode_cursor(last.date, last.id)

    rates = await currency_service.get_rates("EUR")
    return [_transaction_to_response(t, current_user, rates) for t in transactions]


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
    txn.account = account

    rates = await currency_service.get_rates("EUR")
    return _transaction_to_response(txn, current_user, rates)


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

    rates = await currency_service.get_rates("EUR")
    return _transaction_to_response(txn, current_user, rates)


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

    stmt = (
        select(Transaction.amount, Transaction.category, Account.currency)
        .join(Account)
        .where(and_(*filters))
    )
    raw = (await db.execute(stmt)).all()

    rates = await currency_service.get_rates("EUR")
    ref = normalize_reference_currency(current_user.currency)

    total_income = 0.0
    total_expenses = 0.0
    cat_expense: Dict[str, float] = defaultdict(float)
    cat_income: Dict[str, float] = defaultdict(float)

    for amt, cat, acur in raw:
        cur = (acur or "CHF").strip().upper()
        conv = convert_with_eur_rates(rates, float(amt), cur, ref)
        if conv > 0:
            total_income += conv
            if cat:
                cat_income[str(cat)] += conv
        else:
            total_expenses += conv
            if cat:
                cat_expense[str(cat)] += abs(conv)

    txn_count = len(raw)

    from types import SimpleNamespace

    exp_rows = [SimpleNamespace(category=k, total=-v) for k, v in cat_expense.items()]
    top_categories = _merge_stats_category_totals(exp_rows, limit=10)

    inc_rows = [SimpleNamespace(category=k, total=v) for k, v in cat_income.items()]
    top_income_categories = _merge_stats_category_totals(inc_rows, limit=25)

    avg_monthly = total_expenses / 12 if total_expenses else 0.0

    return StatsResponse(
        total_income=total_income,
        total_expenses=abs(total_expenses),
        net=total_income + total_expenses,
        avg_monthly_expenses=abs(avg_monthly),
        top_categories=top_categories,
        top_income_categories=top_income_categories,
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
    start: Optional[date] = Query(None, description="Start date (inclusive). If omitted, falls back to `months` lookback."),
    end: Optional[date] = Query(None, description="End date (inclusive)."),
    months: int = Query(24, ge=1, le=60, description="Lookback months (used only when start/end not provided)."),
    periodicities: Optional[str] = Query(None, description="Comma-separated filter: monthly,quarterly,halfyearly,yearly,weekly,einmalig. Omit for all."),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Expense breakdown by category for each calendar month in the requested period."""
    from datetime import timedelta

    # ── Date range ────────────────────────────────────────────────
    if start and end:
        date_filter_start = start
        date_filter_end = end
    else:
        cutoff = datetime.now(timezone.utc) - timedelta(days=months * 31)
        date_filter_start = cutoff.date()
        date_filter_end = datetime.now(timezone.utc).date()

    # ── Periodicity / frequency filter ───────────────────────────
    VALID_PERIODICITIES = {"monthly", "quarterly", "halfyearly", "yearly", "weekly"}
    freq_clauses = []
    if periodicities:
        selected = {p.strip().lower() for p in periodicities.split(",") if p.strip()}
        include_einmalig = "einmalig" in selected
        include_recurring = selected & VALID_PERIODICITIES

        if include_einmalig and include_recurring:
            # Both one-time and some recurring
            freq_clauses.append(
                or_(
                    Transaction.is_recurring.isnot(True),  # non-recurring = einmalig
                    Transaction.periodicity.in_(include_recurring),
                )
            )
        elif include_einmalig:
            # Only one-time payments
            freq_clauses.append(Transaction.is_recurring.isnot(True))
        elif include_recurring:
            # Only specific recurring types
            freq_clauses.append(
                and_(
                    Transaction.is_recurring == True,  # noqa: E712
                    Transaction.periodicity.in_(include_recurring),
                )
            )
        else:
            # Nothing matched → return empty
            return []

    base_conditions = [
        Account.user_id == current_user.id,
        Transaction.amount < 0,
        Transaction.is_deleted.isnot(True),
        Transaction.is_transfer.isnot(True),
        Transaction.date >= date_filter_start,
        Transaction.date <= date_filter_end,
        Transaction.category.isnot(None),
        *freq_clauses,
    ]

    result = await db.execute(
        select(
            func.extract("year", Transaction.date).label("yr"),
            func.extract("month", Transaction.date).label("mo"),
            Transaction.category,
            func.sum(func.abs(Transaction.amount)).label("amount"),
        )
        .join(Account)
        .where(and_(*base_conditions))
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

    result = await db.execute(
        select(Transaction)
        .join(Account)
        .where(and_(*filters))
        .options(selectinload(Transaction.account))
        .order_by(desc(Transaction.date))
    )
    transactions = result.scalars().all()

    rates = await currency_service.get_rates("EUR")
    ref = normalize_reference_currency(current_user.currency)

    def _to_ref(t: Transaction) -> float:
        ac = t.account
        acct_cur = (ac.currency if ac else t.currency or "CHF").strip().upper()
        txn_cur = (t.currency or acct_cur).strip().upper()
        return convert_with_eur_rates(rates, t.amount, txn_cur, ref)

    ref_by_txn = [(t, _to_ref(t)) for t in transactions]
    total_income = sum(ra for _, ra in ref_by_txn if ra > 0)

    recurring_items: List[RecurringCostItem] = []
    fixed_recurring_total = 0.0
    variable_total = 0.0

    for t, amt_ref in ref_by_txn:
        if amt_ref >= 0:
            continue

        expense_amount = abs(amt_ref)

        if t.is_recurring and t.periodicity:
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
        reference_currency=ref,
    )


# ── CSV Export ───────────────────────────────────────────────

@router.get("/export/csv")
async def export_transactions_csv(
    start: Optional[date] = Query(None),
    end: Optional[date] = Query(None),
    account_id: Optional[int] = Query(None),
    category: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Export transactions as a CSV file, respecting the same filters as the list endpoint."""
    import csv, io

    filters = [
        Account.user_id == current_user.id,
        Transaction.is_deleted.isnot(True),
    ]
    if account_id:
        filters.append(Transaction.account_id == account_id)
    if start:
        filters.append(Transaction.date >= _utc_start_of_day(start))
    if end:
        filters.append(Transaction.date <= _utc_end_of_day(end))
    if category:
        filters.append(Transaction.category == category)
    if q:
        like = f"%{q}%"
        filters.append(or_(
            Transaction.description.ilike(like),
            Transaction.merchant_normalized.ilike(like),
            Transaction.notes.ilike(like),
            Transaction.category.ilike(like),
        ))

    rows = (await db.execute(
        select(Transaction)
        .join(Account, Transaction.account_id == Account.id)
        .options(selectinload(Transaction.account))
        .where(and_(*filters))
        .order_by(desc(Transaction.date), desc(Transaction.id))
        .limit(10_000)
    )).scalars().all()

    output = io.StringIO()
    writer = csv.writer(output, delimiter=";", quoting=csv.QUOTE_MINIMAL)
    writer.writerow([
        "Datum", "Buchungsdatum", "Beschreibung", "Händler",
        "Konto", "Betrag", "Währung", "Kategorie", "Unterkategorie",
        "Wiederkehrend", "Rhythmus", "Transfer", "Notizen",
    ])
    for t in rows:
        writer.writerow([
            t.date.strftime("%Y-%m-%d") if t.date else "",
            t.booking_date.strftime("%Y-%m-%d") if t.booking_date else "",
            t.description or "",
            t.merchant_normalized or "",
            t.account.name if t.account else "",
            f"{t.amount:.2f}".replace(".", ","),
            t.currency or "",
            t.category or "",
            t.subcategory or "",
            "Ja" if t.is_recurring else "Nein",
            t.periodicity or "",
            "Ja" if t.is_transfer else "Nein",
            t.notes or "",
        ])

    csv_bytes = output.getvalue().encode("utf-8-sig")  # BOM for Excel
    filename = f"transaktionen_{(start or date.today()).strftime('%Y%m%d')}_{(end or date.today()).strftime('%Y%m%d')}.csv"
    return Response(
        content=csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Transaction Splitting ─────────────────────────────────────

@router.post("/{transaction_id}/split", response_model=List[TransactionResponse])
async def split_transaction(
    transaction_id: int,
    payload: SplitRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Split a transaction into multiple child transactions.
    The parent is marked as is_split=True and its amount becomes the sum of splits.
    Children each carry parent_id pointing back to parent.
    """
    if len(payload.splits) < 2:
        raise HTTPException(status_code=400, detail="At least 2 split entries required.")

    # Fetch parent transaction
    result = await db.execute(
        select(Transaction)
        .join(Account, Transaction.account_id == Account.id)
        .options(selectinload(Transaction.account), selectinload(Transaction.split_children))
        .where(
            Transaction.id == transaction_id,
            Account.user_id == current_user.id,
            Transaction.is_deleted.isnot(True),
            Transaction.parent_id.is_(None),  # cannot split a child
        )
    )
    parent = result.scalar_one_or_none()
    if parent is None:
        raise HTTPException(status_code=404, detail="Transaction not found or already a split child.")

    # Validate split amounts sum to parent amount (within 0.01 tolerance)
    total = round(sum(s.amount for s in payload.splits), 10)
    if abs(total - parent.amount) > 0.01:
        raise HTTPException(
            status_code=400,
            detail=f"Split amounts must sum to {parent.amount:.2f} (got {total:.2f}).",
        )

    # If already split, remove old children first
    if parent.is_split:
        await db.execute(
            select(Transaction).where(Transaction.parent_id == parent.id)
        )
        old_children = (await db.execute(
            select(Transaction).where(Transaction.parent_id == parent.id)
        )).scalars().all()
        for child in old_children:
            await db.delete(child)

    # Mark parent as split
    parent.is_split = True

    # Create children
    children: List[Transaction] = []
    for s in payload.splits:
        child = Transaction(
            account_id=parent.account_id,
            date=parent.date,
            booking_date=parent.booking_date,
            description=s.description,
            merchant_normalized=parent.merchant_normalized,
            amount=s.amount,
            currency=parent.currency,
            category=s.category or parent.category,
            subcategory=None,
            notes=s.notes,
            is_transfer=parent.is_transfer,
            is_recurring=False,
            user_verified=parent.user_verified,
            parent_id=parent.id,
            is_split=False,
        )
        db.add(child)
        children.append(child)

    await db.commit()
    await db.refresh(parent)
    for child in children:
        await db.refresh(child)

    rates = await currency_service.get_rates()

    # Return parent + children
    all_txns = [parent] + children
    # Re-fetch with accounts loaded
    ids = [t.id for t in all_txns]
    rows = (await db.execute(
        select(Transaction)
        .options(selectinload(Transaction.account), selectinload(Transaction.split_children))
        .where(Transaction.id.in_(ids))
    )).scalars().all()
    rows.sort(key=lambda t: (0 if t.id == parent.id else 1))
    return [_transaction_to_response(t, current_user, rates) for t in rows]


@router.delete("/{transaction_id}/split", status_code=204)
async def unsplit_transaction(
    transaction_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove all split children and restore parent to non-split state."""
    result = await db.execute(
        select(Transaction)
        .join(Account, Transaction.account_id == Account.id)
        .where(
            Transaction.id == transaction_id,
            Account.user_id == current_user.id,
            Transaction.is_deleted.isnot(True),
        )
    )
    parent = result.scalar_one_or_none()
    if parent is None:
        raise HTTPException(status_code=404, detail="Transaction not found.")
    if not parent.is_split:
        raise HTTPException(status_code=400, detail="Transaction is not split.")

    old_children = (await db.execute(
        select(Transaction).where(Transaction.parent_id == parent.id)
    )).scalars().all()
    for child in old_children:
        await db.delete(child)

    parent.is_split = False
    await db.commit()


@router.get("/{transaction_id}/splits", response_model=List[TransactionResponse])
async def get_split_children(
    transaction_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return split children for a given parent transaction."""
    children = (await db.execute(
        select(Transaction)
        .join(Account, Transaction.account_id == Account.id)
        .options(selectinload(Transaction.account), selectinload(Transaction.split_children))
        .where(
            Transaction.parent_id == transaction_id,
            Account.user_id == current_user.id,
            Transaction.is_deleted.isnot(True),
        )
    )).scalars().all()
    rates = await currency_service.get_rates()
    return [_transaction_to_response(c, current_user, rates) for c in children]
