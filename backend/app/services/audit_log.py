"""Append-only audit trail for destructive transaction operations."""
from __future__ import annotations

import json
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import ActivityLog


async def record_activity(
    db: AsyncSession,
    *,
    user_id: int,
    action: str,
    method: str,
    affected_rows: int,
    detail: Optional[dict[str, Any]] = None,
) -> None:
    """Persist an audit row. Uses parameterized insert via ORM (no string SQL)."""
    row = ActivityLog(
        user_id=user_id,
        action=action,
        method=method,
        affected_rows=affected_rows,
        detail=json.dumps(detail, default=str) if detail else None,
    )
    db.add(row)
