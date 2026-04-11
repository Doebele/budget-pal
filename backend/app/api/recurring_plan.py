"""
Recurring Plan API — CRUD for user-managed recurring income/expense entries,
plus prefill from historical transactions or empirical (wizard) data.

Routes:
  GET    /api/recurring-plan/suggest      suggest entries from historical or empirical source
  POST   /api/recurring-plan/prefill      bulk-create suggested entries (with dedup)
  GET    /api/recurring-plan              list entries for the authenticated user
  POST   /api/recurring-plan             create a new entry
  PUT    /api/recurring-plan/{id}        update an entry (own records only)
  DELETE /api/recurring-plan/{id}        delete an entry (own records only)
"""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import case, extract, func as sqlfunc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.taxonomy import default_transaction_category_for_wizard_label, load_merged_taxonomy_for_user
from app.models.models import Account, Category, RecurringPlan, Transaction, User, UserWizardConfig
from app.services.currency_service import (
    currency_service,
    normalize_reference_currency,
    convert_with_eur_rates,
)

router = APIRouter()

VALID_PERIODICITIES = {"weekly", "monthly", "quarterly", "halfyearly", "yearly"}

# Subscription price lookup (name → monthly CHF)
_SUBSCRIPTION_PRICES: dict[str, float] = {
    "Netflix": 18,
    "Spotify": 13,
    "Disney+": 12,
    "NZZ Digital": 39,
    "Blick+": 13,
    "SRF Play (optional)": 0,
    "iCloud 200GB": 3,
    "Google One": 3,
    "Microsoft 365": 12,
    "Migros Cumulus Extra": 8,
    "ADSL/Fiber (Swisscom)": 59,
    "Mobile Abo (Sunrise)": 39,
    "SBB Halbtax": 19,
    "SBB GA 2. Kl.": 345,
    "Fitnesscenter": 80,
    "Adobe Creative Cloud": 56,
    "LinkedIn Premium": 45,
    "Dropbox Plus": 12,
    "Amazon Prime": 9,
    "YouTube Premium": 14,
}


# ── Pydantic schemas ───────────────────────────────────────────

class RecurringPlanCreate(BaseModel):
    description: str = Field(..., min_length=1, max_length=255)
    amount: float  # positive = income, negative = expense
    periodicity: str = "monthly"
    start_date: date
    end_date: Optional[date] = None
    account_id: Optional[int] = None
    category_id: Optional[int] = None
    is_future: bool = True
    notes: Optional[str] = None

    @field_validator("periodicity")
    @classmethod
    def validate_periodicity(cls, v: str) -> str:
        if v not in VALID_PERIODICITIES:
            raise ValueError(f"periodicity must be one of {sorted(VALID_PERIODICITIES)}")
        return v

    @field_validator("end_date")
    @classmethod
    def end_after_start(cls, v: Optional[date], info: object) -> Optional[date]:
        data = getattr(info, "data", {})
        start = data.get("start_date")
        if v and start and v < start:
            raise ValueError("end_date must be on or after start_date")
        return v


class RecurringPlanUpdate(BaseModel):
    description: Optional[str] = Field(None, min_length=1, max_length=255)
    amount: Optional[float] = None
    periodicity: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    account_id: Optional[int] = None
    category_id: Optional[int] = None
    is_future: Optional[bool] = None
    notes: Optional[str] = None

    @field_validator("periodicity")
    @classmethod
    def validate_periodicity(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in VALID_PERIODICITIES:
            raise ValueError(f"periodicity must be one of {sorted(VALID_PERIODICITIES)}")
        return v


class RecurringPlanResponse(BaseModel):
    id: int
    user_id: int
    account_id: Optional[int]
    category_id: Optional[int]
    description: str
    amount: float
    periodicity: str
    start_date: date
    end_date: Optional[date]
    is_future: bool
    notes: Optional[str]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]
    plan_currency: str = "CHF"
    amount_reference: float = 0.0
    reference_currency: str = "CHF"

    model_config = {"from_attributes": True}


class RecurringPlanSuggestion(BaseModel):
    description: str
    amount: float           # positive = income, negative = expense
    periodicity: str
    category: Optional[str] = None
    notes: Optional[str] = None
    source: str             # "historical" | "empirical"


