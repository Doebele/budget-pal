"""
Import API routes — CSV and PDF bank statement import.

POST /imports/csv         — upload CSV, detect format, parse, categorize
POST /imports/pdf         — upload PDF, OCR, parse, categorize
GET  /imports/history     — list past imports
GET  /imports/{id}/preview — preview a past import result
"""
import hashlib
import io
import os
import tempfile
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from app.core.database import get_db
from app.core.security import get_current_user
from app.core.config import settings
from app.models.models import Transaction, Account, ImportLog, ImportStatus, User
from app.services.categorization import CategorizationService
from app.services.import_parsers.ubs import UBSParser
from app.services.import_parsers.n26 import N26Parser
from app.services.import_parsers.revolut import RevolutParser
from app.services.import_parsers.comdirect import ComdirectParser

router = APIRouter()
categorization_service = CategorizationService()

PARSERS = {
    "ubs": UBSParser(),
    "n26": N26Parser(),
    "revolut": RevolutParser(),
    "comdirect": ComdirectParser(),
}


# ── Schemas ───────────────────────────────────────────────────

class ImportPreviewTransaction(BaseModel):
    date: str
    description: str
    amount: float
    currency: str
    category: Optional[str]
    confidence_score: Optional[float]
    is_duplicate: bool


class ImportResultResponse(BaseModel):
    import_id: int
    bank: str
    rows_imported: int
    rows_skipped: int
    rows_failed: int
    status: str
    preview: List[ImportPreviewTransaction]


class ImportLogResponse(BaseModel):
    id: int
    filename: str
    bank: Optional[str]
    file_type: str
    rows_imported: int
    rows_skipped: int
    status: str
    created_at: datetime
    account_id: Optional[int]


# ── Helper: detect bank format from CSV content ────────────────

def detect_bank_format(content: bytes) -> str:
    """Heuristic detection of bank CSV format from first few lines."""
    # Try to decode with multiple encodings
    for enc in ("utf-8-sig", "latin-1", "cp1252"):
        try:
            text = content[:2000].decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = content[:2000].decode("utf-8", errors="replace")

    header = text.lower()

    if "valuta" in header and "belastung" in header and "gutschrift" in header:
        return "ubs"
    if "payee" in header and "transaction type" in header:
        return "n26"
    if "started date" in header and "completed date" in header and "state" in header:
        return "revolut"
    if "buchungstag" in header and "wertstellung" in header and "vorgang" in header:
        return "comdirect"

    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail="Could not detect bank format. Supported formats: UBS, N26, Revolut, comdirect.",
    )


def compute_import_hash(account_id: int, date: str, amount: float, description: str) -> str:
    """SHA-256 fingerprint for deduplication."""
    raw = f"{account_id}|{date}|{amount:.2f}|{description.strip()}"
    return hashlib.sha256(raw.encode()).hexdigest()


# ── Routes ────────────────────────────────────────────────────

