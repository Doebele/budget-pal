"""
Import API routes — CSV and PDF bank statement import.

POST /imports/csv         — upload CSV, detect format, parse, categorize
POST /imports/pdf         — upload PDF, OCR, parse, categorize
GET  /imports/history     — list past imports
GET  /imports/{id}/preview — preview a past import result
"""
import base64
import hashlib
import io
import logging
import os
import re
import tempfile
from uuid import uuid4
from datetime import datetime, timezone
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field
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
from app.services.pdf_duplicate_detection import find_database_duplicate_transaction_id
from app.services.pdf_import_row_match import find_pdf_internal_duplicate_of, normalize_preview_date_str

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
    # Defaults so CSV/PDF legacy paths can omit fields (Pydantic v2 otherwise rejects response build).
    row_index: int = 0
    date: Optional[str] = None
    description: Optional[str] = None
    amount: Optional[float] = None
    raw_data: dict = Field(default_factory=dict)
    parsed: bool = True
    errors: List[str] = Field(default_factory=list)
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
    rows_failed: int = 0
    status: str
    created_at: datetime
    account_id: Optional[int]


class PdfPreviewTransaction(BaseModel):
    id: str
    original_date: str
    sign: str = ""
    amount: float
    description: str
    currency: str = "CHF"
    category: Optional[str] = None
    account_id: Optional[int] = None
    is_duplicate: bool = False
    parsed: bool = True
    errors: List[str] = []
    # Duplicates: "none" | "database" (matches existing txn) | "pdf" (repeated line in file)
    duplicate_kind: str = "none"
    existing_transaction_id: Optional[int] = None
    duplicate_of_row_id: Optional[str] = None
    # import | skip | overwrite | keep_existing | delete_both
    merge_action: str = "import"


class PdfPreviewResponse(BaseModel):
    bank: str
    filename: str
    rows: List[PdfPreviewTransaction]
    total_rows: int
    parsed_rows: int
    error_rows: int


class PdfImportConfirmRequest(BaseModel):
    account_id: int
    bank: Optional[str] = None
    filename: Optional[str] = None
    rows: List[PdfPreviewTransaction]


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