class PrefillRequest(BaseModel):
    source: Literal["historical", "empirical"]
    year: int               # source year to draw data from
    target_year: int        # plan year to create entries in
    entries: Optional[List[RecurringPlanSuggestion]] = None
    # If entries is provided (user-selected subset), only those are created.
    # If None, the server re-runs suggest logic and creates all results.


class PrefillResponse(BaseModel):
    created: int
    skipped: int


# ── Helper ─────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def recurring_plan_to_response(entry: RecurringPlan, user: User, rates: dict) -> RecurringPlanResponse:
    ref = normalize_reference_currency(user.currency)
    acct = entry.account
    plan_cur = (acct.currency if acct else "CHF").strip().upper()
    amt_ref = convert_with_eur_rates(rates, float(entry.amount), plan_cur, ref)
    return RecurringPlanResponse(
        id=entry.id,
        user_id=entry.user_id,
        account_id=entry.account_id,
        category_id=entry.category_id,
        description=entry.description,
        amount=entry.amount,
        periodicity=entry.periodicity,
        start_date=entry.start_date,
        end_date=entry.end_date,
        is_future=entry.is_future,
        notes=entry.notes,
        created_at=entry.created_at,
        updated_at=entry.updated_at,
        plan_currency=plan_cur,
        amount_reference=amt_ref,
        reference_currency=ref,
    )


async def _load_recurring_with_account(
    db: AsyncSession, entry_id: int, user_id: int
) -> RecurringPlan:
    r = await db.execute(
        select(RecurringPlan)
        .where(RecurringPlan.id == entry_id, RecurringPlan.user_id == user_id)
        .options(selectinload(RecurringPlan.account))
    )
    return r.scalar_one()


async def _get_own_entry(
    entry_id: int,
    current_user: User,
    db: AsyncSession,
) -> RecurringPlan:
    result = await db.execute(
        select(RecurringPlan).where(
            RecurringPlan.id == entry_id,
            RecurringPlan.user_id == current_user.id,
        )
    )
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")
    return entry


def _infer_periodicity(distinct_months: int) -> str:
    if distinct_months >= 10:
        return "monthly"
    if 3 <= distinct_months <= 5:
        return "quarterly"
    if distinct_months == 2:
        return "halfyearly"
    return "yearly"


# Empirical income lines → canonical txn category name (Super «Sparen» / real user categories)
_EMPIRICAL_INCOME_TXN: dict[str, str] = {
    "lohn (netto)": "Gehalt",
    "selbstständige tätigkeit": "Sonstige Einnahmen",
    "ahv-rente": "Sonstige Einnahmen",
    "dividenden": "Dividende",
    "mieteinnahmen": "Sonstige Einnahmen",
    "auslandeinkommen": "Sonstige Einnahmen",
}


async def _category_id_for_txn_name(
    db: AsyncSession,
    user_id: int,
    txn_name: Optional[str],
) -> Optional[int]:
    """Resolve Category.id for a transaction-style category label (user row preferred over system)."""
    if not txn_name or not str(txn_name).strip():
        return None
    needle = str(txn_name).strip().lower()
    result = await db.execute(
        select(Category).where(
            or_(Category.user_id == user_id, Category.is_system.is_(True)),
            sqlfunc.lower(Category.name) == needle,
        )
    )
    rows = list(result.scalars().all())
    if not rows:
        return None
    for c in rows:
        if c.user_id == user_id:
            return c.id
    return rows[0].id


async def _build_suggestions(
    source: str,
    year: int,
    current_user: User,
    db: AsyncSession,
) -> List[RecurringPlanSuggestion]:
    if source == "historical":
        return await _suggest_historical(year, current_user, db)
    return await _suggest_empirical(current_user, db)


