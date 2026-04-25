"""
Notifications API — returns anomaly findings for the current user.

GET /notifications          — list current anomaly findings
GET /notifications/count    — returns just the count (for bell badge)
"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.models import User
from app.services.anomaly_detector import detect

router = APIRouter()


@router.get("")
async def list_notifications(
    lookback_days: int = 90,
    recent_days: int = 30,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    findings = await detect(
        current_user, db,
        lookback_days=lookback_days,
        recent_days=recent_days,
    )
    return [f.to_dict() for f in findings]


@router.get("/count")
async def notification_count(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    findings = await detect(current_user, db)
    alerts = sum(1 for f in findings if f.severity == "alert")
    warnings = sum(1 for f in findings if f.severity == "warning")
    return {
        "total": len(findings),
        "alerts": alerts,
        "warnings": warnings,
    }
