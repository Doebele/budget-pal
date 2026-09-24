"""
Backup API — full JSON export and selective import of all user data.

Routes:
  GET  /api/backup/export           → download complete JSON backup (ohne API-Keys)
  POST /api/backup/export-secrets   → dasselbe inkl. API-Keys, nur mit Passwort
  POST /api/backup/import           → restore from JSON backup (upsert, no hard deletes)

Seit Version 1.1 enthaelt das Backup auch die Einstellungen — KI-Anbieter
mit Endpunkt und Modell, Sprache, Session-Dauer, SARON-Referenz — nach dem
Vorbild des Einstellungs-Backups in fintools. Die API-Keys kommen nur mit,
wenn ausdruecklich angefordert *und* das Passwort bestaetigt ist: fintools
gibt sie jedem angemeldeten Aufruf, BudgetPal laeuft oeffentlich, und ein
Session-Token liegt im localStorage.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.rate_limit import SlidingWindowRateLimiter
from app.core.security import SESSION_TIMEOUTS, get_current_user, verify_password
from app.models.models import (
    Account,
    Asset,
    Budget,
    Label,
    PensionData,
    RecurringPlan,
    Transaction,
    TransactionLabel,
    User,
    UserWizardConfig,
    WizardCategoryMapping,
)

from app.services import ai_client

logger = logging.getLogger(__name__)
router = APIRouter()

BACKUP_FORMAT = "budgetpal-backup"
BACKUP_VERSION = "1.1"
# 1.0 kannte noch keine Einstellungen — laesst sich aber weiter einspielen
SUPPORTED_VERSIONS = {"1.0", BACKUP_VERSION}
SUPPORTED_UI_LANGUAGES = {"de", "en"}

# Wer das Passwort fuer den Key-Export durchprobiert, wird gebremst wie beim Login
secrets_export_limiter = SlidingWindowRateLimiter(max_requests=5, window_seconds=300)


# ── Serialisation helpers ─────────────────────────────────────


def _ser(obj: Any) -> Any:
    """Recursively convert SQLAlchemy model instances to dicts (handles dates/datetimes)."""
    if isinstance(obj, (datetime,)):
        return obj.isoformat()
    if isinstance(obj, date):
        return obj.isoformat()
    return obj


def _row(model_instance: Any, exclude: tuple = ()) -> Dict[str, Any]:
    """Return column-value dict for a SQLAlchemy model row."""
    result = {}
    for col in model_instance.__table__.columns:
        if col.name in exclude:
            continue
        val = getattr(model_instance, col.name)
        result[col.name] = _ser(val)
    return result


# ── Export ────────────────────────────────────────────────────


async def _build_backup(current_user: User, db: AsyncSession, *, include_secrets: bool) -> JSONResponse:
    """
    Export all user data as a structured JSON backup.
    Excludes: hashed_password, internal IDs that would conflict on import,
    passkeys (an Geraet und Domain gebunden — in einem anderen Konto
    eingespielt, oeffneten sie dieses fuer das alte Geraet).
    API-Keys nur mit include_secrets.
    """
    uid = current_user.id

    # ── User profile ──────────────────────────────────────────
    user_data = {
        "name": current_user.name,
        "email": current_user.email,
        "date_of_birth": _ser(current_user.date_of_birth),
        "retirement_age": current_user.retirement_age,
        "currency": current_user.currency,
        "locale": current_user.locale,
        "taxonomy_hidden_json": current_user.taxonomy_hidden_json,
    }

    # ── Accounts ──────────────────────────────────────────────
    acc_rows = (await db.execute(
        select(Account).where(Account.user_id == uid)
    )).scalars().all()
    accounts = [_row(a, exclude=("user_id",)) for a in acc_rows]

    # ── Transactions (including soft-deleted) ─────────────────
    txn_rows = (await db.execute(
        select(Transaction)
        .join(Account)
        .where(Account.user_id == uid)
    )).scalars().all()
    transactions = [_row(t, exclude=()) for t in txn_rows]

    # ── Labels ────────────────────────────────────────────────
    label_rows = (await db.execute(
        select(Label).where(Label.user_id == uid)
    )).scalars().all()
    labels = [_row(lb, exclude=("user_id",)) for lb in label_rows]

    # ── Transaction-Label links ───────────────────────────────
    txn_ids = {t.id for t in txn_rows}
    tl_rows = (await db.execute(
        select(TransactionLabel).where(
            TransactionLabel.transaction_id.in_(txn_ids)
        )
    )).scalars().all() if txn_ids else []
    txn_labels = [{"transaction_id": tl.transaction_id, "label_id": tl.label_id} for tl in tl_rows]

    # ── Budgets ───────────────────────────────────────────────
    budget_rows = (await db.execute(
        select(Budget).where(Budget.user_id == uid)
    )).scalars().all()
    budgets = [_row(b, exclude=("user_id",)) for b in budget_rows]

    # ── Recurring plan ────────────────────────────────────────
    rp_rows = (await db.execute(
        select(RecurringPlan).where(RecurringPlan.user_id == uid)
    )).scalars().all()
    recurring_plan = [_row(r, exclude=("user_id",)) for r in rp_rows]

    # ── Wizard config ─────────────────────────────────────────
    wc = (await db.execute(
        select(UserWizardConfig).where(UserWizardConfig.user_id == uid)
    )).scalar_one_or_none()
    wizard_config = _row(wc, exclude=("user_id", "id")) if wc else None

    # ── Wizard category mappings ──────────────────────────────
    wcm_rows = (await db.execute(
        select(WizardCategoryMapping).where(WizardCategoryMapping.user_id == uid)
    )).scalars().all()
    wizard_mappings = [
        {"wizard_label": m.wizard_label, "transaction_category": m.transaction_category}
        for m in wcm_rows
    ]

    # ── Pension data ──────────────────────────────────────────
    pension_rows = (await db.execute(
        select(PensionData).where(PensionData.user_id == uid)
    )).scalars().all()
    pension_data = [_row(p, exclude=("user_id",)) for p in pension_rows]

    # ── Assets ────────────────────────────────────────────────
    asset_rows = (await db.execute(
        select(Asset).where(Asset.user_id == uid)
    )).scalars().all()
    assets = [_row(a, exclude=("user_id",)) for a in asset_rows]

    # ── Einstellungen ─────────────────────────────────────────
    settings_data = {
        "ui_language": current_user.ui_language,
        "session_timeout": current_user.session_timeout,
        "saron_reference_annual_pct": current_user.saron_reference_annual_pct,
        "ai": ai_client.export_config(
            ai_client.from_user(current_user), include_keys=include_secrets
        ),
    }

    payload = {
        "format": BACKUP_FORMAT,
        "version": BACKUP_VERSION,
        "exported_at": datetime.utcnow().isoformat() + "Z",
        # Steht oben in der Datei, damit man ihr ansieht, wie sie zu behandeln ist
        "contains_secrets": include_secrets,
        "user": user_data,
        "settings": settings_data,
        "accounts": accounts,
        "transactions": transactions,
        "labels": labels,
        "transaction_labels": txn_labels,
        "budgets": budgets,
        "recurring_plan": recurring_plan,
        "wizard_config": wizard_config,
        "wizard_mappings": wizard_mappings,
        "pension_data": pension_data,
        "assets": assets,
    }

    # Return as downloadable JSON
    suffix = "_mit_keys" if include_secrets else ""
    filename = f"budgetpal_backup_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}{suffix}.json"
    return JSONResponse(
        content=payload,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            # Keine Zwischenspeicherung — erst recht nicht mit Keys darin
            "Cache-Control": "no-store",
        },
    )


@router.get("/export")
async def export_backup(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Vollstaendiges Backup ohne API-Keys."""
    return await _build_backup(current_user, db, include_secrets=False)