async def _suggest_historical(
    year: int,
    current_user: User,
    db: AsyncSession,
) -> List[RecurringPlanSuggestion]:
    # Group non-deleted, non-transfer transactions from 'year' by normalized
    # description + sign and count how many distinct months they appear in.
    stmt = (
        select(
            sqlfunc.lower(
                sqlfunc.coalesce(Transaction.merchant_normalized, Transaction.description)
            ).label("key"),
            case((Transaction.amount < 0, -1), else_=1).label("sign"),
            Transaction.category,
            sqlfunc.avg(Transaction.amount).label("avg_amount"),
            sqlfunc.count(
                sqlfunc.distinct(extract("month", Transaction.date))
            ).label("distinct_months"),
            sqlfunc.max(
                case((Transaction.is_recurring.is_(True), 1), else_=0)
            ).label("any_recurring"),
        )
        .join(Account, Transaction.account_id == Account.id)
        .where(
            Account.user_id == current_user.id,
            Transaction.is_deleted.isnot(True),
            Transaction.is_transfer.isnot(True),
            extract("year", Transaction.date) == year,
        )
        .group_by("key", "sign", Transaction.category)
        .having(
            or_(
                sqlfunc.count(
                    sqlfunc.distinct(extract("month", Transaction.date))
                ) >= 2,
                sqlfunc.max(
                    case((Transaction.is_recurring.is_(True), 1), else_=0)
                ) == 1,
            )
        )
        .order_by("key")
    )

    rows = (await db.execute(stmt)).all()
    suggestions: List[RecurringPlanSuggestion] = []
    for row in rows:
        periodicity = _infer_periodicity(row.distinct_months)
        description = row.key.replace("-", " ").replace("_", " ").title()
        suggestions.append(
            RecurringPlanSuggestion(
                description=description,
                amount=round(row.avg_amount, 2),
                periodicity=periodicity,
                category=row.category,
                source="historical",
            )
        )
    return suggestions


