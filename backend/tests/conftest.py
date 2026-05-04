"""
Budget-Pal Backend — Test Fixtures

Provides:
- Test database (SQLite in-memory)
- Async test client (FastAPI TestClient)
- Test user fixtures
- Auth helpers (get test token)
"""

import asyncio
from datetime import datetime, timezone
from typing import Any, AsyncGenerator

import pytest
from app.core.config import settings
from app.core.database import Base, get_db, init_db
from app.core.security import create_access_token, hash_password
from app.models.models import Account, Category, User
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import sessionmaker

# ── Test Database ─────────────────────────────────────────────

TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"


@pytest.fixture(scope="session")
def event_loop():
    """Create a session-scoped event loop for async fixtures."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session")
async def test_engine():
    """Create an in-memory SQLite engine for the entire test session."""
    engine = create_async_engine(
        TEST_DATABASE_URL,
        echo=False,
        connect_args={"check_same_thread": False},
    )

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield engine

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

    await engine.dispose()


@pytest.fixture()
async def db_session(test_engine) -> AsyncGenerator[AsyncSession, None]:
    """Provide a transactional rollback session for each test."""
    async_session = async_sessionmaker(
        test_engine, class_=AsyncSession, expire_on_commit=False
    )

    async with async_session() as session:
        # Use savepoints for proper nesting with transactional tests
        await session.begin_nested()

        yield session

        await session.rollback()


# ── Test User ─────────────────────────────────────────────────


@pytest.fixture
async def test_user(db_session: AsyncSession) -> User:
    """Create and return a test user."""
    user = User(
        email="test@example.com",
        hashed_password=hash_password("testpassword123"),
        name="Test User",
        is_active=True,
        date_of_birth=datetime(1985, 1, 1, tzinfo=timezone.utc),
        retirement_age=65,
        currency="CHF",
        locale="de-CH",
    )
    db_session.add(user)
    await db_session.flush()
    await db_session.refresh(user)
    return user


@pytest.fixture
async def test_user_2(db_session: AsyncSession) -> User:
    """Create a second test user for multi-user tests."""
    user = User(
        email="test2@example.com",
        hashed_password=hash_password("testpassword123"),
        name="Test User 2",
        is_active=True,
        date_of_birth=datetime(1990, 6, 15, tzinfo=timezone.utc),
        retirement_age=65,
        currency="CHF",
        locale="de-CH",
    )
    db_session.add(user)
    await db_session.flush()
    await db_session.refresh(user)
    return user


# ── Test Account ──────────────────────────────────────────────


@pytest.fixture
async def test_account(db_session: AsyncSession, test_user: User) -> Account:
    """Create and return a test account."""
    from app.models.models import AccountType

    account = Account(
        user_id=test_user.id,
        name="Test Checking Account",
        bank="Test Bank",
        account_number="CH12345",
        currency="CHF",
        balance=10000.0,
        account_type=AccountType.checking,
        is_active=True,
    )
    db_session.add(account)
    await db_session.flush()
    await db_session.refresh(account)
    return account


# ── Test Category ─────────────────────────────────────────────


@pytest.fixture
async def test_category(db_session: AsyncSession, test_user: User) -> Category:
    """Create and return a test category."""
    category = Category(
        user_id=test_user.id,
        name="Food & Groceries",
        slug="food-groceries",
        color="#FF6B6B",
        icon="shopping-cart",
        is_system=False,
        sort_order=1,
    )
    db_session.add(category)
    await db_session.flush()
    await db_session.refresh(category)
    return category


# ── Auth Helpers ──────────────────────────────────────────────


@pytest.fixture
def test_token(test_user: User) -> str:
    """Generate a JWT token for the test user."""
    return create_access_token(str(test_user.id))


@pytest.fixture
def test_token_2(test_user_2: User) -> str:
    """Generate a JWT token for the second test user."""
    return create_access_token(str(test_user_2.id))


# ── Test Client ───────────────────────────────────────────────


@pytest.fixture(scope="session")
def app():
    """Get the FastAPI app instance."""
    from app.main import app as fastapi_app

    return fastapi_app


@pytest.fixture
async def client(app, db_session: AsyncSession, test_user: User) -> TestClient:
    """Provide a FastAPI TestClient with overridden DB dependency."""
    # Override the get_db dependency
    app.dependency_overrides[get_db] = lambda: db_session

    # Also override init_db to skip create_all during tests
    from unittest.mock import AsyncMock, patch

    token = create_access_token(str(test_user.id))

    with patch("app.main.init_db", new=AsyncMock()):
        with TestClient(app, raise_server_exceptions=False) as test_client:
            test_client.headers["Authorization"] = f"Bearer {token}"
            yield test_client

    app.dependency_overrides.clear()


# ── Helper Functions ──────────────────────────────────────────


def get_test_token_for_user(user: User) -> str:
    """Generate a JWT token for any given user."""
    return create_access_token(str(user.id))


def get_test_headers(token: str) -> dict:
    """Return HTTP headers with Authorization."""
    return {"Authorization": f"Bearer {token}"}


# ── Fixtures for Common Test Data ─────────────────────────────


@pytest.fixture
def sample_transaction_data() -> list[dict[str, Any]]:
    """Return sample transaction data for testing."""
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    return [
        {
            "account_id": 1,
            "date": (now - timedelta(days=i)).isoformat(),
            "description": f"Test Transaction {i}",
            "amount": -50.0 if i % 2 == 0 else 2000.0,
            "currency": "CHF",
            "category": "Food" if i % 2 == 0 else "Salary",
        }
        for i in range(10)
    ]


@pytest.fixture
def sample_pension_records() -> list[dict[str, Any]]:
    """Return sample pension records for testing projections."""
    return [
        {
            "pillar": "1",
            "current_balance": 0.0,
            "annual_contribution": 5000.0,
            "expected_return_rate": 0.0,
            "retirement_age": 65,
            "contribution_years": 30,
            "average_insured_salary": 80000.0,
        },
        {
            "pillar": "2",
            "current_balance": 150000.0,
            "annual_contribution": 8000.0,
            "expected_return_rate": 0.04,
            "retirement_age": 65,
            "contribution_years": None,
            "average_insured_salary": None,
        },
        {
            "pillar": "3a",
            "current_balance": 25000.0,
            "annual_contribution": 7056.0,
            "expected_return_rate": 0.03,
            "retirement_age": 65,
            "contribution_years": None,
            "average_insured_salary": None,
        },
    ]
