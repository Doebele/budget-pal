"""
Budget-Pal — Onboarding-Endpunkte.

Der Weg ueber Beispieldaten ist die Vorfuehrung der App. Er muss zweimal
geklickt dasselbe ergeben und sich restlos zuruecknehmen lassen — sonst
bleibt ein erfundener Haushalt in echten Auswertungen stehen.
"""

from datetime import date, datetime, timezone

import pytest
from sqlalchemy import func as sqlfunc, select

from app.models.models import Account, AccountType, Transaction, User
from app.services.demo_data import DEMO_ACCOUNT_MARKER

pytestmark = pytest.mark.anyio


async def _account_count(db_session, user_id: int) -> int:
    return (await db_session.execute(
        select(sqlfunc.count(Account.id)).where(Account.user_id == user_id)
    )).scalar_one()


class TestDemoData:
    async def test_loading_creates_account_and_transactions(self, client, db_session, test_user):
        r = client.post("/api/onboarding/demo")
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["transactions"] > 100

        count = (await db_session.execute(
            select(sqlfunc.count(Transaction.id)).where(
                Transaction.account_id == body["account_id"]
            )
        )).scalar_one()
        assert count == body["transactions"]

    async def test_loading_twice_does_not_double_the_data(self, client, db_session, test_user):
        """Ein Doppelklick auf der Startseite haette sonst jede Zahl verdoppelt."""
        first = client.post("/api/onboarding/demo").json()
        second = client.post("/api/onboarding/demo").json()

        assert second["account_id"] == first["account_id"]
        assert second["transactions"] == first["transactions"]
        assert await _account_count(db_session, test_user.id) == 1

    async def test_balance_matches_the_bookings(self, client, db_session):
        """Ein Kontostand, der den Buchungen widerspricht, faellt sofort auf."""
        body = client.post("/api/onboarding/demo").json()
        account = (await db_session.execute(
            select(Account).where(Account.id == body["account_id"])
        )).scalar_one()
        total = (await db_session.execute(
            select(sqlfunc.sum(Transaction.amount)).where(
                Transaction.account_id == account.id
            )
        )).scalar_one()
        assert account.balance == pytest.approx(8_500.0 + total, abs=0.01)

    async def test_removal_takes_everything_with_it(self, client, db_session, test_user):
        body = client.post("/api/onboarding/demo").json()

        r = client.request("DELETE", "/api/onboarding/demo")
        assert r.status_code == 200, r.text
        assert r.json()["removed"] == body["transactions"]

        assert await _account_count(db_session, test_user.id) == 0
        left = (await db_session.execute(
            select(sqlfunc.count(Transaction.id)).where(
                Transaction.account_id == body["account_id"]
            )
        )).scalar_one()
        assert left == 0

    async def test_removal_spares_real_accounts(self, client, db_session, test_user):
        """Der Marker muss treffen, nicht der Zufall: ein echtes Konto darf
        beim Aufraeumen nicht mitgehen."""
        real = Account(
            user_id=test_user.id, name="Lohnkonto", bank="Bank", currency="CHF",
            balance=100.0, account_type=AccountType.checking,
        )
        db_session.add(real)
        await db_session.flush()
        db_session.add(Transaction(
            account_id=real.id, date=datetime(2026, 1, 5, tzinfo=timezone.utc),
            description="Echte Buchung", amount=-20.0, currency="CHF",
        ))
        await db_session.commit()

        client.post("/api/onboarding/demo")
        client.request("DELETE", "/api/onboarding/demo")

        await db_session.refresh(real)
        assert real.name == "Lohnkonto"
        left = (await db_session.execute(
            select(sqlfunc.count(Transaction.id)).where(Transaction.account_id == real.id)
        )).scalar_one()
        assert left == 1

    async def test_removing_without_demo_is_a_404(self, client):
        r = client.request("DELETE", "/api/onboarding/demo")
        assert r.status_code == 404

    async def test_demo_transactions_are_not_marked_verified(self, client, db_session):
        """`user_verified` ist Stufe 0 der Kategorisierung. Erfundene Daten
        duerfen dort nicht als bestaetigte Wahrheit landen."""
        body = client.post("/api/onboarding/demo").json()
        verified = (await db_session.execute(
            select(sqlfunc.count(Transaction.id)).where(
                Transaction.account_id == body["account_id"],
                Transaction.user_verified.is_(True),
            )
        )).scalar_one()
        assert verified == 0

    async def test_demo_account_carries_the_marker(self, client, db_session):
        body = client.post("/api/onboarding/demo").json()
        account = (await db_session.execute(
            select(Account).where(Account.id == body["account_id"])
        )).scalar_one()
        assert account.notes == DEMO_ACCOUNT_MARKER


class TestStatus:
    async def test_fresh_user_has_nothing(self, client):
        body = client.get("/api/onboarding/status").json()
        assert body["has_transactions"] is False
        assert body["completeness_pct"] == 0
        assert body["is_demo"] is False

    async def test_status_follows_the_demo(self, client):
        client.post("/api/onboarding/demo")
        body = client.get("/api/onboarding/status").json()
        assert body["has_accounts"] is True
        assert body["has_transactions"] is True
        assert body["is_demo"] is True
        assert body["transaction_count"] > 100
        assert 0 < body["completeness_pct"] < 100
