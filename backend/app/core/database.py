"""
SQLAlchemy async database setup.
Provides engine, session factory, and base model class.
"""
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy import DateTime, func

from app.core.config import settings


# ── Engine ────────────────────────────────────────────────────

engine = create_async_engine(
    settings.database_url,
    echo=settings.is_development,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
    pool_recycle=3600,
)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


# ── Base Model ────────────────────────────────────────────────

class Base(DeclarativeBase):
    """Base class for all SQLAlchemy ORM models."""
    pass


class TimestampMixin:
    """Mixin that adds created_at and updated_at columns."""
    created_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[DateTime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


# ── Session Dependency ────────────────────────────────────────

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency — yields an async database session."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


# ── DB Init ───────────────────────────────────────────────────

async def init_db() -> None:
    """Create all tables if they do not exist. (Dev/initial setup.)
    In production, use Alembic migrations instead.
    """
    import logging
    from sqlalchemy.exc import ProgrammingError

    logger = logging.getLogger(__name__)
    from app.models import models  # noqa: F401 — import to register models

    # Migrations-first policy:
    # - production/staging should use Alembic and skip create_all by default
    # - local dev can explicitly enable auto_create_schema if desired
    if not settings.auto_create_schema:
        logger.info(
            "AUTO_CREATE_SCHEMA disabled; skipping create_all(). "
            "Run Alembic migrations (e.g. `alembic upgrade head`)."
        )
        return

    try:
        async with engine.begin() as conn:
            await conn.run_sync(lambda c: Base.metadata.create_all(c, checkfirst=True))
        logger.info("Database schema ready via create_all (AUTO_CREATE_SCHEMA=true).")
    except ProgrammingError as exc:
        if "already exists" in str(exc).lower():
            logger.warning("DB objects already exist — schema is up to date. Use Alembic for migrations.")
        else:
            raise