class SecretsExportRequest(BaseModel):
    password: str


@router.post("/export-secrets")
async def export_backup_with_secrets(
    payload: SecretsExportRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Backup inkl. API-Keys im Klartext — nur nach Passwortbestaetigung.

    Ein Session-Token allein genuegt hier nicht: es liegt im localStorage und
    ist damit einem Skript auf der Seite zugaenglich. Das Passwort steht im
    Body, nicht in der URL, damit es in keinem Zugriffslog landet.
    """
    client_ip = request.client.host if request.client else "unknown"
    limit_key = f"{client_ip}:{current_user.id}"
    decision = secrets_export_limiter.check(limit_key)
    if not decision.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Zu viele Versuche. Bitte in {decision.retry_after_seconds}s erneut.",
        )
    # 403, nicht 401: ein 401 meldet das Frontend automatisch ab
    if not verify_password(payload.password, current_user.hashed_password):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Passwort falsch.")
    secrets_export_limiter.reset(limit_key)
    logger.info("Backup mit API-Keys exportiert (user_id=%s)", current_user.id)
    return await _build_backup(current_user, db, include_secrets=True)


# ── Import ────────────────────────────────────────────────────


class BackupImportRequest(BaseModel):
    backup: Dict[str, Any]
    overwrite_profile: bool = False
    import_transactions: bool = True
    import_recurring_plan: bool = True
    import_wizard_config: bool = True
    import_pension_assets: bool = True
    # Ueberschreibt Sprache, Session-Dauer und KI-Anbieter — darum nicht vorbelegt
    import_settings: bool = False


class BackupImportResult(BaseModel):
    accounts_created: int = 0
    transactions_created: int = 0
    transactions_skipped: int = 0
    labels_created: int = 0
    budgets_created: int = 0
    recurring_plan_created: int = 0
    recurring_plan_skipped: int = 0
    wizard_config_restored: bool = False
    pension_created: int = 0
    assets_created: int = 0
    settings_restored: bool = False
    api_keys_restored: int = 0
    warnings: List[str] = []


@router.post("/import", response_model=BackupImportResult)
async def import_backup(
    payload: BackupImportRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Restore data from a JSON backup.
    Uses upsert logic — existing records (matched by import_hash / description+amount)
    are skipped rather than overwritten to avoid data loss.
    """
    backup = payload.backup
    result = BackupImportResult()
    uid = current_user.id

    if backup.get("version") not in SUPPORTED_VERSIONS:
        result.warnings.append(
            f"Backup version '{backup.get('version')}' differs from expected '{BACKUP_VERSION}'. "
            "Proceeding anyway."
        )

    # ── Einstellungen (optional) ──────────────────────────────
    # Die Datei ist Nutzereingabe: jeder Wert wird gegen die erlaubten
    # geprueft, Unbekanntes uebersprungen statt uebernommen.
    if payload.import_settings:
        settings_in = backup.get("settings")
        if not isinstance(settings_in, dict):
            result.warnings.append("Backup enthält keine Einstellungen (vor Version 1.1 erstellt).")
        else:
            lang = settings_in.get("ui_language")
            if lang in SUPPORTED_UI_LANGUAGES:
                current_user.ui_language = lang
            timeout = settings_in.get("session_timeout")
            if timeout in SESSION_TIMEOUTS:
                current_user.session_timeout = timeout
            saron = settings_in.get("saron_reference_annual_pct")
            if isinstance(saron, (int, float)) and -5 <= saron <= 20:
                current_user.saron_reference_annual_pct = float(saron)
            if "ai" in settings_in:
                cfg, keys, ai_warnings = ai_client.import_config(
                    ai_client.from_user(current_user), settings_in["ai"]
                )
                # Neue Zuweisung, sonst erkennt SQLAlchemy die Aenderung nicht
                current_user.ai_config_json = cfg.model_dump()
                result.api_keys_restored = keys
                result.warnings.extend(ai_warnings)
            result.settings_restored = True

    # ── User profile (optional) ───────────────────────────────
    if payload.overwrite_profile and "user" in backup:
        u = backup["user"]
        if u.get("name"):
            current_user.name = u["name"]
        if u.get("currency"):
            current_user.currency = u["currency"]
        if u.get("locale"):
            current_user.locale = u["locale"]
        if u.get("retirement_age"):
            current_user.retirement_age = u["retirement_age"]
        if u.get("date_of_birth"):
            try:
                current_user.date_of_birth = datetime.fromisoformat(u["date_of_birth"])
            except Exception:
                pass
        if "taxonomy_hidden_json" in u:
            current_user.taxonomy_hidden_json = u["taxonomy_hidden_json"]

    # ── Accounts (upsert by name) ─────────────────────────────
    existing_accounts = (await db.execute(
        select(Account).where(Account.user_id == uid)
    )).scalars().all()
    acc_by_name: Dict[str, Account] = {a.name: a for a in existing_accounts}
    acc_id_map: Dict[int, int] = {}  # old_id → new_id

    for acc_data in backup.get("accounts", []):
        old_id = acc_data.get("id")
        name = acc_data.get("name", "")
        if name in acc_by_name:
            acc_id_map[old_id] = acc_by_name[name].id
            continue
        new_acc = Account(
            user_id=uid,
            name=name,
            bank=acc_data.get("bank", ""),
            account_number=acc_data.get("account_number"),
            iban=acc_data.get("iban"),
            currency=acc_data.get("currency", "CHF"),
            balance=acc_data.get("balance", 0.0),
            account_type=acc_data.get("account_type", "checking"),
            is_active=acc_data.get("is_active", True),
            color=acc_data.get("color"),
            notes=acc_data.get("notes"),
        )
        db.add(new_acc)
        await db.flush()
        acc_id_map[old_id] = new_acc.id
        acc_by_name[name] = new_acc
        result.accounts_created += 1

    # ── Transactions ───────────────────────────────────────────
    if payload.import_transactions:
        existing_hashes = set()
        if acc_id_map:
            hash_rows = (await db.execute(
                select(Transaction.import_hash)
                .join(Account)
                .where(
                    and_(
                        Account.user_id == uid,
                        Transaction.import_hash.isnot(None),
                    )
                )
            )).scalars().all()
            existing_hashes = {h for h in hash_rows if h}

        label_id_map: Dict[int, int] = {}

        for txn_data in backup.get("transactions", []):
            old_acc_id = txn_data.get("account_id")
            new_acc_id = acc_id_map.get(old_acc_id)
            if not new_acc_id:
                result.transactions_skipped += 1
                continue

            imp_hash = txn_data.get("import_hash")
            if imp_hash and imp_hash in existing_hashes:
                result.transactions_skipped += 1
                continue

            try:
                date_val = datetime.fromisoformat(txn_data["date"])
            except Exception:
                result.transactions_skipped += 1
                continue

            old_txn_id = txn_data.get("id")
            new_txn = Transaction(
                account_id=new_acc_id,
                date=date_val,
                booking_date=_parse_dt(txn_data.get("booking_date")),
                description=txn_data.get("description", ""),
                merchant_normalized=txn_data.get("merchant_normalized"),
                amount=txn_data.get("amount", 0.0),
                currency=txn_data.get("currency", "CHF"),
                original_amount=txn_data.get("original_amount"),
                original_currency=txn_data.get("original_currency"),
                exchange_rate=txn_data.get("exchange_rate"),
                category=txn_data.get("category"),
                subcategory=txn_data.get("subcategory"),
                confidence_score=txn_data.get("confidence_score"),
                user_verified=txn_data.get("user_verified", False),
                import_hash=imp_hash,
                notes=txn_data.get("notes"),
                is_transfer=txn_data.get("is_transfer", False),
                is_recurring=txn_data.get("is_recurring", False),
                periodicity=txn_data.get("periodicity"),
                is_deleted=txn_data.get("is_deleted", False),
            )
            db.add(new_txn)
            await db.flush()
            if imp_hash:
                existing_hashes.add(imp_hash)
            if old_txn_id:
                label_id_map[old_txn_id] = new_txn.id
            result.transactions_created += 1

        # ── Labels ─────────────────────────────────────────────
        existing_labels = (await db.execute(
            select(Label).where(Label.user_id == uid)
        )).scalars().all()
        label_name_map: Dict[str, Label] = {lb.name: lb for lb in existing_labels}
        old_label_id_to_new: Dict[int, int] = {}

        for lb_data in backup.get("labels", []):
            old_lid = lb_data.get("id")
            lname = lb_data.get("name", "")
            if lname in label_name_map:
                old_label_id_to_new[old_lid] = label_name_map[lname].id
                continue
            new_lb = Label(user_id=uid, name=lname, color=lb_data.get("color"))
            db.add(new_lb)
            await db.flush()
            old_label_id_to_new[old_lid] = new_lb.id
            label_name_map[lname] = new_lb
            result.labels_created += 1

        # Transaction-label links
        for tl in backup.get("transaction_labels", []):
            new_tid = label_id_map.get(tl.get("transaction_id"))
            new_lid = old_label_id_to_new.get(tl.get("label_id"))
            if new_tid and new_lid:
                db.add(TransactionLabel(transaction_id=new_tid, label_id=new_lid))

    # ── Recurring plan ─────────────────────────────────────────
    if payload.import_recurring_plan:
        existing_rp = (await db.execute(
            select(RecurringPlan).where(RecurringPlan.user_id == uid)
        )).scalars().all()
        rp_keys = {(r.description, r.periodicity, str(r.start_date)) for r in existing_rp}

        for rp_data in backup.get("recurring_plan", []):
            key = (
                rp_data.get("description", ""),
                rp_data.get("periodicity", "monthly"),
                str(rp_data.get("start_date", "")),
            )
            if key in rp_keys:
                result.recurring_plan_skipped += 1
                continue
            try:
                start_d = date.fromisoformat(rp_data["start_date"])
            except Exception:
                result.recurring_plan_skipped += 1
                continue
            end_d = None
            if rp_data.get("end_date"):
                try:
                    end_d = date.fromisoformat(rp_data["end_date"])
                except Exception:
                    pass
            new_rp = RecurringPlan(
                user_id=uid,
                description=rp_data.get("description", ""),
                amount=rp_data.get("amount", 0.0),
                periodicity=rp_data.get("periodicity", "monthly"),
                start_date=start_d,
                end_date=end_d,
                is_future=rp_data.get("is_future", True),
                notes=rp_data.get("notes"),
            )
            db.add(new_rp)
            rp_keys.add(key)
            result.recurring_plan_created += 1

    # ── Wizard config ─────────────────────────────────────────
    if payload.import_wizard_config and backup.get("wizard_config"):
        wc_data = backup["wizard_config"]
        existing_wc = (await db.execute(
            select(UserWizardConfig).where(UserWizardConfig.user_id == uid)
        )).scalar_one_or_none()
        if existing_wc is None:
            existing_wc = UserWizardConfig(user_id=uid)
            db.add(existing_wc)

        for field in (
            "fiscal_year_type", "monthly_income_target", "fixed_monthly_expenses",
            "target_savings_percentage", "retirement_age_target", "current_age",
            "peer_group_comparison_enabled", "category_weights",
            "peer_group_defaults_json", "wizard_data_json",
        ):
            if field in wc_data:
                setattr(existing_wc, field, wc_data[field])
        result.wizard_config_restored = True

        # Wizard category mappings
        for m in backup.get("wizard_mappings", []):
            lbl = m.get("wizard_label", "").lower()
            cat = m.get("transaction_category", "")
            if not lbl or not cat:
                continue
            existing_m = (await db.execute(
                select(WizardCategoryMapping).where(
                    and_(
                        WizardCategoryMapping.user_id == uid,
                        WizardCategoryMapping.wizard_label == lbl,
                    )
                )
            )).scalar_one_or_none()
            if existing_m is None:
                db.add(WizardCategoryMapping(
                    user_id=uid, wizard_label=lbl, transaction_category=cat
                ))
            else:
                existing_m.transaction_category = cat

    # ── Pension data ───────────────────────────────────────────
    if payload.import_pension_assets:
        for p_data in backup.get("pension_data", []):
            pillar = p_data.get("pillar")
            if not pillar:
                continue
            existing_p = (await db.execute(
                select(PensionData).where(
                    and_(PensionData.user_id == uid, PensionData.pillar == pillar)
                )
            )).scalar_one_or_none()
            if existing_p is not None:
                continue  # keep existing
            db.add(PensionData(
                user_id=uid,
                pillar=pillar,
                provider=p_data.get("provider"),
                current_balance=p_data.get("current_balance", 0.0),
                annual_contribution=p_data.get("annual_contribution", 0.0),
                expected_return_rate=p_data.get("expected_return_rate", 0.01),
                retirement_age=p_data.get("retirement_age", 65),
                contribution_years=p_data.get("contribution_years"),
                average_insured_salary=p_data.get("average_insured_salary"),
                notes=p_data.get("notes"),
            ))
            result.pension_created += 1

        # ── Assets ─────────────────────────────────────────────
        for a_data in backup.get("assets", []):
            aname = a_data.get("name", "")
            atype = a_data.get("asset_type", "other")
            existing_a = (await db.execute(
                select(Asset).where(
                    and_(
                        Asset.user_id == uid,
                        Asset.name == aname,
                        Asset.asset_type == atype,
                    )
                )
            )).scalar_one_or_none()
            if existing_a is not None:
                continue
            db.add(Asset(
                user_id=uid,
                asset_type=atype,
                name=aname,
                current_value=a_data.get("current_value", 0.0),
                currency=a_data.get("currency", "CHF"),
                notes=a_data.get("notes"),
                metadata_json=a_data.get("metadata_json"),
            ))
            result.assets_created += 1

    await db.commit()
    return result


def _parse_dt(val: Optional[str]) -> Optional[datetime]:
    if not val:
        return None
    try:
        return datetime.fromisoformat(val)
    except Exception:
        return None