async def _suggest_empirical(
    current_user: User,
    db: AsyncSession,
) -> List[RecurringPlanSuggestion]:
    cfg_row = await db.execute(
        select(UserWizardConfig).where(UserWizardConfig.user_id == current_user.id)
    )
    cfg = cfg_row.scalar_one_or_none()
    if not cfg or not cfg.wizard_data_json:
        return []

    merged = await load_merged_taxonomy_for_user(db, current_user.id)

    def _txn_from_wizard(wizard_label: str) -> str:
        return default_transaction_category_for_wizard_label(merged, wizard_label)

    data: dict = json.loads(cfg.wizard_data_json)
    suggestions: List[RecurringPlanSuggestion] = []

    def _expense(
        desc: str,
        amount: float,
        periodicity: str = "monthly",
        *,
        wizard_hint: Optional[str] = None,
        category: Optional[str] = None,
    ) -> None:
        if not amount or amount <= 0:
            return
        if category is not None:
            cat = category if category else None
        elif wizard_hint:
            cat = _txn_from_wizard(wizard_hint) or None
        else:
            cat = None
        suggestions.append(
            RecurringPlanSuggestion(
                description=desc,
                amount=-round(amount, 2),
                periodicity=periodicity,
                category=cat,
                source="empirical",
            )
        )

    def _income(
        desc: str,
        amount: float,
        periodicity: str = "monthly",
        *,
        category: str,
    ) -> None:
        if not amount or amount <= 0:
            return
        suggestions.append(
            RecurringPlanSuggestion(
                description=desc,
                amount=round(amount, 2),
                periodicity=periodicity,
                category=category,
                source="empirical",
            )
        )

    # ── Income (nur reale Sparen-Txn-Namen) ───────────────────
    if data.get("lohnEnabled") and data.get("lohn"):
        _income("Lohn (netto)", data["lohn"], category=_EMPIRICAL_INCOME_TXN["lohn (netto)"])
    if data.get("selbstaendigEnabled") and data.get("selbstaendig"):
        _income(
            "Selbstständige Tätigkeit",
            data["selbstaendig"],
            category=_EMPIRICAL_INCOME_TXN["selbstständige tätigkeit"],
        )
    if data.get("ahvRenteEnabled") and data.get("ahvRente"):
        _income("AHV-Rente", data["ahvRente"], category=_EMPIRICAL_INCOME_TXN["ahv-rente"])
    if data.get("dividendenEnabled") and data.get("dividenden"):
        _income("Dividenden", data["dividenden"], category=_EMPIRICAL_INCOME_TXN["dividenden"])
    if data.get("mieteinnahmenEnabled") and data.get("mieteinnahmen"):
        _income(
            "Mieteinnahmen",
            data["mieteinnahmen"],
            category=_EMPIRICAL_INCOME_TXN["mieteinnahmen"],
        )
    if data.get("auslandeinkommenEnabled") and data.get("auslandeinkommen"):
        _income(
            "Auslandeinkommen",
            data["auslandeinkommen"],
            category=_EMPIRICAL_INCOME_TXN["auslandeinkommen"],
        )

    # ── Housing ───────────────────────────────────────────────
    housing_mode = data.get("housingMode", "miete")
    if housing_mode == "miete":
        rent = (data.get("monthlyRent") or 0) + (data.get("nebenkosten") or 0)
        _expense("Miete & Nebenkosten", rent, wizard_hint="miete")
    else:
        _expense(
            "Hypothek Amortisation",
            data.get("monthlyAmortization") or 0,
            wizard_hint="hypothek & amortisation",
        )

    # ── Insurance ─────────────────────────────────────────────
    _expense("Krankenkasse", data.get("healthInsurancePerPerson") or 0, wizard_hint="krankenkasse")
    zusatz = data.get("zusatzversicherung") or 0
    if zusatz > 0:
        _expense("Zusatzversicherung", zusatz, wizard_hint="zusatzversicherung")
    _expense("Hausrat & Haftpflicht", data.get("hausrat") or 0, wizard_hint="hausrat & haftpflicht")
    if data.get("hasAutoInsurance"):
        _expense(
            "Autoversicherung",
            data.get("autoversicherung") or 0,
            wizard_hint="autoversicherung",
        )

    # ── Daily life ────────────────────────────────────────────
    _expense("Lebensmittel", data.get("groceries") or 0, wizard_hint="lebensmittel")
    _expense("Freizeit & Restaurant", data.get("freizeit") or 0, wizard_hint="freizeit & restaurant")
    _expense("Kleidung", data.get("kleidung") or 0, wizard_hint="kleidung")
    _expense(
        "Freizeit & Unterhaltung",
        data.get("unterhaltung") or 0,
        wizard_hint="freizeit & unterhaltung",
    )
    _expense(
        "Weiterbildung & Kurse",
        data.get("weiterbildung") or 0,
        wizard_hint="weiterbildung & kurse",
    )

    # ── Transport ─────────────────────────────────────────────
    transport_mode = data.get("transportMode", "ov")
    if transport_mode in ("car", "both"):
        _expense("Benzin / Strom (Auto)", data.get("monthlyFuel") or 0, wizard_hint="benzin / strom (auto)")
        _expense("Parkplatz", data.get("parking") or 0, wizard_hint="parkplatz")
        _expense(
            "Auto-Amortisation",
            data.get("carAmortization") or 0,
            wizard_hint="auto-amortisation",
        )

    # ── Subscriptions ─────────────────────────────────────────
    selected_subs = data.get("selectedSubscriptions") or []
    for name in selected_subs:
        price = _SUBSCRIPTION_PRICES.get(name, 0)
        if price > 0:
            wl = str(name).strip().lower()
            cat = _txn_from_wizard(wl) or _txn_from_wizard("abonnements") or None
            if cat:
                _expense(name, price, category=cat)
            else:
                _expense(name, price, wizard_hint="abonnements")

    # ── Pillar 3a (Ausgabe; keine Sparen-Txn im Ausgaben-Picker) ──
    pillar3a = data.get("pillar3aAccounts") or []
    total_3a_monthly = 0.0
    for acc in pillar3a:
        annual = acc.get("annualContribution") or acc.get("annual_contribution") or 0
        total_3a_monthly += annual / 12
    if total_3a_monthly > 0:
        _expense("Säule 3a Einzahlung", round(total_3a_monthly, 2), wizard_hint="säule 3a")

    return suggestions


# ── Endpoints ──────────────────────────────────────────────────

