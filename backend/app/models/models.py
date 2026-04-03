"""
SQLAlchemy ORM models for Budget-Pal.

All models use SQLAlchemy 2.0 mapped_column style with type annotations.
"""
from __future__ import annotations

import enum
from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    Enum,
    UniqueConstraint,
    Index,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.core.json_type import PortableJSON


# ── Enums ─────────────────────────────────────────────────────

class AccountType(str, enum.Enum):
    checking = "checking"
    savings = "savings"
    investment = "investment"
    credit = "credit"
    cash = "cash"


class BudgetPeriod(str, enum.Enum):
    monthly = "monthly"
    annual = "annual"


class PensionPillar(str, enum.Enum):
    pillar_1 = "1"
    pillar_2 = "2"
    pillar_3a = "3a"
    pillar_3b = "3b"


class AssetType(str, enum.Enum):
    property = "property"
    stock = "stock"
    crypto = "crypto"
    bond = "bond"
    pension = "pension"
    other = "other"


class ImportStatus(str, enum.Enum):
    pending = "pending"
    processing = "processing"
    completed = "completed"
    partial = "partial"
    failed = "failed"


# ── User ──────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # User profile for projections
    date_of_birth: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    retirement_age: Mapped[int] = mapped_column(Integer, default=65)
    currency: Mapped[str] = mapped_column(String(3), default="CHF")
    locale: Mapped[str] = mapped_column(String(10), default="de-CH")

    # Relationships
    accounts: Mapped[List["Account"]] = relationship("Account", back_populates="user", cascade="all, delete-orphan")
    categories: Mapped[List["Category"]] = relationship("Category", back_populates="user", cascade="all, delete-orphan")
    labels: Mapped[List["Label"]] = relationship("Label", back_populates="user", cascade="all, delete-orphan")
    budgets: Mapped[List["Budget"]] = relationship("Budget", back_populates="user", cascade="all, delete-orphan")
    pension_data: Mapped[List["PensionData"]] = relationship("PensionData", back_populates="user", cascade="all, delete-orphan")
    assets: Mapped[List["Asset"]] = relationship("Asset", back_populates="user", cascade="all, delete-orphan")
    scenarios: Mapped[List["Scenario"]] = relationship("Scenario", back_populates="user", cascade="all, delete-orphan")
    import_logs: Mapped[List["ImportLog"]] = relationship("ImportLog", back_populates="user", cascade="all, delete-orphan")
    forecast_scenarios: Mapped[List["ForecastScenario"]] = relationship("ForecastScenario", back_populates="user", cascade="all, delete-orphan")
    activity_logs: Mapped[List["ActivityLog"]] = relationship("ActivityLog", back_populates="user")


# ── Account ───────────────────────────────────────────────────

class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    bank: Mapped[str] = mapped_column(String(100), nullable=False)
    account_number: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    iban: Mapped[Optional[str]] = mapped_column(String(34), nullable=True)
    currency: Mapped[str] = mapped_column(String(3), default="CHF", nullable=False)
    balance: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    account_type: Mapped[AccountType] = mapped_column(
        Enum(AccountType, native_enum=False), default=AccountType.checking, nullable=False
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    color: Mapped[Optional[str]] = mapped_column(String(7), nullable=True)  # hex color
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user: Mapped["User"] = relationship("User", back_populates="accounts")
    transactions: Mapped[List["Transaction"]] = relationship(
        "Transaction", back_populates="account", cascade="all, delete-orphan"
    )
    import_logs: Mapped[List["ImportLog"]] = relationship("ImportLog", back_populates="account")


# ── Transaction ───────────────────────────────────────────────

class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        UniqueConstraint("account_id", "import_hash", name="uq_transaction_hash"),
        Index("ix_transactions_account_date", "account_id", "date"),
        # Note: ix_transactions_category is created automatically by index=True on the column
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    account_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False
    )
    date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    booking_date: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    merchant_normalized: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="CHF", nullable=False)
    original_amount: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    original_currency: Mapped[Optional[str]] = mapped_column(String(3), nullable=True)
    exchange_rate: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # Categorization
    category: Mapped[Optional[str]] = mapped_column(String(100), nullable=True, index=True)
    subcategory: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    category_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True
    )
    confidence_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    user_verified: Mapped[bool] = mapped_column(Boolean, default=False)

    # Metadata
    import_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_transfer: Mapped[bool] = mapped_column(Boolean, default=False)
    is_recurring: Mapped[bool] = mapped_column(Boolean, default=False)
    periodicity: Mapped[Optional[str]] = mapped_column(String, nullable=True)

    # Soft delete fields
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    account: Mapped["Account"] = relationship("Account", back_populates="transactions")
    category_obj: Mapped[Optional["Category"]] = relationship("Category", back_populates="transactions")
    labels: Mapped[List["Label"]] = relationship(
        "Label", secondary="transaction_labels", back_populates="transactions"
    )


