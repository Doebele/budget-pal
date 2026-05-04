"""
SQLAlchemy async database setup.
Provides engine, session factory, and base model class.
"""

import os
from typing import AsyncGenerator

from app.core.config import settings
from sqlalchemy import DateTime, func
from sqlalchemy.engine.url import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def _build_async_engine():
    url = settings.database_url
    if url.startswith("sqlite"):
        return create_async_engine(
            url,
            echo=settings.is_development,
            connect_args={"check_same_thread": False},
        )
    return create_async_engine(
        url,
        echo=settings.is_development,
        pool_size=10,
        max_overflow=20,
        pool_pre_ping=True,
        pool_recycle=3600,
    )


# ── Engine ────────────────────────────────────────────────────

engine = _build_async_engine()

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
    """FastAPI dependency — yields an async database session.

    IMPORTANT: This session does NOT auto-commit. Routers must explicitly call
    ``await db.commit()`` or ``await db.flush()`` as appropriate. This prevents
    the dangerous "commit in the wrong place" anti-pattern where a router's
    ``flush()`` is silently committed by the middleware even if an error occurs
    later in the request pipeline.
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


# ── DB Init ───────────────────────────────────────────────────


def _ensure_app_data_subdirs() -> None:
    """Ensure upload and FX cache directories exist (empty Docker volume may hide image paths)."""
    from pathlib import Path

    Path(settings.uploads_dir).mkdir(parents=True, exist_ok=True)
    cache_path = os.getenv("RATES_CACHE_PATH", "/app/data/cache/rates.json")
    Path(cache_path).parent.mkdir(parents=True, exist_ok=True)


def _ensure_sqlite_parent_directory() -> None:
    """Create parent dirs for file-based SQLite (e.g. /app/data/budget-pal.db)."""
    url_s = settings.database_url
    if not url_s.startswith("sqlite"):
        return
    try:
        u = make_url(url_s)
    except Exception:
        return
    dbname = u.database
    if not dbname or dbname == ":memory:":
        return
    path = dbname if os.path.isabs(dbname) else os.path.abspath(dbname)
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)


async def init_db() -> None:
    """Create all tables if they do not exist. (Dev/initial setup.)
    In production, use Alembic migrations instead.
    """
    import logging

    from sqlalchemy.exc import ProgrammingError

    logger = logging.getLogger(__name__)
    from app.models import models  # noqa: F401 — import to register models

    _ensure_sqlite_parent_directory()
    _ensure_app_data_subdirs()

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
            logger.warning(
                "DB objects already exist — schema is up to date. Use Alembic for migrations."
            )
        else:
            raise