@router.get("/suggest", response_model=List[RecurringPlanSuggestion])
async def suggest_prefill(
    source: Literal["historical", "empirical"] = Query(...),
    year: int = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return suggested RecurringPlan entries from historical transactions or wizard data."""
    if year is None:
        from datetime import date as _date
        year = _date.today().year - 1
    return await _build_suggestions(source, year, current_user, db)


@router.post("/prefill", response_model=PrefillResponse)
async def prefill_recurring_plan(
    payload: PrefillRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Bulk-create RecurringPlan entries from a suggested source, with dedup."""
    entries = payload.entries
    if not entries:
        entries = await _build_suggestions(payload.source, payload.year, current_user, db)

    # Build dedup key set from existing entries
    existing_rows = (await db.execute(
        select(RecurringPlan.description, RecurringPlan.periodicity)
        .where(RecurringPlan.user_id == current_user.id)
    )).all()
    existing_keys: set[tuple[str, str]] = {
        (r.description.lower(), r.periodicity) for r in existing_rows
    }

    created = skipped = 0
    for s in entries:
        dedup_key = (s.description.lower(), s.periodicity)
        if dedup_key in existing_keys:
            skipped += 1
            continue
        cat_id = await _category_id_for_txn_name(db, current_user.id, s.category)
        db.add(RecurringPlan(
            user_id=current_user.id,
            description=s.description,
            amount=s.amount,
            periodicity=s.periodicity,
            start_date=date(payload.target_year, 1, 1),
            end_date=date(payload.target_year, 12, 31),
            is_future=True,
            category_id=cat_id,
            notes=f"Vorbefüllt aus {payload.source} ({payload.year})",
        ))
        existing_keys.add(dedup_key)
        created += 1

    await db.commit()
    return PrefillResponse(created=created, skipped=skipped)


@router.get("", response_model=List[RecurringPlanResponse])
async def list_recurring_plan(
    year: Optional[int] = Query(None, description="Filter to entries active in this year"),
    is_future: Optional[bool] = Query(None, description="Filter by is_future flag"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return all recurring plan entries for the authenticated user.

    Year filter: returns entries where start_date.year ≤ year AND
    (end_date IS NULL OR end_date.year ≥ year).
    """
    stmt = select(RecurringPlan).where(RecurringPlan.user_id == current_user.id)

    if year is not None:
        stmt = stmt.where(
            extract("year", RecurringPlan.start_date) <= year,
            or_(
                RecurringPlan.end_date.is_(None),
                extract("year", RecurringPlan.end_date) >= year,
            ),
        )

    if is_future is not None:
        stmt = stmt.where(RecurringPlan.is_future == is_future)

    stmt = (
        stmt.options(selectinload(RecurringPlan.account))
        .order_by(RecurringPlan.start_date, RecurringPlan.description)
    )
    result = await db.execute(stmt)
    entries = result.scalars().all()
    rates = await currency_service.get_rates("EUR")
    return [recurring_plan_to_response(e, current_user, rates) for e in entries]


@router.post("", response_model=RecurringPlanResponse, status_code=status.HTTP_201_CREATED)
async def create_recurring_plan(
    payload: RecurringPlanCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    entry = RecurringPlan(
        user_id=current_user.id,
        account_id=payload.account_id,
        category_id=payload.category_id,
        description=payload.description,
        amount=payload.amount,
        periodicity=payload.periodicity,
        start_date=payload.start_date,
        end_date=payload.end_date,
        is_future=payload.is_future,
        notes=payload.notes,
    )
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    loaded = await _load_recurring_with_account(db, entry.id, current_user.id)
    rates = await currency_service.get_rates("EUR")
    return recurring_plan_to_response(loaded, current_user, rates)


@router.put("/{entry_id}", response_model=RecurringPlanResponse)
async def update_recurring_plan(
    entry_id: int,
    payload: RecurringPlanUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    entry = await _get_own_entry(entry_id, current_user, db)

    update_data = payload.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(entry, field, value)
    entry.updated_at = _now()

    await db.commit()
    loaded = await _load_recurring_with_account(db, entry_id, current_user.id)
    rates = await currency_service.get_rates("EUR")
    return recurring_plan_to_response(loaded, current_user, rates)


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_recurring_plan(
    entry_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    entry = await _get_own_entry(entry_id, current_user, db)
    await db.delete(entry)
    await db.commit()
