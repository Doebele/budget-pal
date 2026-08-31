"""
Recurring Plan API — CRUD for user-managed recurring income/expense entries,
plus prefill from historical transactions or empirical (wizard) data.

Routes:
  GET    /api/recurring-plan/suggest      suggest entries from historical or empirical source
  POST   /api/recurring-plan/prefill      bulk-create suggested entries (with dedup)
  GET    /api/recurring-plan              list entries for the authenticated user
  POST   /api/recurring-plan             create a new entry
  POST   /api/recurring-plan/batch        create/update/delete many in one transaction
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
from app.services.pdf_duplicate_detection import _descriptions_match
from app.services.plan_schedule import applicable_months, occurrences_per_month
from app.services.wizard_derive import (
    health_insurance_monthly,
    mortgage_interest_monthly,
    mortgage_tranches_from_wizard,
)
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
    currency: Optional[str] = None   # explicit currency; None → derive from account or default CHF
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
    currency: Optional[str] = None
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
    # Priority: explicit currency stored on entry → account currency → CHF
    stored_cur = getattr(entry, "currency", None)
    plan_cur = (stored_cur or (acct.currency if acct else None) or "CHF").strip().upper()
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


#: Wie viele verschiedene Monate eines Jahres eine Periodizitaet erwarten laesst.
#: "weekly" fehlt bewusst — woechentlich und monatlich sind an der Monatszahl
#: nicht zu unterscheiden, beide treffen alle zwoelf.
_MONTHS_PER_YEAR = {"monthly": 12, "quarterly": 4, "halfyearly": 2, "yearly": 1}


def _new_plan_row(payload: RecurringPlanCreate, user_id: int) -> RecurringPlan:
    """Baut die ORM-Zeile aus einem Create-Payload — Einzel- und Batch-Weg teilen sie."""
    return RecurringPlan(
        user_id=user_id,
        account_id=payload.account_id,
        category_id=payload.category_id,
        description=payload.description,
        amount=payload.amount,
        periodicity=payload.periodicity,
        start_date=payload.start_date,
        end_date=payload.end_date,
        is_future=payload.is_future,
        notes=payload.notes,
        **({"currency": payload.currency.strip().upper()} if payload.currency else {}),
    )


def _infer_periodicity(distinct_months: int) -> str:
    """Periodizitaet aus der Anzahl Monate mit Buchung — naechstliegende Erwartung.

    Die fruehere Staffelung liess 6 bis 9 Monate durchfallen: sie landeten auf
    "yearly", obwohl eine Zahlung in acht Monaten alles andere als jaehrlich
    ist. Bei Gleichstand gewinnt die haeufigere Periodizitaet.
    """
    return min(
        _MONTHS_PER_YEAR,
        key=lambda p: (abs(_MONTHS_PER_YEAR[p] - distinct_months), -_MONTHS_PER_YEAR[p]),
    )


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
        _expense("Nebenkosten", data.get("nebenkosten") or 0, wizard_hint="nebenkosten")
        _expense(
            "Hypothekarzins",
            mortgage_interest_monthly(mortgage_tranches_from_wizard(data)),
            wizard_hint="hypothekarzins",
        )

    # ── Insurance ─────────────────────────────────────────────
    _expense(
        "Krankenkasse",
        health_insurance_monthly(
            data.get("healthInsurancePerPerson"),
            data.get("healthInsuranceMode"),
            data.get("healthInsurancePremiums"),
        ),
        wizard_hint="krankenkasse",
    )
    zusatz = data.get("zusatzversicherung") or 0
    if zusatz > 0:
        _expense("Zusatzversicherung", zusatz, wizard_hint="zusatzversicherung")
    _expense("Hausrat & Haftpflicht", data.get("hausrat") or 0, wizard_hint="hausrat & haftpflicht")
    if data.get("hasAutoInsurance"):
        # Jahresprämie bleibt hier ein Jahresposten — der Budgetplan kennt "yearly".
        auto_yearly = data.get("autoversicherungPeriod") == "jahr"
        _expense(
            "Autoversicherung",
            data.get("autoversicherung") or 0,
            "yearly" if auto_yearly else "monthly",
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

    # ── Subscriptions & Kommunikation ─────────────────────────
    # SBB passes (stored as boolean flags, not just in selectedSubscriptions)
    if data.get("hasSbbHalbtax"):
        _expense("SBB Halbtax", 19.0, wizard_hint="abonnements")
    if data.get("hasSbbGa"):
        _expense("SBB GA 2. Kl.", 345.0, wizard_hint="abonnements")

    # Serafe (Swiss TV/radio fee — always applicable)
    serafe = data.get("serafe") or 0
    if serafe > 0:
        _expense("Serafe (TV/Radio)", round(float(serafe), 2), wizard_hint="abonnements")

    # Subscriptions — show ALL known subscriptions; wizard-selected ones first.
    # Unknown selected names (not in _SUBSCRIPTION_PRICES) get a distributed fallback price.
    selected_subs: list[str] = data.get("selectedSubscriptions") or []
    selected_set = set(selected_subs)
    subscription_total = data.get("subscriptionTotal") or 0

    def _add_sub(name: str, price: float, selected: bool) -> None:
        wl = name.strip().lower()
        cat = _txn_from_wizard(wl) or _txn_from_wizard("abonnements") or None
        if cat:
            suggestions.append(RecurringPlanSuggestion(
                description=name, amount=-round(price, 2), periodicity="monthly",
                category=cat,
                notes="wizard-selected" if selected else None,
                source="empirical",
            ))
        else:
            suggestions.append(RecurringPlanSuggestion(
                description=name, amount=-round(price, 2), periodicity="monthly",
                notes="wizard-selected" if selected else None,
                source="empirical",
            ))

    # 1. Wizard-selected first (preserves user's own choices at top of list)
    for name in selected_subs:
        price = _SUBSCRIPTION_PRICES.get(name)
        if price is None:
            known_total = sum(_SUBSCRIPTION_PRICES.get(n, 0) for n in selected_subs if _SUBSCRIPTION_PRICES.get(n))
            unknown_count = sum(1 for n in selected_subs if not _SUBSCRIPTION_PRICES.get(n))
            price = (subscription_total - known_total) / unknown_count if unknown_count > 0 and subscription_total > known_total else 0.0
        if price and price > 0:
            _add_sub(name, price, selected=True)

    # 2. All other known subscriptions (not selected by user) — so they can still pick them
    for name, price in _SUBSCRIPTION_PRICES.items():
        if name in selected_set:
            continue  # already added above
        if not price or price <= 0:
            continue
        _add_sub(name, price, selected=False)

    # customExpenseEntries — user-defined one-off or recurring expenses from wizard
    for entry in (data.get("customExpenseEntries") or []):
        desc = entry.get("description") or entry.get("name") or "Sonstige Ausgabe"
        amount = entry.get("amount") or entry.get("monthlyAmount") or 0
        period = entry.get("periodicity") or entry.get("frequency") or "monthly"
        if amount > 0 and period in VALID_PERIODICITIES:
            _expense(str(desc), float(amount), period, wizard_hint=entry.get("category"))

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


# ── Plan-Ist-Abgleich ─────────────────────────────────────────

class ReconciliationEntry(BaseModel):
    """Eine Planzeile in einem konkreten Monat, abgeglichen gegen die Realität."""

    plan_id: int
    description: str
    month: int
    periodicity: str
    expected: float                  # erwarteter Betrag (Vorzeichen wie im Plan)
    actual: Optional[float] = None   # tatsächlich gebuchte Summe
    status: Literal["booked", "deviating", "open", "overdue"]
    matched_transaction_ids: List[int] = []


class ReconciliationResponse(BaseModel):
    year: int
    entries: List[ReconciliationEntry]
    booked_count: int
    open_count: int
    overdue_count: int
    deviating_count: int


#: Ab welcher relativen Abweichung ein Treffer als "abweichend" gilt.
RECONCILE_AMOUNT_TOLERANCE = 0.15


@router.get("/reconciliation", response_model=ReconciliationResponse)
async def reconcile_plan(
    year: int = Query(..., description="Kalenderjahr"),
    month: Optional[int] = Query(None, ge=1, le=12, description="Nur dieser Monat"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Gleicht Planzeilen gegen tatsächlich gebuchte Transaktionen ab.

    Für jede Fälligkeit im Jahr wird eine passende Transaktion gesucht:
    gleiches Vorzeichen, im selben Monat, ähnlicher Buchungstext. Die
    Textähnlichkeit nutzt dieselbe Logik wie die Duplikaterkennung beim
    Import (`normalize_for_match` / `_descriptions_match`) — verschiedene
    Quellen schreiben denselben Empfänger unterschiedlich.

    Status je Fälligkeit:
      booked    — Treffer, Betrag innerhalb der Toleranz
      deviating — Treffer, Betrag ausserhalb der Toleranz
      open      — kein Treffer, Monat liegt noch nicht in der Vergangenheit
      overdue   — kein Treffer, Monat ist vorbei
    """
    plan_result = await db.execute(
        select(RecurringPlan).where(RecurringPlan.user_id == current_user.id)
    )
    plans = list(plan_result.scalars().all())

    txn_result = await db.execute(
        select(Transaction)
        .join(Account)
        .where(
            Account.user_id == current_user.id,
            Transaction.is_deleted.isnot(True),
            Transaction.date >= datetime(year, 1, 1),
            Transaction.date <= datetime(year, 12, 31, 23, 59, 59),
        )
    )
    transactions = list(txn_result.scalars().all())

    # Jede Transaktion darf hoechstens eine Planzeile bedienen.
    used_txn_ids: set[int] = set()
    today = date.today()
    entries: List[ReconciliationEntry] = []

    for plan in plans:
        months = applicable_months(
            plan.periodicity, plan.start_date, plan.end_date, year
        )
        if month is not None:
            months = [m for m in months if m == month]
        per_month = occurrences_per_month(plan.periodicity)

        for m in months:
            expected = plan.amount * per_month
            candidates = [
                t for t in transactions
                if t.id not in used_txn_ids
                and t.date.month == m
                and (t.amount < 0) == (plan.amount < 0)
                and _descriptions_match(plan.description, t.description or "")
            ]
            matched_ids = [t.id for t in candidates]
            for t in candidates:
                used_txn_ids.add(t.id)

            if candidates:
                actual = sum(t.amount for t in candidates)
                deviation = (
                    abs(actual - expected) / abs(expected) if expected else 0.0
                )
                status_value = (
                    "deviating" if deviation > RECONCILE_AMOUNT_TOLERANCE else "booked"
                )
            else:
                actual = None
                month_is_past = (year, m) < (today.year, today.month)
                status_value = "overdue" if month_is_past else "open"

            entries.append(
                ReconciliationEntry(
                    plan_id=plan.id,
                    description=plan.description,
                    month=m,
                    periodicity=plan.periodicity,
                    expected=round(expected, 2),
                    actual=round(actual, 2) if actual is not None else None,
                    status=status_value,
                    matched_transaction_ids=matched_ids,
                )
            )

    def count(value: str) -> int:
        return sum(1 for e in entries if e.status == value)

    return ReconciliationResponse(
        year=year,
        entries=entries,
        booked_count=count("booked"),
        open_count=count("open"),
        overdue_count=count("overdue"),
        deviating_count=count("deviating"),
    )


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
    entry = _new_plan_row(payload, current_user.id)
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


