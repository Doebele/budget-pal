"""
Budget-Pal Backend — CSV-Vorschau markiert schon vorhandene Buchungen

Der CSV-Import ueberspringt Buchungen, die im Konto schon stehen. Die Vorschau
zeigte das bisher nicht; der Nutzer sah erst nach dem Import "N Duplikate
uebersprungen". Jetzt markiert sie diese Zeilen vorab — mit derselben Pruefung
wie der Import.
"""

from datetime import datetime, timezone

from app.models.models import Account, Transaction

CSV = (
    "Datum,Beschreibung,Betrag\n"
    "10.10.2026,Coop Pronto Zuerich,-12.50\n"
    "11.10.2026,SBB Ticket Bern,-34.00\n"
).encode()


def _preview(client, account_id):
    return client.post(
        "/api/imports/preview",
        files={"file": ("auszug.csv", CSV, "text/csv")},
        data={"account_id": str(account_id), "bank": "revolut"},
    ).json()


def test_existing_booking_is_marked(client, test_account):
    client.post("/api/transactions", json={
        "account_id": test_account.id, "date": "2026-10-10T00:00:00",
        "description": "Coop Pronto Zuerich", "amount": -12.5,
    })
    body = _preview(client, test_account.id)
    assert body["duplicate_rows"] == 1
    assert [r["is_duplicate"] for r in body["rows"]] == [True, False]


async def test_foreign_account_reveals_nothing(client, db_session, test_user_2):
    """account_id kommt aus dem Formular. Ohne Besitzpruefung liesse sich ein
    fremdes Konto auf vorhandene Buchungen abfragen."""
    foreign = Account(user_id=test_user_2.id, name="Fremd", bank="UBS", currency="CHF")
    db_session.add(foreign)
    await db_session.flush()
    # Passende Buchung im fremden Konto — ohne Besitzpruefung wuerde sie anschlagen
    db_session.add(Transaction(
        account_id=foreign.id, date=datetime(2026, 10, 10, tzinfo=timezone.utc),
        description="Coop Pronto Zuerich", amount=-12.5,
    ))
    await db_session.commit()
    body = _preview(client, foreign.id)
    assert body["duplicate_rows"] == 0
