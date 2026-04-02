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

class ColumnMapping(BaseModel):
    date_col: Optional[str] = None
    description_col: Optional[str] = None
    amount_col: Optional[str] = None
    debit_col: Optional[str] = None
    credit_col: Optional[str] = None
    balance_col: Optional[str] = None
    date_format: Optional[str] = None


class ImportPreviewTransaction(BaseModel):
    row_index: int
    date: Optional[str] = None
    description: Optional[str] = None
    amount: Optional[float] = None
    raw_data: dict
    parsed: bool
    errors: List[str]
    currency: str = "CHF"
    category: Optional[str] = None
    confidence_score: Optional[float] = None
    is_duplicate: bool = False


class PreviewRequest(BaseModel):
    bank: str
    column_mapping: Optional[ColumnMapping] = None


class PreviewResponse(BaseModel):
    bank: str
    detected_columns: dict
    column_mapping: Optional[ColumnMapping]
    rows: List[ImportPreviewTransaction]
    total_rows: int
    parsed_rows: int
    error_rows: int
    sample_raw: List[dict]


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

@router.post("/preview", response_model=PreviewResponse)
async def preview_import(
    file: UploadFile = File(...),
    bank: Optional[str] = Form(None),
    account_id: Optional[int] = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Preview CSV data before import. Returns parsed rows with detected columns
    and allows manual column mapping adjustment.
    """
    content = await file.read()

    # Detect bank format
    detected_bank = bank or detect_bank_format(content)

    # Read first 100 rows for preview
    try:
        for enc in ("utf-8-sig", "latin-1", "cp1252", "utf-8"):
            try:
                text = content.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        else:
            text = content.decode("utf-8", errors="replace")
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Could not decode file: {e}")

    lines = text.splitlines()

    # Find header
    header_idx = None
    delimiter = ";" if detected_bank in ("ubs", "comdirect") else ","

    for idx, line in enumerate(lines[:50]):
        if not line.strip():
            continue
        lower_line = line.lower()
        if any(keyword in lower_line for keyword in ["date", "datum", "valuta", "buchung", "amount", "betrag", "description", "text"]):
            header_idx = idx
            break

    if header_idx is None:
        raise HTTPException(status_code=422, detail="Could not find CSV header row.")

    header = lines[header_idx].split(delimiter)
    header = [h.strip().strip('"').strip() for h in header]

    # Detect columns automatically
    detected_columns = detect_columns(header, detected_bank)

    # Parse preview rows
    preview_rows: List[ImportPreviewTransaction] = []
    sample_raw = []

    data_lines = lines[header_idx + 1:header_idx + 51]  # First 50 data rows

    for row_idx, line in enumerate(data_lines):
        if not line.strip():
            continue

        parts = line.split(delimiter)
        parts = [p.strip().strip('"').strip() for p in parts]

        if len(parts) < 2:
            continue

        raw_data = {header[i]: parts[i] if i < len(parts) else "" for i in range(len(header))}

        if row_idx < 3:
            sample_raw.append(raw_data)

        # Try to parse the row
        parsed_row = parse_preview_row(
            parts, header, detected_columns, detected_bank, row_idx
        )
        preview_rows.append(parsed_row)

    return PreviewResponse(
        bank=detected_bank,
        detected_columns=detected_columns,
        column_mapping=None,
        rows=preview_rows[:20],  # Return first 20 parsed rows
        total_rows=len([l for l in lines[header_idx+1:] if l.strip()]),
        parsed_rows=sum(1 for r in preview_rows if r.parsed),
        error_rows=sum(1 for r in preview_rows if not r.parsed),
        sample_raw=sample_raw,
    )


def detect_columns(header: List[str], bank: str) -> dict:
    """Detect column types from header names."""
    result = {}
    header_lower = [h.lower() for h in header]

    # Date columns
    date_keywords = ["date", "datum", "valuta", "buchungsdatum", "buchungstag", "wertstellung"]
    for i, h in enumerate(header_lower):
        if any(kw in h for kw in date_keywords):
            result["date"] = header[i]
            break

    # Description columns
    desc_keywords = ["description", "text", "buchungstext", "vorgang", "zweck", "verwendungszweck", "beschreibung"]
    for i, h in enumerate(header_lower):
        if any(kw in h for kw in desc_keywords):
            result["description"] = header[i]
            break

    # Amount columns
    amount_keywords = ["amount", "betrag", "umsatz", "saldo", "balance"]
    for i, h in enumerate(header_lower):
        if any(kw in h for kw in amount_keywords):
            result["amount"] = header[i]
            break

    # Debit/Belastung columns
    debit_keywords = ["debit", "belastung", "ausgang", "soll", "lastschrift"]
    for i, h in enumerate(header_lower):
        if any(kw in h for kw in debit_keywords):
            result["debit"] = header[i]
            break

    # Credit/Gutschrift columns
    credit_keywords = ["credit", "gutschrift", "eingang", "haben", "einzahlung"]
    for i, h in enumerate(header_lower):
        if any(kw in h for kw in credit_keywords):
            result["credit"] = header[i]
            break

    return result


def parse_preview_row(
    parts: List[str],
    header: List[str],
    detected_columns: dict,
    bank: str,
    row_idx: int,
) -> ImportPreviewTransaction:
    """Parse a single CSV row for preview."""
    errors = []
    raw_data = {header[i]: parts[i] if i < len(parts) else "" for i in range(len(header))}

    # Parse date
    date_str = None
    date_val = None
    if "date" in detected_columns:
        date_col = detected_columns["date"]
        if date_col in raw_data:
            date_str = raw_data[date_col].strip()
            if date_str:
                date_formats = ["%d.%m.%Y", "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y"]
                for fmt in date_formats:
                    try:
                        date_val = datetime.strptime(date_str, fmt)
                        break
                    except ValueError:
                        continue
                if date_val is None:
                    errors.append(f"Could not parse date: {date_str}")

    # Parse description
    description = None
    if "description" in detected_columns:
        desc_col = detected_columns["description"]
        if desc_col in raw_data:
            description = raw_data[desc_col].strip()
            if not description:
                errors.append("Empty description")

    # Parse amount
    amount = None
    amount_str = None

    # Try debit/credit columns first
    if "debit" in detected_columns:
        debit_col = detected_columns["debit"]
        if debit_col in raw_data:
            debit_str = raw_data[debit_col].strip()
            if debit_str:
                try:
                    amount = -abs(parse_amount(debit_str, bank))
                    amount_str = debit_str
                except:
                    pass

    if amount is None and "credit" in detected_columns:
        credit_col = detected_columns["credit"]
        if credit_col in raw_data:
            credit_str = raw_data[credit_col].strip()
            if credit_str:
                try:
                    amount = abs(parse_amount(credit_str, bank))
                    amount_str = credit_str
                except:
                    pass

    # Fallback to amount column
    if amount is None and "amount" in detected_columns:
        amount_col = detected_columns["amount"]
        if amount_col in raw_data:
            amount_str = raw_data[amount_col].strip()
            if amount_str:
                try:
                    amount = parse_amount(amount_str, bank)
                except Exception as e:
                    errors.append(f"Could not parse amount: {amount_str}")

    if amount is None:
        errors.append("Could not determine amount")

    parsed = date_val is not None and description and amount is not None

    return ImportPreviewTransaction(
        row_index=row_idx,
        date=date_str,
        description=description,
        amount=amount,
        raw_data=raw_data,
        parsed=parsed,
        errors=errors,
    )


def parse_amount(value: str, bank: str) -> float:
    """Parse amount string based on bank format."""
    if not value:
        raise ValueError("Empty amount")

    cleaned = value.strip()

    # Detect sign
    negative = cleaned.startswith("-") or cleaned.endswith("-")
    cleaned = cleaned.lstrip("+-").strip().rstrip("-").strip()

    # Remove currency symbols and whitespace
    cleaned = re.sub(r"[^\d.,'-]", "", cleaned)

    # Handle different formats
    if bank in ("comdirect",) and "," in cleaned and "." in cleaned:
        # German format: 1.234,56
        cleaned = cleaned.replace(".", "").replace(",", ".")
    elif bank in ("ubs", "n26", "revolut"):
        # Swiss/International: 1'234.56 or 1,234.56
        cleaned = cleaned.replace("'", "").replace(",", "")
    else:
        # Try to auto-detect: if comma as decimal separator
        if cleaned.count(",") == 1 and cleaned.count(".") == 0:
            cleaned = cleaned.replace(",", ".")
        elif cleaned.count(",") == 1 and cleaned.count(".") == 1:
            # 1,234.56 -> remove comma, it's thousands
            if cleaned.find(",") < cleaned.find("."):
                cleaned = cleaned.replace(",", "")
            else:
                # 1.234,56 -> German format
                cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace("'", "").replace(",", "")

    result = float(cleaned)
    return -result if negative else result


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


@router.delete("/{import_id}", status_code=status.HTTP_200_OK)
async def delete_import(
    import_id: int,
    delete_transactions: bool = True,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Delete an import log and ALL associated transactions.
    This allows users to completely undo an import.
    """
    from sqlalchemy import delete, or_, and_
    from datetime import timedelta

    # Verify import exists and belongs to user
    result = await db.execute(
        select(ImportLog).where(
            ImportLog.id == import_id,
            ImportLog.user_id == current_user.id,
        )
    )
    log = result.scalar_one_or_none()
    if not log:
        raise HTTPException(status_code=404, detail="Import not found.")

    deleted_count = 0
    if delete_transactions and log.account_id:
        # Strategy 1: Delete by import_hash if available in preview
        # Extract import hashes from the preview JSON
        import_hashes = []
        if log.preview_json and isinstance(log.preview_json, dict):
            preview = log.preview_json.get("preview", [])
            for item in preview:
                if isinstance(item, dict) and not item.get("is_duplicate"):
                    # Reconstruct the import hash
                    import_hash = compute_import_hash(
                        log.account_id,
                        str(item.get("date", "")),
                        float(item.get("amount", 0)),
                        str(item.get("description", "")),
                    )
                    import_hashes.append(import_hash)

        # Strategy 2: Also use a wide time window as backup
        time_window_start = log.created_at - timedelta(minutes=30)
        time_window_end = log.created_at + timedelta(minutes=30)

        # Build the delete query
        if import_hashes:
            # Delete by import_hash OR by time window
            delete_result = await db.execute(
                delete(Transaction).where(
                    Transaction.account_id == log.account_id,
                    or_(
                        Transaction.import_hash.in_(import_hashes[:100]),  # Limit to avoid query size issues
                        and_(
                            Transaction.created_at >= time_window_start,
                            Transaction.created_at <= time_window_end,
                        ),
                    ),
                )
            )
            deleted_count = delete_result.rowcount
        else:
            # Fallback: delete by time window only
            delete_result = await db.execute(
                delete(Transaction).where(
                    Transaction.account_id == log.account_id,
                    Transaction.created_at >= time_window_start,
                    Transaction.created_at <= time_window_end,
                )
            )
            deleted_count = delete_result.rowcount

    # Delete the import log
    await db.delete(log)
    await db.commit()  # Important: commit the transaction!

    return {
        "success": True,
        "import_id": import_id,
        "deleted_transactions": deleted_count,
        "message": f"Import gelöscht. {deleted_count} Transaktionen wurden entfernt." if delete_transactions else f"Import {import_id} Log gelöscht."
    }
