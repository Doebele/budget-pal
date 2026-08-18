"""
Onboarding — der Weg von der Registrierung zur ersten brauchbaren Zahl.

Zwei Wege stehen zur Wahl: einen Kontoauszug hochladen (dafuer gibt es
`/api/imports` bereits vollstaendig) oder anonyme Beispieldaten laden. Der
zweite Weg braucht kein Vertrauen im Voraus — man sieht erst, was die App
kann, und entscheidet danach, ob man ihr echte Auszuege gibt.

Routes:
  GET    /api/onboarding/status   Was fehlt noch bis zur vollen Auswertung
  POST   /api/onboarding/demo     Beispieldaten anlegen (idempotent)
  DELETE /api/onboarding/demo     Beispieldaten restlos entfernen
"""

from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func as sqlfunc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.models import (
    Account,
    AccountType,
    Category,
    RecurringPlan,
    Transaction,
    User,
    UserWizardConfig,
)
from app.services.audit_log import record_activity
from app.services.demo_data import (
    DEMO_ACCOUNT_MARKER,
    build_demo_transactions,
    demo_closing_balance,
)

router = APIRouter()


class OnboardingStatus(BaseModel):
    """Was der Nutzer schon hat — und was die naechste Auswertung freischaltet."""

    has_accounts: bool
    has_transactions: bool
    transaction_count: int
    has_wizard: bool
    has_plan: bool
    is_demo: bool
    #: 0–100, grob wie weit das Profil traegt.
    completeness_pct: int


class DemoResult(BaseModel):
    account_id: int
    transactions: int
    removed: int = 0


async def _demo_account(db: AsyncSession, user_id: int) -> Optional[Account]:
    result = await db.execute(
        select(Account).where(
            Account.user_id == user_id,
            Account.notes == DEMO_ACCOUNT_MARKER,
        )
    )
    return result.scalars().first()


@router.get("/status", response_model=OnboardingStatus)
async def onboarding_status(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Fortschritt statt Sperre.

    Der Wizard bleibt, steht aber nicht mehr vor dem Dashboard: das Dashboard
    zeigt, was schon geht, und benennt, was der naechste Abschnitt bringt.
    """
    accounts = (await db.execute(
        select(sqlfunc.count(Account.id)).where(Account.user_id == current_user.id)
    )).scalar_one()

    txns = (await db.execute(
        select(sqlfunc.count(Transaction.id))
        .join(Account)
        .where(Account.user_id == current_user.id, Transaction.is_deleted.isnot(True))
    )).scalar_one()

    wizard = (await db.execute(
        select(sqlfunc.count(UserWizardConfig.id)).where(
            UserWizardConfig.user_id == current_user.id
        )
    )).scalar_one()

    plan = (await db.execute(
        select(sqlfunc.count(RecurringPlan.id)).where(
            RecurringPlan.user_id == current_user.id
        )
    )).scalar_one()

    demo = await _demo_account(db, current_user.id)

    steps = [accounts > 0, txns > 0, wizard > 0, plan > 0]
    return OnboardingStatus(
        has_accounts=accounts > 0,
        has_transactions=txns > 0,
        transaction_count=txns,
        has_wizard=wizard > 0,
        has_plan=plan > 0,
        is_demo=demo is not None,
        completeness_pct=round(sum(steps) / len(steps) * 100),
    )


@router.post("/demo", response_model=DemoResult, status_code=status.HTTP_201_CREATED)
async def load_demo_data(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Legt den anonymen Beispieldatensatz an.

    Idempotent: ein zweiter Aufruf legt nichts doppelt an, sondern meldet das
    bestehende Demo-Konto zurueck. Sonst haette ein Doppelklick auf der
    Startseite die Zahlen verdoppelt.
    """
    existing = await _demo_account(db, current_user.id)
    if existing is not None:
        count = (await db.execute(
            select(sqlfunc.count(Transaction.id)).where(
                Transaction.account_id == existing.id,
                Transaction.is_deleted.isnot(True),
            )
        )).scalar_one()
        return DemoResult(account_id=existing.id, transactions=count)

    rows = build_demo_transactions()

    account = Account(
        user_id=current_user.id,
        name="Beispielkonto",
        bank="Demo Bank",
        currency="CHF",
        balance=demo_closing_balance(rows),
        account_type=AccountType.checking,
        # Der Marker macht die Beispieldaten spaeter wiederfindbar.
        notes=DEMO_ACCOUNT_MARKER,
    )
    db.add(account)
    await db.flush()

    # Kategorienamen einmal aufloesen statt je Buchung — bei ~500 Zeilen
    # waeren das sonst 500 Abfragen.
    names = {r["category"] for r in rows}
    cat_rows = (await db.execute(
        select(Category).where(
            or_(Category.user_id == current_user.id, Category.is_system.is_(True)),
            sqlfunc.lower(Category.name).in_({n.lower() for n in names}),
        )
    )).scalars().all()
    by_name: dict[str, int] = {}
    for c in cat_rows:
        key = c.name.strip().lower()
        # Eigene Kategorie schlaegt System-Kategorie.
        if key not in by_name or c.user_id == current_user.id:
            by_name[key] = c.id

    for row in rows:
        db.add(Transaction(
            account_id=account.id,
            date=row["date"],
            description=row["description"],
            merchant_normalized=row["merchant_normalized"],
            amount=row["amount"],
            currency="CHF",
            category=row["category"],
            category_id=by_name.get(row["category"].strip().lower()),
            is_recurring=row["is_recurring"],
            # Beispieldaten sind gesetzt, nicht geraten — aber nicht vom
            # Nutzer bestaetigt: `user_verified` bleibt False, sonst
            # verfaelschen sie Stufe 0 der Kategorisierung.
            confidence_score=1.0,
        ))

    await record_activity(
        db,
        user_id=current_user.id,
        action="demo_data_loaded",
        method="POST /onboarding/demo",
        affected_rows=len(rows),
    )
    await db.commit()
    return DemoResult(account_id=account.id, transactions=len(rows))


@router.delete("/demo", response_model=DemoResult)
async def remove_demo_data(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Entfernt Konto und Buchungen des Beispieldatensatzes vollstaendig.

    Hart geloescht, nicht archiviert: Beispieldaten im Archiv waeren Muell,
    den niemand wiederherstellen will. Echte Konten bleiben unberuehrt — der
    Marker greift nur auf dem Demo-Konto.
    """
    account = await _demo_account(db, current_user.id)
    if account is None:
        raise HTTPException(status_code=404, detail="Keine Beispieldaten vorhanden")

    txns = (await db.execute(
        select(Transaction).where(Transaction.account_id == account.id)
    )).scalars().all()
    for txn in txns:
        await db.delete(txn)
    await db.delete(account)

    await record_activity(
        db,
        user_id=current_user.id,
        action="demo_data_removed",
        method="DELETE /onboarding/demo",
        affected_rows=len(txns),
    )
    await db.commit()
    return DemoResult(account_id=account.id, transactions=0, removed=len(txns))