@router.post("/csv", response_model=ImportResultResponse, status_code=status.HTTP_201_CREATED)
async def import_csv(
    file: UploadFile = File(...),
    account_id: int = Form(...),
    bank: Optional[str] = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload a CSV bank export, detect format, parse transactions, and save."""
    # Verify account ownership
    acct_result = await db.execute(
        select(Account).where(Account.id == account_id, Account.user_id == current_user.id)
    )
    account = acct_result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found.")

    content = await file.read()

    # Detect or use provided bank format
    detected_bank = bank or detect_bank_format(content)

    parser = PARSERS.get(detected_bank)
    if not parser:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported bank format: {detected_bank}",
        )

    # Parse raw transactions
    try:
        raw_transactions = parser.parse(content)
    except Exception as e:
        log = ImportLog(
            user_id=current_user.id,
            account_id=account_id,
            filename=file.filename or "unknown.csv",
            bank=detected_bank,
            file_type="csv",
            status=ImportStatus.failed,
            error_message=str(e),
        )
        db.add(log)
        await db.flush()
        raise HTTPException(status_code=422, detail=f"Parse error: {e}")

    # Process transactions
    imported = 0
    skipped = 0
    failed = 0
    preview_items: List[ImportPreviewTransaction] = []

    for raw in raw_transactions:
        try:
            import_hash = compute_import_hash(
                account_id,
                str(raw.get("date", "")),
                float(raw.get("amount", 0)),
                str(raw.get("description", "")),
            )

            # Deduplication check
            dup_result = await db.execute(
                select(Transaction.id).where(
                    Transaction.account_id == account_id,
                    Transaction.import_hash == import_hash,
                )
            )
            is_duplicate = dup_result.scalar_one_or_none() is not None

            if is_duplicate:
                skipped += 1
                if len(preview_items) < 5:
                    preview_items.append(
                        ImportPreviewTransaction(
                            date=str(raw.get("date", "")),
                            description=raw.get("description", ""),
                            amount=float(raw.get("amount", 0)),
                            currency=raw.get("currency", "CHF"),
                            category=None,
                            confidence_score=None,
                            is_duplicate=True,
                        )
                    )
                continue

            # Categorize
            cat_result = await categorization_service.categorize(raw.get("description", ""))

            txn = Transaction(
                account_id=account_id,
                date=raw["date"],
                booking_date=raw.get("booking_date"),
                description=raw["description"],
                amount=float(raw["amount"]),
                currency=raw.get("currency", account.currency),
                original_amount=raw.get("original_amount"),
                original_currency=raw.get("original_currency"),
                category=cat_result["category"],
                subcategory=cat_result.get("subcategory"),
                merchant_normalized=cat_result.get("merchant_normalized"),
                confidence_score=cat_result["confidence_score"],
                import_hash=import_hash,
            )
            db.add(txn)
            imported += 1

            if len(preview_items) < 20:
                preview_items.append(
                    ImportPreviewTransaction(
                        date=str(raw["date"]),
                        description=raw["description"],
                        amount=float(raw["amount"]),
                        currency=raw.get("currency", "CHF"),
                        category=cat_result["category"],
                        confidence_score=cat_result["confidence_score"],
                        is_duplicate=False,
                    )
                )

        except Exception as e:
            failed += 1

    # Save import log
    log = ImportLog(
        user_id=current_user.id,
        account_id=account_id,
        filename=file.filename or "upload.csv",
        bank=detected_bank,
        file_type="csv",
        rows_imported=imported,
        rows_skipped=skipped,
        rows_failed=failed,
        status=ImportStatus.completed,
        preview_json={"preview": [p.model_dump() for p in preview_items]},
    )
    db.add(log)
    await db.flush()
    await db.refresh(log)

    return ImportResultResponse(
        import_id=log.id,
        bank=detected_bank,
        rows_imported=imported,
        rows_skipped=skipped,
        rows_failed=failed,
        status="completed",
        preview=preview_items,
    )


@router.post("/pdf", response_model=ImportResultResponse, status_code=status.HTTP_201_CREATED)
async def import_pdf(
    file: UploadFile = File(...),
    account_id: int = Form(...),
    bank: Optional[str] = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload a PDF bank statement, extract text via OCR, parse, and save."""
    # Verify account ownership
    acct_result = await db.execute(
        select(Account).where(Account.id == account_id, Account.user_id == current_user.id)
    )
    account = acct_result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found.")

    content = await file.read()

    # Save to temp file for pdfplumber
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    raw_transactions = []
    try:
        import pdfplumber

        with pdfplumber.open(tmp_path) as pdf:
            full_text = "\n".join(
                page.extract_text() or "" for page in pdf.pages
            )

        # If pdfplumber extraction is too sparse, fall back to EasyOCR
        if len(full_text.strip()) < 100:
            try:
                import easyocr
                from pdf2image import convert_from_path

                reader = easyocr.Reader(["de", "en"], gpu=False)
                images = convert_from_path(tmp_path, dpi=200)
                full_text = ""
                for img in images:
                    ocr_result = reader.readtext(
                        img,
                        detail=0,
                        paragraph=True,
                    )
                    full_text += "\n".join(ocr_result) + "\n"
            except Exception as ocr_err:
                pass

        # Basic line-by-line parsing for UBS-style PDF statements
        detected_bank = bank or "ubs"
        raw_transactions = _parse_pdf_text(full_text, detected_bank)

    finally:
        os.unlink(tmp_path)

    # Process & save same as CSV import
    imported = 0
    skipped = 0
    failed = 0
    preview_items: List[ImportPreviewTransaction] = []

    for raw in raw_transactions:
        try:
            import_hash = compute_import_hash(
                account_id,
                str(raw.get("date", "")),
                float(raw.get("amount", 0)),
                str(raw.get("description", "")),
            )

            dup_result = await db.execute(
                select(Transaction.id).where(
                    Transaction.account_id == account_id,
                    Transaction.import_hash == import_hash,
                )
            )
            if dup_result.scalar_one_or_none():
                skipped += 1
                continue

            cat_result = await categorization_service.categorize(raw.get("description", ""))

            txn = Transaction(
                account_id=account_id,
                date=raw["date"],
                description=raw["description"],
                amount=float(raw["amount"]),
                currency=raw.get("currency", account.currency),
                category=cat_result["category"],
                subcategory=cat_result.get("subcategory"),
                merchant_normalized=cat_result.get("merchant_normalized"),
                confidence_score=cat_result["confidence_score"],
                import_hash=import_hash,
            )
            db.add(txn)
            imported += 1

            if len(preview_items) < 20:
                preview_items.append(
                    ImportPreviewTransaction(
                        date=str(raw["date"]),
                        description=raw["description"],
                        amount=float(raw["amount"]),
                        currency=raw.get("currency", "CHF"),
                        category=cat_result["category"],
                        confidence_score=cat_result["confidence_score"],
                        is_duplicate=False,
                    )
                )
        except Exception:
            failed += 1

    log = ImportLog(
        user_id=current_user.id,
        account_id=account_id,
        filename=file.filename or "upload.pdf",
        bank=bank or "ubs",
        file_type="pdf",
        rows_imported=imported,
        rows_skipped=skipped,
        rows_failed=failed,
        status=ImportStatus.completed,
        preview_json={"preview": [p.model_dump() for p in preview_items]},
    )
    db.add(log)
    await db.flush()
    await db.refresh(log)

    return ImportResultResponse(
        import_id=log.id,
        bank=bank or "ubs",
        rows_imported=imported,
        rows_skipped=skipped,
        rows_failed=failed,
        status="completed",
        preview=preview_items,
    )


def _parse_pdf_text(text: str, bank: str) -> List[dict]:
    """Simple regex-based line parser for PDF statement text."""
    import re
    from datetime import datetime

    rows = []
    # Match lines like: 12.03.2024  Payment to Migros  -42.50
    pattern = re.compile(
        r"(\d{2}\.\d{2}\.\d{4})\s+(.+?)\s+([+-]?\d{1,3}(?:[',\.]\d{3})*(?:[',\.]\d{2}))\s*$"
    )
    for line in text.split("\n"):
        m = pattern.match(line.strip())
        if m:
            date_str, desc, amount_str = m.groups()
            try:
                dt = datetime.strptime(date_str, "%d.%m.%Y")
                amount_clean = amount_str.replace("'", "").replace(",", ".")
                rows.append({
                    "date": dt,
                    "description": desc.strip(),
                    "amount": float(amount_clean),
                    "currency": "CHF",
                })
            except ValueError:
                continue
    return rows


@router.get("/history", response_model=List[ImportLogResponse])
async def import_history(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = 50,
):
    """List the current user's import history."""
    result = await db.execute(
        select(ImportLog)
        .where(ImportLog.user_id == current_user.id)
        .order_by(desc(ImportLog.created_at))
        .limit(limit)
    )
    logs = result.scalars().all()
    return [
        ImportLogResponse(
            id=log.id,
            filename=log.filename,
            bank=log.bank,
            file_type=log.file_type,
            rows_imported=log.rows_imported,
            rows_skipped=log.rows_skipped,
            status=log.status.value,
            created_at=log.created_at,
            account_id=log.account_id,
        )
        for log in logs
    ]


@router.get("/{import_id}/preview")
async def import_preview(
    import_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get the preview JSON from a past import."""
    result = await db.execute(
        select(ImportLog).where(
            ImportLog.id == import_id,
            ImportLog.user_id == current_user.id,
        )
    )
    log = result.scalar_one_or_none()
    if not log:
        raise HTTPException(status_code=404, detail="Import log not found.")

    return {
        "id": log.id,
        "filename": log.filename,
        "bank": log.bank,
        "status": log.status.value,
        "rows_imported": log.rows_imported,
        "rows_skipped": log.rows_skipped,
        "preview": log.preview_json or [],
    }
