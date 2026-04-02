"""
Models package — imports all ORM models so SQLAlchemy can discover them.
"""
from app.models.models import (  # noqa: F401
    User,
    Account,
    Transaction,
    Category,
    Label,
    TransactionLabel,
    Budget,
    PensionData,
    Asset,
    Scenario,
    ProjectionCache,
    ImportLog,
    ActivityLog,
)