# ── Massenaenderungen ─────────────────────────────────────────

class BatchUpdate(RecurringPlanUpdate):
    id: int


class BatchRequest(BaseModel):
    """Ein Bündel Änderungen, die gemeinsam gelten oder gemeinsam ausbleiben."""

    create: List[RecurringPlanCreate] = Field(default_factory=list, max_length=500)
    update: List[BatchUpdate] = Field(default_factory=list, max_length=500)
    delete: List[int] = Field(default_factory=list, max_length=500)


class BatchResponse(BaseModel):
    created: int
    updated: int
    deleted: int


@router.post("/batch", response_model=BatchResponse)
async def batch_recurring_plan(
    payload: BatchRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Mehrere Aenderungen in genau einer Transaktion.

    "Monat leeren" lief bisher als Schleife aus Einzelaufrufen im Browser:
    pro Eintrag erst die Ersatzzeilen anlegen, dann das Original loeschen.
    Brach die Schleife in der Mitte ab, blieb der Plan halb umgebaut zurueck.
    Hier gilt entweder alles oder nichts.

    Fehlt auch nur eine der angesprochenen Zeilen — oder gehoert sie einem
    anderen Konto — bricht der ganze Aufruf ab, statt den Rest still
    anzuwenden.
    """
    touched = {u.id for u in payload.update} | set(payload.delete)
    owned: dict[int, RecurringPlan] = {}
    if touched:
        result = await db.execute(
            select(RecurringPlan).where(
                RecurringPlan.user_id == current_user.id,
                RecurringPlan.id.in_(touched),
            )
        )
        owned = {row.id: row for row in result.scalars().all()}
        missing = sorted(touched - owned.keys())
        if missing:
            raise HTTPException(
                status_code=404, detail=f"Entries not found: {missing}"
            )

    for item in payload.update:
        entry = owned[item.id]
        for field, value in item.model_dump(exclude_unset=True, exclude={"id"}).items():
            setattr(entry, field, value)
        entry.updated_at = _now()

    for item in payload.create:
        db.add(_new_plan_row(item, current_user.id))

    for entry_id in set(payload.delete):
        await db.delete(owned[entry_id])

    await db.commit()
    return BatchResponse(
        created=len(payload.create),
        updated=len(payload.update),
        deleted=len(set(payload.delete)),
    )


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_recurring_plan(
    entry_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    entry = await _get_own_entry(entry_id, current_user, db)
    await db.delete(entry)
    await db.commit()
