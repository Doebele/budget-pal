"""
Budget-Pal — Plan-Ist-Abgleich.

Vor diesem Endpunkt gab es keine Verknüpfung zwischen einer Planzeile und der
tatsächlichen Buchung: der Budgetplan wusste nie, ob eine geplante Zahlung
auch angekommen ist. Für `recurring_plan.py` insgesamt gab es zudem keine
einzige Testzeile.
"""

from datetime import date, datetime, timezone

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.database import Base, get_db
from app.core.security import create_access_token
from app.models.models import Account, AccountType, RecurringPlan, Transaction, User

pytestmark = pytest.mark.anyio

#: Jahre relativ zu heute statt fester Zahlen — sonst kippt der Test mit dem
#: Kalender: "Dezember liegt in der Zukunft" gilt nur bis Ende dieses Jahres.
PAST_YEAR = date.today().year - 1
FUTURE_YEAR = date.today().year + 1
YEAR = PAST_YEAR


@pytest_asyncio.fixture
async def seeded(tmp_path, app):
    """Ein Plan mit vier Zeilen und passenden bzw. fehlenden Buchungen."""
    url = f"sqlite+aiosqlite:///{tmp_path}/recon.db"
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with Factory() as session:
        user = User(email="recon@test.local", hashed_password="x", name="R")
        session.add(user)
        await session.flush()
        account = Account(
            user_id=user.id, name="K", bank="B", currency="CHF", balance=0.0,
            account_type=AccountType.checking,
        )
        session.add(account)
        await session.flush()

        session.add_all([
            # gebucht — Betrag passt
            RecurringPlan(
                user_id=user.id, description="Netflix", amount=-18.0,
                periodicity="monthly", start_date=date(YEAR, 1, 1),
                end_date=date(YEAR, 1, 31), is_future=True,
            ),
            # gebucht, aber Betrag weicht deutlich ab
            RecurringPlan(
                user_id=user.id, description="Fitnessabo", amount=-80.0,
                periodicity="monthly", start_date=date(YEAR, 1, 1),
                end_date=date(YEAR, 1, 31), is_future=True,
            ),
            # nie gebucht, Monate liegen in der Vergangenheit. Laeuft ueber das
            # ganze Jahr, damit der Monatsfilter etwas zu filtern hat.
            RecurringPlan(
                user_id=user.id, description="Zeitungsabo", amount=-25.0,
                periodicity="quarterly", start_date=date(YEAR, 1, 1),
                end_date=date(YEAR, 12, 31), is_future=True,
            ),
            # nie gebucht, liegt sicher in der Zukunft
            RecurringPlan(
                user_id=user.id, description="Versicherung", amount=-300.0,
                periodicity="yearly", start_date=date(FUTURE_YEAR, 1, 1),
                end_date=date(FUTURE_YEAR, 1, 31), is_future=True,
            ),
        ])
        session.add_all([
            Transaction(
                account_id=account.id, date=datetime(YEAR, 1, 5, tzinfo=timezone.utc),
                description="NETFLIX.COM", amount=-18.0, currency="CHF",
            ),
            Transaction(
                account_id=account.id, date=datetime(YEAR, 1, 8, tzinfo=timezone.utc),
                description="Fitnessabo", amount=-140.0, currency="CHF",
            ),
        ])
        await session.commit()
        uid = user.id

    async def per_request_session():
        async with Factory() as session:
            yield session

    app.dependency_overrides[get_db] = per_request_session
    with TestClient(app, raise_server_exceptions=False) as client:
        client.headers["Authorization"] = f"Bearer {create_access_token(str(uid))}"
        yield client
    app.dependency_overrides.clear()
    await engine.dispose()


def _by_description(payload: dict) -> dict:
    return {e["description"]: e for e in payload["entries"]}


class TestReconciliation:
    def test_matching_transaction_marks_the_entry_booked(self, seeded):
        """Der Buchungstext lautet "NETFLIX.COM", die Planzeile "Netflix" —
        der Abgleich nutzt dieselbe Fuzzy-Logik wie die Duplikaterkennung."""
        r = seeded.get(f"/api/recurring-plan/reconciliation?year={YEAR}&month=1")
        assert r.status_code == 200, r.text
        entry = _by_description(r.json())["Netflix"]
        assert entry["status"] == "booked"
        assert entry["actual"] == pytest.approx(-18.0)
        assert len(entry["matched_transaction_ids"]) == 1

    def test_amount_outside_tolerance_is_deviating(self, seeded):
        entry = _by_description(
            seeded.get(f"/api/recurring-plan/reconciliation?year={YEAR}&month=1").json()
        )["Fitnessabo"]
        assert entry["status"] == "deviating"
        assert entry["expected"] == pytest.approx(-80.0)
        assert entry["actual"] == pytest.approx(-140.0)

    def test_past_month_without_booking_is_overdue(self, seeded):
        entry = _by_description(
            seeded.get(f"/api/recurring-plan/reconciliation?year={YEAR}&month=1").json()
        )["Zeitungsabo"]
        assert entry["status"] == "overdue"
        assert entry["actual"] is None

    def test_future_month_without_booking_is_open(self, seeded):
        entry = _by_description(
            seeded.get(
                f"/api/recurring-plan/reconciliation?year={FUTURE_YEAR}&month=1"
            ).json()
        )["Versicherung"]
        assert entry["status"] == "open"

    def test_counts_add_up(self, seeded):
        payload = seeded.get(f"/api/recurring-plan/reconciliation?year={YEAR}").json()
        total = (
            payload["booked_count"] + payload["open_count"]
            + payload["overdue_count"] + payload["deviating_count"]
        )
        assert total == len(payload["entries"])

    def test_a_transaction_is_claimed_only_once(self, seeded):
        """Sonst wuerde eine Buchung mehrere Planzeilen gleichzeitig als
        erfuellt melden."""
        payload = seeded.get(f"/api/recurring-plan/reconciliation?year={YEAR}").json()
        claimed = [
            tid for e in payload["entries"] for tid in e["matched_transaction_ids"]
        ]
        assert len(claimed) == len(set(claimed))

    def test_month_filter_narrows_the_result(self, seeded):
        full = seeded.get(f"/api/recurring-plan/reconciliation?year={YEAR}").json()
        january = seeded.get(
            f"/api/recurring-plan/reconciliation?year={YEAR}&month=1"
        ).json()
        assert len(january["entries"]) < len(full["entries"])
        assert all(e["month"] == 1 for e in january["entries"])
