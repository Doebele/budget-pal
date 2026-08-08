"""
Budget-Pal Backend — Schreibvorgaenge muessen die Anfrage ueberleben

Hintergrund: mehrere Endpunkte riefen nur `db.flush()` auf, nie `db.commit()`.
`get_db()` committet bewusst nicht, und beim Schliessen der Session wird eine
offene Transaktion zurueckgerollt — die Antwort meldete 200 mit dem neuen Wert,
gespeichert wurde nichts.

Die uebrige Testsuite konnte das nicht sehen: dort teilen sich Request und
Nachpruefung EINE Session, in der ein `flush()` sichtbar ist. Diese Tests
oeffnen deshalb bewusst pro Request eine eigene Session — so wie in Produktion —
und pruefen danach ueber eine FRISCHE Session, was tatsaechlich in der Datenbank
steht.
"""

from datetime import datetime, timezone

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.database import Base, get_db
from app.core.security import create_access_token
from app.models.models import Account, AccountType, Transaction, User


@pytest_asyncio.fixture
async def isolated(tmp_path, app):
    """App mit echtem Session-Lebenszyklus auf einer Datei-DB.

    Datei statt :memory:, weil jede Session sonst ihre eigene leere Datenbank
    bekaeme und der Test nichts beweisen wuerde.
    """
    url = f"sqlite+aiosqlite:///{tmp_path}/persist.db"
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with Factory() as session:
        user = User(email="persist@test.local", hashed_password="x", name="P")
        session.add(user)
        await session.flush()
        account = Account(
            user_id=user.id, name="K", bank="B", currency="CHF", balance=0.0,
            account_type=AccountType.checking,
        )
        session.add(account)
        await session.flush()
        txn = Transaction(
            account_id=account.id,
            date=datetime(2026, 3, 1, tzinfo=timezone.utc),
            description="Zeitung Abo",
            amount=-4.50,
            currency="CHF",
        )
        session.add(txn)
        await session.commit()
        ids = (user.id, account.id, txn.id)

    async def per_request_session():
        async with Factory() as session:
            yield session

    app.dependency_overrides[get_db] = per_request_session
    with TestClient(app, raise_server_exceptions=False) as client:
        client.headers["Authorization"] = f"Bearer {create_access_token(str(ids[0]))}"
        yield client, Factory, ids
    app.dependency_overrides.clear()
    await engine.dispose()


async def stored_transaction(Factory, txn_id) -> Transaction:
    """Aus einer FRISCHEN Session lesen — nur so sieht man, was committet wurde."""
    async with Factory() as session:
        return (
            await session.execute(select(Transaction).where(Transaction.id == txn_id))
        ).scalar_one()


class TestUpdatePersists:
    async def test_periodicity_survives_the_request(self, isolated):
        client, Factory, (_, _, txn_id) = isolated

        response = client.put(
            f"/api/transactions/{txn_id}",
            json={"is_recurring": True, "periodicity": "weekly"},
        )
        assert response.status_code == 200
        assert response.json()["periodicity"] == "weekly"

        stored = await stored_transaction(Factory, txn_id)
        assert stored.periodicity == "weekly"
        assert stored.is_recurring is True

    @pytest.mark.parametrize(
        "value", ["weekly", "monthly", "quarterly", "halfyearly", "yearly"]
    )
    async def test_every_periodicity_persists(self, isolated, value):
        client, Factory, (_, _, txn_id) = isolated
        client.put(
            f"/api/transactions/{txn_id}",
            json={"is_recurring": True, "periodicity": value},
        )
        assert (await stored_transaction(Factory, txn_id)).periodicity == value

    async def test_category_persists(self, isolated):
        client, Factory, (_, _, txn_id) = isolated
        client.put(f"/api/transactions/{txn_id}", json={"category": "Lebensmittel"})
        stored = await stored_transaction(Factory, txn_id)
        assert stored.category == "Lebensmittel"
        # Kategorie setzen markiert die Buchung als vom Nutzer bestaetigt
        assert stored.user_verified is True


class TestCreatePersists:
    async def test_new_transaction_is_stored(self, isolated):
        client, Factory, (_, account_id, _) = isolated

        response = client.post(
            "/api/transactions",
            json={
                "account_id": account_id,
                "date": "2026-04-01T00:00:00Z",
                "description": "Neue Buchung",
                "amount": -10.0,
            },
        )
        assert response.status_code in (200, 201)
        new_id = response.json()["id"]

        stored = await stored_transaction(Factory, new_id)
        assert stored.description == "Neue Buchung"


class TestBulkCategorizePersists:
    async def test_bulk_result_is_stored(self, isolated):
        client, Factory, (_, _, txn_id) = isolated

        response = client.post(
            "/api/transactions/bulk-categorize",
            json={"transaction_ids": [txn_id], "force_recategorize": True},
        )
        assert response.status_code == 200
        assert response.json()["updated"] == 1

        assert (await stored_transaction(Factory, txn_id)).category is not None
