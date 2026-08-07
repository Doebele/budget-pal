"""
Budget-Pal Backend — Duplikaterkennung gegen die Datenbank

Der Fall, um den es geht: derselbe Kontoauszug wird ein zweites Mal importiert,
diesmal per KI-Extraktion. Der Buchungstext lautet dadurch leicht anders, also
greifen weder import_hash noch der exakte Textvergleich — ohne Stufe 3 entstünde
ein Duplikat.
"""

from datetime import datetime, timezone

import pytest

from app.models.models import Transaction
from app.services.pdf_duplicate_detection import find_database_duplicate_transaction_id


@pytest.fixture
async def stored_txn(db_session, test_account):
    """Eine Buchung, wie sie ein Parser gespeichert hätte."""
    txn = Transaction(
        account_id=test_account.id,
        date=datetime(2026, 3, 15, tzinfo=timezone.utc),
        description="KARTENZAHLUNG COOP PRONTO ZUERICH HB",
        amount=-12.50,
        currency="CHF",
        category="Lebensmittel",
        import_hash="hash-vom-parser",
    )
    db_session.add(txn)
    await db_session.flush()
    await db_session.refresh(txn)
    return txn


class TestFindDatabaseDuplicate:
    async def test_identical_hash_matches(self, db_session, test_account, stored_txn):
        found = await find_database_duplicate_transaction_id(
            db_session, test_account.id, "2026-03-15", -12.50, "egal", "hash-vom-parser"
        )
        assert found == stored_txn.id

    async def test_exact_description_matches_without_hash(
        self, db_session, test_account, stored_txn
    ):
        found = await find_database_duplicate_transaction_id(
            db_session,
            test_account.id,
            "2026-03-15",
            -12.50,
            "KARTENZAHLUNG COOP PRONTO ZUERICH HB",
            "anderer-hash",
        )
        assert found == stored_txn.id

    async def test_ai_phrasing_matches(self, db_session, test_account, stored_txn):
        """Der eigentliche Punkt: KI formuliert anders, ist aber dieselbe Buchung."""
        found = await find_database_duplicate_transaction_id(
            db_session,
            test_account.id,
            "2026-03-15",
            -12.50,
            "Kartenzahlung Coop Pronto, Zürich HB",
            "hash-von-der-ki",
        )
        assert found == stored_txn.id

    async def test_different_merchant_is_not_a_duplicate(
        self, db_session, test_account, stored_txn
    ):
        found = await find_database_duplicate_transaction_id(
            db_session, test_account.id, "2026-03-15", -12.50, "MIGROS BERN", "neu"
        )
        assert found is None

    async def test_different_day_is_not_a_duplicate(
        self, db_session, test_account, stored_txn
    ):
        found = await find_database_duplicate_transaction_id(
            db_session,
            test_account.id,
            "2026-03-16",
            -12.50,
            "KARTENZAHLUNG COOP PRONTO ZUERICH HB",
            "neu",
        )
        assert found is None

    async def test_different_amount_is_not_a_duplicate(
        self, db_session, test_account, stored_txn
    ):
        found = await find_database_duplicate_transaction_id(
            db_session,
            test_account.id,
            "2026-03-15",
            -99.00,
            "KARTENZAHLUNG COOP PRONTO ZUERICH HB",
            "neu",
        )
        assert found is None

    async def test_deleted_transactions_are_ignored(
        self, db_session, test_account, stored_txn
    ):
        stored_txn.is_deleted = True
        await db_session.flush()
        found = await find_database_duplicate_transaction_id(
            db_session, test_account.id, "2026-03-15", -12.50, "egal", "hash-vom-parser"
        )
        assert found is None

    async def test_unparseable_date_returns_none(self, db_session, test_account):
        found = await find_database_duplicate_transaction_id(
            db_session, test_account.id, "kein Datum", -12.50, "X", "kein-treffer"
        )
        assert found is None