# ── Category ──────────────────────────────────────────────────

class Category(Base):
    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )  # NULL = system category
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    slug: Mapped[str] = mapped_column(String(100), nullable=False)
    parent_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True
    )
    color: Mapped[Optional[str]] = mapped_column(String(7), nullable=True)
    icon: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    user: Mapped[Optional["User"]] = relationship("User", back_populates="categories")
    parent: Mapped[Optional["Category"]] = relationship("Category", remote_side="Category.id", back_populates="children")
    children: Mapped[List["Category"]] = relationship("Category", back_populates="parent")
    transactions: Mapped[List["Transaction"]] = relationship("Transaction", back_populates="category_obj")
    budgets: Mapped[List["Budget"]] = relationship("Budget", back_populates="category")


# ── Label ─────────────────────────────────────────────────────

class Label(Base):
    __tablename__ = "labels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    color: Mapped[Optional[str]] = mapped_column(String(7), nullable=True)

    user: Mapped["User"] = relationship("User", back_populates="labels")
    transactions: Mapped[List["Transaction"]] = relationship(
        "Transaction", secondary="transaction_labels", back_populates="labels"
    )


# ── TransactionLabel (M:N join) ───────────────────────────────

class TransactionLabel(Base):
    __tablename__ = "transaction_labels"

    transaction_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("transactions.id", ondelete="CASCADE"), primary_key=True
    )
    label_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("labels.id", ondelete="CASCADE"), primary_key=True
    )


# ── Budget ────────────────────────────────────────────────────

