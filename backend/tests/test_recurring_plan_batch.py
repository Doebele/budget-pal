"""
Budget-Pal — Massenaenderungen am Budgetplan.

"Monat leeren" lief bisher als Schleife aus Einzelaufrufen im Browser: pro
Eintrag erst die Ersatzzeilen anlegen, dann das Original loeschen. Brach die
Schleife in der Mitte ab — Netzfehler, geschlossener Tab —, blieb der Plan
halb umgebaut zurueck. Diese Tests halten fest, dass der Batch-Endpunkt
entweder alles anwendet oder nichts.
"""

from datetime import date

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import RecurringPlan, User

pytestmark = pytest.mark.anyio

URL = "/api/recurring-plan/batch"


def _plan(user_id: int, description: str, amount: float = -50.0) -> RecurringPlan:
    return RecurringPlan(
        user_id=user_id,
        description=description,
        amount=amount,
        periodicity="monthly",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 12, 31),
        is_future=True,
    )


@pytest_asyncio.fixture
async def rows(db_session: AsyncSession, test_user: User) -> list[RecurringPlan]:
    """Drei eigene Planzeilen."""
    created = [_plan(test_user.id, name) for name in ("Netflix", "Spotify", "Miete")]
    db_session.add_all(created)
    await db_session.commit()
    return created


async def _ids_of(db_session: AsyncSession, user_id: int) -> set[int]:
    result = await db_session.execute(
        select(RecurringPlan.id).where(RecurringPlan.user_id == user_id)
    )
    return set(result.scalars().all())


class TestBatch:
    async def test_create_and_delete_apply_together(self, client, rows, db_session, test_user):
        """Der Fall "Monat leeren": Ersatzzeile anlegen, Original loeschen."""
        response = client.post(URL, json={
            "create": [{
                "description": "Netflix",
                "amount": -18.0,
                "periodicity": "monthly",
                "start_date": "2026-02-01",
                "end_date": "2026-12-31",
            }],
            "delete": [rows[0].id],
        })
        assert response.status_code == 200, response.text
        assert response.json() == {"created": 1, "updated": 0, "deleted": 1}

        remaining = await _ids_of(db_session, test_user.id)
        assert rows[0].id not in remaining
        assert len(remaining) == 3  # zwei alte plus die neue

    async def test_bulk_update_changes_every_row(self, client, rows, db_session):
        """Massen-Kategorisierung und Teuerungsaufschlag laufen ueber denselben Weg."""
        response = client.post(URL, json={
            "update": [
                {"id": rows[0].id, "amount": -19.8},
                {"id": rows[1].id, "amount": -11.0},
            ],
        })
        assert response.status_code == 200, response.text
        assert response.json()["updated"] == 2

        await db_session.refresh(rows[0])
        await db_session.refresh(rows[1])
        await db_session.refresh(rows[2])
        assert rows[0].amount == pytest.approx(-19.8)
        assert rows[1].amount == pytest.approx(-11.0)
        assert rows[2].amount == pytest.approx(-50.0)  # nicht angefasst

    async def test_unknown_id_leaves_everything_untouched(self, client, rows, db_session, test_user):
        """Der Kern: eine unbekannte ID darf nicht den halben Rest anwenden."""
        before = await _ids_of(db_session, test_user.id)

        response = client.post(URL, json={
            "create": [{
                "description": "Darf nicht entstehen",
                "amount": -1.0,
                "periodicity": "monthly",
                "start_date": "2026-01-01",
            }],
            "delete": [rows[0].id, 999_999],
        })
        assert response.status_code == 404

        assert await _ids_of(db_session, test_user.id) == before

    async def test_foreign_entry_is_not_reachable(
        self, client, db_session, test_user_2, test_user
    ):
        """Fremde Zeilen sind unbekannt, nicht "verboten" — sie existieren fuer
        diesen Nutzer schlicht nicht."""
        foreign = _plan(test_user_2.id, "Fremde Zeile")
        db_session.add(foreign)
        await db_session.commit()

        response = client.post(URL, json={"delete": [foreign.id]})
        assert response.status_code == 404

        await db_session.refresh(foreign)
        assert foreign.user_id == test_user_2.id

    async def test_empty_batch_is_a_no_op(self, client):
        response = client.post(URL, json={})
        assert response.status_code == 200
        assert response.json() == {"created": 0, "updated": 0, "deleted": 0}

    async def test_oversized_batch_is_rejected(self, client):
        """Unbegrenzte Listen an einer Vertrauensgrenze sind ein Hebel."""
        response = client.post(URL, json={"delete": list(range(1, 502))})
        assert response.status_code == 422