def _transaction_date_utc(d: datetime) -> datetime:
    """TIMESTAMPTZ / asyncpg: naive datetimes are rejected."""
    if d.tzinfo is None:
        return d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def _date_str_for_import_hash(date_val: object) -> str:
    if isinstance(date_val, datetime):
        return date_val.strftime("%Y-%m-%d")
    s = str(date_val or "").strip()
    return s[:10] if len(s) >= 10 else s


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
        logger.error("CSV parse error for bank=%s file=%s: %s", detected_bank, file.filename, e)
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
        await db.commit()
        raise HTTPException(status_code=422, detail=f"Parse error: {e}")

    # Process transactions
    imported = 0
    skipped = 0
    failed = 0
    preview_items: List[ImportPreviewTransaction] = []
    imported_hashes: List[str] = []

    for raw in raw_transactions:
        try:
            import_hash = compute_import_hash(
                account_id,
                _date_str_for_import_hash(raw.get("date")),
                float(raw.get("amount", 0)),
                str(raw.get("description", "")),
            )

            # Deduplication check
            dup_result = await db.execute(
                select(Transaction.id).where(
                    Transaction.account_id == account_id,
                    Transaction.import_hash == import_hash,
                    Transaction.is_deleted.isnot(True),
                )
            )
            is_duplicate = dup_result.scalar_one_or_none() is not None

            if is_duplicate:
                skipped += 1
                if len(preview_items) < 5:
                    preview_items.append(
                        ImportPreviewTransaction(
                            row_index=len(preview_items),
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

            raw_dt = raw["date"]
            txn_dt = (
                _transaction_date_utc(raw_dt)
                if isinstance(raw_dt, datetime)
                else datetime.strptime(str(raw_dt)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
            )

            bd = raw.get("booking_date")
            booking_utc = _transaction_date_utc(bd) if isinstance(bd, datetime) else None

            txn = Transaction(
                account_id=account_id,
                date=txn_dt,
                booking_date=booking_utc,
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
            imported_hashes.append(import_hash)

            if len(preview_items) < 20:
                preview_items.append(
                    ImportPreviewTransaction(
                        row_index=len(preview_items),
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
            logger.warning("CSV row processing failed (row_index=%d): %s", len(preview_items), e)
            failed += 1

    # Determine import status
    if failed > 0 and imported == 0:
        csv_status = ImportStatus.failed
    elif failed > 0:
        csv_status = ImportStatus.partial
    else:
        csv_status = ImportStatus.completed

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
        status=csv_status,
        preview_json={
            "preview": [p.model_dump() for p in preview_items],
            "import_hashes": imported_hashes,
        },
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
        status=csv_status.value,
        preview=preview_items,
    )


async def _ocr_pdf_to_text(tmp_path: str) -> str:
    """
    Two-stage OCR pipeline for scanned PDF bank statements.

    Stage 1 — pytesseract (local, zero cost):
        Converts each PDF page to an image via pdf2image and runs
        Tesseract with German+English language packs.  Fast and private.

    Stage 2 — Mistral OCR fallback (API, ~$0.001/page):
        Triggered only when pytesseract yields fewer than 100 characters.
        Sends the raw PDF as base64 to mistral-ocr-latest which handles
        complex layouts and handwriting far better than Tesseract.
        Skipped gracefully when MISTRAL_API_KEY is not configured.

    Returns a newline-separated plain-text string consumed by
    _parse_pdf_text().
    """
    import asyncio
    import pytesseract
    from pdf2image import convert_from_path

    images = convert_from_path(tmp_path, dpi=200)
    tess_config = "--oem 3 --psm 6 -l deu+eng"
    loop = asyncio.get_event_loop()

    # ── Stage 1: pytesseract (local) ──────────────────────────
    pages_text = []
    for img in images:
        page_text = await loop.run_in_executor(
            None, lambda i=img: pytesseract.image_to_string(i, config=tess_config)
        )
        pages_text.append(page_text)
    full_text = "\n".join(pages_text)

    if len(full_text.strip()) >= 100:
        logger.info("OCR: pytesseract succeeded (%d chars).", len(full_text))
        return full_text

    logger.info("OCR: pytesseract sparse (%d chars), trying Mistral fallback.", len(full_text))

    # ── Stage 2: Mistral OCR fallback ─────────────────────────
    if not settings.mistral_ocr_enabled:
        logger.warning("OCR: Mistral fallback skipped — MISTRAL_API_KEY not set.")
        return full_text

    try:
        from mistralai import Mistral

        with open(tmp_path, "rb") as f:
            pdf_b64 = base64.b64encode(f.read()).decode("utf-8")

        client = Mistral(api_key=settings.mistral_api_key)
        response = await loop.run_in_executor(
            None,
            lambda: client.ocr.process(
                model="mistral-ocr-latest",
                document={
                    "type": "document_url",
                    "document_url": f"data:application/pdf;base64,{pdf_b64}",
                },
            ),
        )
        mistral_text = "\n".join(
            getattr(page, "markdown", "") or "" for page in response.pages
        )
        logger.info("OCR: Mistral succeeded (%d chars).", len(mistral_text))
        return mistral_text

    except Exception as mistral_err:
        logger.warning("OCR: Mistral fallback failed: %s", mistral_err)
        return full_text


@router.post("/pdf/preview", response_model=PdfPreviewResponse)
async def preview_pdf_import(
    file: UploadFile = File(...),
    bank: Optional[str] = Form(None),
    account_id: Optional[int] = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Extract PDF transactions and return editable preview rows."""
    if account_id is not None:
        acct_result = await db.execute(
            select(Account).where(Account.id == account_id, Account.user_id == current_user.id)
        )
        if not acct_result.scalar_one_or_none():
            raise HTTPException(status_code=404, detail="Account not found.")

    content = await file.read()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        import pdfplumber
        with pdfplumber.open(tmp_path) as pdf:
            full_text = "\n".join(page.extract_text() or "" for page in pdf.pages)
        if len(full_text.strip()) < 100:
            full_text = await _ocr_pdf_to_text(tmp_path)
    finally:
        os.unlink(tmp_path)

    detected_bank = bank or "ubs"
    raw_transactions = _parse_pdf_text(full_text, detected_bank)

    rows: List[PdfPreviewTransaction] = []
    parsed_rows = 0
    error_rows = 0
    prior_for_pdf: List[Tuple[str, str, float, str]] = []

    for row in raw_transactions:
        date_val = row.get("date")
        amount_val = float(row.get("amount", 0))
        description_val = str(row.get("description", "")).strip()
        errors: List[str] = []
        if not date_val:
            errors.append("Missing date")
        if not description_val:
            errors.append("Missing description")

        date_str = normalize_preview_date_str(date_val)

        parsed = len(errors) == 0
        duplicate_kind = "none"
        existing_transaction_id: Optional[int] = None
        duplicate_of_row_id: Optional[str] = None
        merge_action = "import"
        is_duplicate = False

        if parsed and account_id and date_str and description_val:
            import_hash = compute_import_hash(account_id, date_str, amount_val, description_val)
            existing_transaction_id = await find_database_duplicate_transaction_id(
                db,
                account_id,
                date_str,
                amount_val,
                description_val,
                import_hash,
            )
            if existing_transaction_id is not None:
                duplicate_kind = "database"
                is_duplicate = True
                merge_action = "keep_existing"

        if parsed and duplicate_kind == "none" and description_val and date_str:
            dup_rid = find_pdf_internal_duplicate_of(
                prior_for_pdf,
                date_str,
                amount_val,
                description_val,
            )
            if dup_rid:
                duplicate_kind = "pdf"
                duplicate_of_row_id = dup_rid
                is_duplicate = True
                merge_action = "skip"

        if parsed:
            parsed_rows += 1
        else:
            error_rows += 1

        row_id = str(uuid4())
        display_date = date_str or (
            date_val.strftime("%Y-%m-%d") if isinstance(date_val, datetime) else str(date_val or "")
        )
        rows.append(
            PdfPreviewTransaction(
                id=row_id,
                original_date=display_date,
                sign="+" if amount_val > 0 else "",
                amount=amount_val,
                description=description_val,
                currency=row.get("currency", "CHF"),
                category=None,
                account_id=account_id,
                is_duplicate=is_duplicate,
                parsed=parsed,
                errors=errors,
                duplicate_kind=duplicate_kind,
                existing_transaction_id=existing_transaction_id,
                duplicate_of_row_id=duplicate_of_row_id,
                merge_action=merge_action,
            )
        )
        if parsed:
            prior_for_pdf.append((row_id, date_str, amount_val, description_val))

    return PdfPreviewResponse(
        bank=detected_bank,
        filename=file.filename or "upload.pdf",
        rows=rows,
        total_rows=len(rows),
        parsed_rows=parsed_rows,
        error_rows=error_rows,
    )


@router.post("/pdf/confirm", response_model=ImportResultResponse, status_code=status.HTTP_201_CREATED)
async def confirm_pdf_import(
    payload: PdfImportConfirmRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Persist user-reviewed PDF preview rows."""
    acct_result = await db.execute(
        select(Account).where(Account.id == payload.account_id, Account.user_id == current_user.id)
    )
    account = acct_result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found.")

    imported = 0
    skipped = 0
    failed = 0
    preview_items: List[ImportPreviewTransaction] = []
    imported_hashes: List[str] = []
    bank_name = payload.bank or "ubs"
    allowed_merge = frozenset({"import", "skip", "overwrite", "keep_existing", "delete_both"})

    def append_preview_sample(
        *,
        date_s: str,
        description: str,
        amount: float,
        currency: str,
        category: Optional[str],
        confidence_score: Optional[float],
        is_duplicate: bool,
    ) -> None:
        if len(preview_items) >= 20:
            return
        preview_items.append(
            ImportPreviewTransaction(
                row_index=imported + skipped + failed,
                date=date_s,
                description=description,
                amount=amount,
                raw_data={},
                parsed=True,
                errors=[],
                currency=currency,
                category=category,
                confidence_score=confidence_score,
                is_duplicate=is_duplicate,
            )
        )

    for row in payload.rows:
        if not row.parsed:
            skipped += 1
            continue

        action = row.merge_action if row.merge_action in allowed_merge else "import"

        if row.duplicate_kind == "pdf" and action == "skip":
            skipped += 1
            continue

        try:
            date_norm = row.original_date.strip()[:10]
            dt = datetime.strptime(date_norm, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            failed += 1
            continue

        description = row.description.strip()
        amount = float(row.amount)
        import_hash = compute_import_hash(payload.account_id, date_norm, amount, description)
        cur = row.currency or "CHF"

        if row.duplicate_kind == "database":
            if action in ("keep_existing", "skip"):
                skipped += 1
                continue
            if action == "delete_both":
                try:
                    if row.existing_transaction_id:
                        txn_res = await db.execute(
                            select(Transaction).where(
                                Transaction.id == row.existing_transaction_id,
                                Transaction.account_id == payload.account_id,
                                Transaction.is_deleted.isnot(True),
                            )
                        )
                        ex = txn_res.scalar_one_or_none()
                        if ex:
                            await db.delete(ex)
                except Exception as del_err:
                    logger.warning("delete_both failed for txn_id=%s: %s", row.existing_transaction_id, del_err)
                skipped += 1
                continue
            if action == "overwrite":
                if not row.existing_transaction_id:
                    failed += 1
                    continue
                txn_res = await db.execute(
                    select(Transaction).where(
                        Transaction.id == row.existing_transaction_id,
                        Transaction.account_id == payload.account_id,
                        Transaction.is_deleted.isnot(True),
                    )
                )
                ex = txn_res.scalar_one_or_none()
                if not ex:
                    failed += 1
                    continue
                category = row.category
                confidence_score = None
                if not category:
                    cat_result = await categorization_service.categorize(description)
                    category = cat_result["category"]
                    confidence_score = cat_result["confidence_score"]
                else:
                    confidence_score = ex.confidence_score
                ex.date = dt
                ex.description = description
                ex.amount = amount
                ex.currency = cur or account.currency
                ex.category = category
                ex.confidence_score = confidence_score
                ex.import_hash = import_hash
                imported += 1
                imported_hashes.append(import_hash)
                append_preview_sample(
                    date_s=date_norm,
                    description=description,
                    amount=amount,
                    currency=cur,
                    category=category,
                    confidence_score=confidence_score,
                    is_duplicate=False,
                )
                continue
            # action == import: fall through to insert if hash unique

        dup_result = await db.execute(
            select(Transaction.id).where(
                Transaction.account_id == payload.account_id,
                Transaction.import_hash == import_hash,
                Transaction.is_deleted.isnot(True),
            )
        )
        if dup_result.scalar_one_or_none():
            skipped += 1
            continue

        try:
            category = row.category
            confidence_score = None
            if not category:
                cat_result = await categorization_service.categorize(description)
                category = cat_result["category"]
                confidence_score = cat_result["confidence_score"]

            txn = Transaction(
                account_id=payload.account_id,
                date=dt,
                description=description,
                amount=amount,
                currency=cur or account.currency,
                category=category,
                confidence_score=confidence_score,
                import_hash=import_hash,
            )
            db.add(txn)
            imported += 1
            imported_hashes.append(import_hash)
            append_preview_sample(
                date_s=date_norm,
                description=description,
                amount=amount,
                currency=cur,
                category=category,
                confidence_score=confidence_score,
                is_duplicate=False,
            )
        except Exception as e:
            logger.warning("PDF confirm row processing failed: %s", e)
            failed += 1

    # Determine import status
    if failed > 0 and imported == 0:
        pdf_confirm_status = ImportStatus.failed
    elif failed > 0:
        pdf_confirm_status = ImportStatus.partial
    else:
        pdf_confirm_status = ImportStatus.completed

    log = ImportLog(
        user_id=current_user.id,
        account_id=payload.account_id,
        filename=payload.filename or "upload.pdf",
        bank=bank_name,
        file_type="pdf",
        rows_imported=imported,
        rows_skipped=skipped,
        rows_failed=failed,
        status=pdf_confirm_status,
        preview_json={
            "preview": [p.model_dump() for p in preview_items],
            "import_hashes": imported_hashes,
        },
    )
    db.add(log)
    await db.flush()
    await db.refresh(log)

    return ImportResultResponse(
        import_id=log.id,
        bank=bank_name,
        rows_imported=imported,
        rows_skipped=skipped,
        rows_failed=failed,
        status=pdf_confirm_status.value,
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

        # If pdfplumber extraction is too sparse, fall back to OCR pipeline
        if len(full_text.strip()) < 100:
            try:
                full_text = await _ocr_pdf_to_text(tmp_path)
            except Exception as ocr_err:
                logger.warning("OCR pipeline failed: %s", ocr_err)

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
    imported_hashes: List[str] = []

    for raw in raw_transactions:
        try:
            import_hash = compute_import_hash(
                account_id,
                _date_str_for_import_hash(raw.get("date")),
                float(raw.get("amount", 0)),
                str(raw.get("description", "")),
            )

            dup_result = await db.execute(
                select(Transaction.id).where(
                    Transaction.account_id == account_id,
                    Transaction.import_hash == import_hash,
                    Transaction.is_deleted.isnot(True),
                )
            )
            if dup_result.scalar_one_or_none():
                skipped += 1
                continue

            cat_result = await categorization_service.categorize(raw.get("description", ""))

            raw_dt = raw["date"]
            txn_dt = (
                _transaction_date_utc(raw_dt)
                if isinstance(raw_dt, datetime)
                else datetime.strptime(str(raw_dt)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
            )

            txn = Transaction(
                account_id=account_id,
                date=txn_dt,
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
            imported_hashes.append(import_hash)

            if len(preview_items) < 20:
                preview_items.append(
                    ImportPreviewTransaction(
                        row_index=len(preview_items),
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
            logger.warning("Legacy PDF row processing failed: %s", e)
            failed += 1

    # Determine import status
    if failed > 0 and imported == 0:
        pdf_status = ImportStatus.failed
    elif failed > 0:
        pdf_status = ImportStatus.partial
    else:
        pdf_status = ImportStatus.completed

    log = ImportLog(
        user_id=current_user.id,
        account_id=account_id,
        filename=file.filename or "upload.pdf",
        bank=bank or "ubs",
        file_type="pdf",
        rows_imported=imported,
        rows_skipped=skipped,
        rows_failed=failed,
        status=pdf_status,
        preview_json={
            "preview": [p.model_dump() for p in preview_items],
            "import_hashes": imported_hashes,
        },
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
        status=pdf_status.value,
        preview=preview_items,
    )


def _parse_pdf_text(text: str, bank: str) -> List[dict]:
    """Simple regex-based line parser for PDF statement text."""
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
            rows_failed=log.rows_failed or 0,
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
    Safety policy: delete only records we can match by persisted import hashes.
    """
    from sqlalchemy import delete

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
        import_hashes: List[str] = []
        if log.preview_json and isinstance(log.preview_json, dict):
            raw_hashes = log.preview_json.get("import_hashes", [])
            if isinstance(raw_hashes, list):
                import_hashes = [str(h) for h in raw_hashes if h]

        # Safety first: no heuristic time-window deletes.
        if import_hashes:
            delete_result = await db.execute(
                delete(Transaction).where(
                    Transaction.account_id == log.account_id,
                    Transaction.import_hash.in_(import_hashes),
                )
            )
            deleted_count = delete_result.rowcount

    # Delete the import log (get_db() commits on success)
    await db.delete(log)

    return {
        "success": True,
        "import_id": import_id,
        "deleted_transactions": deleted_count,
        "message": f"Import gelöscht. {deleted_count} Transaktionen wurden entfernt." if delete_transactions else f"Import {import_id} Log gelöscht."
    }
