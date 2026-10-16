"""Backup-Import: Konten und Duplikate; gelöschte Konten archivieren ihre Buchungen."""
from unittest.mock import AsyncMock, patch

from app.models.models import Account, AccountType, Transaction

RATES = {"EUR": 1.0, "CHF": 0.93}


def _backup(*txns):
    return {
        "version": "1.1",
        "accounts": [{"id": 1, "name": "N26", "bank": "N26", "currency": "EUR", "account_type": "checking"}],
        "transactions": [
            {"id": 10 + i, "account_id": 1, "date": f"2026-03-{d:02d}T00:00:00+00:00", "amount": a,
             "currency": "EUR", "description": desc, "import_hash": h}
            for i, (d, a, desc, h) in enumerate(txns)
        ],
    }


def _import(client, backup):
    with patch("app.api.backup.currency_service.get_rates", new=AsyncMock(return_value=RATES)):
        r = client.post("/api/backup/import", json={"backup": backup})
    assert r.status_code == 200, r.text
    return r.json()


async def test_deleted_account_with_the_same_name_is_not_reused(client, db_session, test_user):
    old = Account(user_id=test_user.id, name="N26", bank="N26", currency="EUR",
                  account_type=AccountType.checking, is_active=False)
    db_session.add(old)
    await db_session.flush()

    _import(client, _backup((1, -20.0, "Edeka", "h1")))
    names = [a["name"] for a in client.get("/api/accounts").json()]
    assert names.count("N26") == 1  # neu angelegt und aktiv, nicht im gelöschten


def test_duplicates_are_checked_per_account_and_by_content(client, test_user):
    first = _import(client, _backup((1, -20.0, "Edeka", "h1"), (2, -5.0, "Kiosk", "h2")))
    assert first["transactions_created"] == 2
    # gleiche Buchungen mit anderem Hash (andere Installation): keine Kopie
    again = _import(client, _backup((1, -20.0, "Edeka", "x1"), (3, -9.0, "Bäcker", "x3")))
    assert (again["transactions_created"], again["transactions_skipped"]) == (1, 1)


async def test_deleting_an_account_archives_its_transactions(client, db_session, test_account):
    from datetime import datetime, timezone

    db_session.add(Transaction(account_id=test_account.id, date=datetime(2026, 3, 1, tzinfo=timezone.utc),
                               description="Migros", amount=-50.0, currency="CHF"))
    await db_session.flush()
    assert client.get("/api/transactions/stats").json()["transaction_count"] == 1
    assert client.delete(f"/api/accounts/{test_account.id}").status_code == 204
    assert client.get("/api/transactions/stats").json()["transaction_count"] == 0
    assert len(client.get("/api/transactions/archived").json()) == 1