class Budget(Base):
    __tablename__ = "budgets"
    __table_args__ = (
        UniqueConstraint("user_id", "category_id", "period", "year", "month", name="uq_budget"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    category_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("categories.id", ondelete="CASCADE"), nullable=True
    )
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    period: Mapped[BudgetPeriod] = mapped_column(
        Enum(BudgetPeriod, native_enum=False), default=BudgetPeriod.monthly
    )
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    month: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # NULL = all months
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped["User"] = relationship("User", back_populates="budgets")
    category: Mapped[Optional["Category"]] = relationship("Category", back_populates="budgets")


# ── PensionData ───────────────────────────────────────────────

class PensionData(Base):
    __tablename__ = "pension_data"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    pillar: Mapped[PensionPillar] = mapped_column(
        Enum(PensionPillar, native_enum=False), nullable=False
    )
    provider: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    current_balance: Mapped[float] = mapped_column(Float, default=0.0)
    annual_contribution: Mapped[float] = mapped_column(Float, default=0.0)
    expected_return_rate: Mapped[float] = mapped_column(Float, default=0.01)
    retirement_age: Mapped[int] = mapped_column(Integer, default=65)
    contribution_years: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    average_insured_salary: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    as_of_date: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user: Mapped["User"] = relationship("User", back_populates="pension_data")


# ── Asset ─────────────────────────────────────────────────────

class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    asset_type: Mapped[AssetType] = mapped_column(Enum(AssetType, native_enum=False), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    current_value: Mapped[float] = mapped_column(Float, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="CHF")
    as_of_date: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    expected_return_rate: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    metadata_json: Mapped[Optional[dict]] = mapped_column(PortableJSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user: Mapped["User"] = relationship("User", back_populates="assets")


# ── Scenario ──────────────────────────────────────────────────

class Scenario(Base):
    __tablename__ = "scenarios"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    parameters_json: Mapped[dict] = mapped_column(PortableJSON, nullable=False, default=dict)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user: Mapped["User"] = relationship("User", back_populates="scenarios")
    projections: Mapped[List["ProjectionCache"]] = relationship(
        "ProjectionCache", back_populates="scenario", cascade="all, delete-orphan"
    )


# ── ProjectionCache ───────────────────────────────────────────

class ProjectionCache(Base):
    __tablename__ = "projection_cache"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    scenario_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("scenarios.id", ondelete="CASCADE"), nullable=True
    )
    result_json: Mapped[dict] = mapped_column(PortableJSON, nullable=False)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    scenario: Mapped[Optional["Scenario"]] = relationship("Scenario", back_populates="projections")


# ── ImportLog ─────────────────────────────────────────────────

class ImportLog(Base):
    __tablename__ = "import_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    account_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    bank: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    file_type: Mapped[str] = mapped_column(String(10), default="csv")
    rows_imported: Mapped[int] = mapped_column(Integer, default=0)
    rows_skipped: Mapped[int] = mapped_column(Integer, default=0)
    rows_failed: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[ImportStatus] = mapped_column(
        Enum(ImportStatus, native_enum=False), default=ImportStatus.pending
    )
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    preview_json: Mapped[Optional[dict]] = mapped_column(PortableJSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped["User"] = relationship("User", back_populates="import_logs")
    account: Mapped[Optional["Account"]] = relationship("Account", back_populates="import_logs")


# ── ForecastScenario ──────────────────────────────────────────

class ForecastScenario(Base):
    """Saved predictive budget forecast scenarios."""

    __tablename__ = "forecast_scenarios"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    parameters: Mapped[Optional[dict]] = mapped_column(PortableJSON, nullable=True)
    result_json: Mapped[Optional[dict]] = mapped_column(PortableJSON, nullable=True)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    user: Mapped["User"] = relationship("User", back_populates="forecast_scenarios")


# ── ActivityLog (audit: deletes / bulk archive) ───────────────

class ActivityLog(Base):
    """Append-only log for financial data mutations (compliance / support)."""

    __tablename__ = "activity_log"
    __table_args__ = (Index("ix_activity_log_user_created", "user_id", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    method: Mapped[str] = mapped_column(String(16), nullable=False)
    affected_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    detail: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    user: Mapped[Optional["User"]] = relationship("User", back_populates="activity_logs")


# ── UserWizardConfig ──────────────────────────────────────────

class UserWizardConfig(Base):
    """Persistent wizard configuration — supplements data spread across budgets/scenarios."""

    __tablename__ = "user_wizard_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True, index=True
    )
    fiscal_year_type: Mapped[str] = mapped_column(String(20), default="calendar")
    monthly_income_target: Mapped[float] = mapped_column(Float, default=0.0)
    fixed_monthly_expenses: Mapped[float] = mapped_column(Float, default=0.0)
    target_savings_percentage: Mapped[float] = mapped_column(Float, default=15.0)
    retirement_age_target: Mapped[int] = mapped_column(Integer, default=67)
    current_age: Mapped[int] = mapped_column(Integer, default=28)
    category_weights: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON
    peer_group_comparison_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    peer_group_age_range_start: Mapped[int] = mapped_column(Integer, default=25)
    peer_group_age_range_end: Mapped[int] = mapped_column(Integer, default=35)
    use_peer_group_defaults: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


# ── PeerGroupBenchmark ────────────────────────────────────────

class PeerGroupBenchmark(Base):
    """Swiss peer-group spending benchmarks, seeded from migration 007."""

    __tablename__ = "peer_group_benchmarks"
    __table_args__ = (
        UniqueConstraint("age_range_start", "age_range_end", "household_type", name="uq_pgb_range_household"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    age_range_start: Mapped[int] = mapped_column(Integer, nullable=False)
    age_range_end: Mapped[int] = mapped_column(Integer, nullable=False)
    household_type: Mapped[str] = mapped_column(String(30), nullable=False, default="single")
    median_income_monthly: Mapped[float] = mapped_column(Float, default=0.0)
    p25_income_monthly: Mapped[float] = mapped_column(Float, default=0.0)
    p75_income_monthly: Mapped[float] = mapped_column(Float, default=0.0)
    housing_avg: Mapped[float] = mapped_column(Float, default=0.0)
    food_avg: Mapped[float] = mapped_column(Float, default=0.0)
    transport_avg: Mapped[float] = mapped_column(Float, default=0.0)
    insurance_avg: Mapped[float] = mapped_column(Float, default=0.0)
    health_avg: Mapped[float] = mapped_column(Float, default=0.0)
    leisure_avg: Mapped[float] = mapped_column(Float, default=0.0)
    savings_rate_pct: Mapped[float] = mapped_column(Float, default=15.0)
    peer_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
