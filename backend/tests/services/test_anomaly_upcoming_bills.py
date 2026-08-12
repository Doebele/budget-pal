"""
Budget-Pal — Fälligkeitswarnungen und Fremdwährung.

`plan.amount` steht in der Währung der Planzeile. Die Warnung beschriftete ihn
trotzdem fest mit "CHF": eine Miete von EUR 1'200 erschien als "CHF 1'200.00",
also rund 100 Franken zu niedrig. Für diesen Detektor gab es keine Tests.
"""

from datetime import date, timedelta

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import RecurringPlan, User
from app.services.anomaly_detector import _detect_upcoming_bills

pytestmark = pytest.mark.anyio

#: EUR-basierte Kurse wie vom Frankfurter-Dienst.
RATES = {"EUR": 1.0, "CHF": 0.95, "USD": 1.10}

TODAY = date(2026, 6, 15)


@pytest_asyncio.fixture
async def plan_in_eur(db_session: AsyncSession, test_user: User) -> RecurringPlan:
    """Eine EUR-Zeile, die in drei Tagen faellig ist."""
    entry = RecurringPlan(
        user_id=test_user.id,
        description="Miete Konstanz",
        amount=-1_200.0,
        currency="EUR",
        periodicity="monthly",
        start_date=TODAY + timedelta(days=3),
        end_date=None,
        is_future=True,
    )
    db_session.add(entry)
    await db_session.commit()
    return entry


class TestUpcomingBills:
    async def test_foreign_amount_is_converted(self, db_session, test_user, plan_in_eur):
        findings = await _detect_upcoming_bills(
            test_user.id, db_session, TODAY, "CHF", RATES
        )
        assert len(findings) == 1
        finding = findings[0]
        assert finding.currency == "CHF"
        # EUR 1'200 → CHF: 1200 / 1.0 * 0.95
        assert finding.amount == pytest.approx(1_140.0)
        assert "CHF 1,140.00" in finding.body

    async def test_reference_currency_is_respected(self, db_session, test_user, plan_in_eur):
        """Wer in USD rechnet, soll USD sehen — nicht CHF und nicht EUR."""
        findings = await _detect_upcoming_bills(
            test_user.id, db_session, TODAY, "USD", RATES
        )
        assert findings[0].currency == "USD"
        assert findings[0].amount == pytest.approx(1_320.0)

    async def test_matching_currency_is_left_alone(
        self, db_session, test_user
    ):
        entry = RecurringPlan(
            user_id=test_user.id,
            description="Krankenkasse",
            amount=-450.0,
            currency="CHF",
            periodicity="monthly",
            start_date=TODAY + timedelta(days=2),
            is_future=True,
        )
        db_session.add(entry)
        await db_session.commit()

        findings = await _detect_upcoming_bills(
            test_user.id, db_session, TODAY, "CHF", RATES
        )
        assert findings[0].amount == pytest.approx(450.0)

    async def test_bill_beyond_the_horizon_is_silent(self, db_session, test_user):
        """Nur die naechsten sieben Tage."""
        entry = RecurringPlan(
            user_id=test_user.id,
            description="Weit weg",
            amount=-100.0,
            periodicity="yearly",
            start_date=TODAY + timedelta(days=30),
            is_future=True,
        )
        db_session.add(entry)
        await db_session.commit()

        findings = await _detect_upcoming_bills(
            test_user.id, db_session, TODAY, "CHF", RATES
        )
        assert findings == []
