"""Budgetanalyse: Investitionen getrennt von Ausgaben; ignorierte Buchungen zählen nicht."""
from datetime import datetime, timezone

from app.services.categorization import CategorizationService

DAY = datetime(2026, 3, 10, tzinfo=timezone.utc).isoformat()


def _post(client, account_id, amount, description, category=None):
    r = client.post("/api/transactions", json={
        "account_id": account_id, "date": DAY, "description": description,
        "amount": amount, "currency": "CHF", "category": category,
    })
    assert r.status_code == 201
    return r.json()["id"]


def test_investments_are_neither_income_nor_expense(client, test_account):
    _post(client, test_account.id, 5000, "Lohn", "Gehalt")
    _post(client, test_account.id, -1200, "Coop", "Lebensmittel")
    _post(client, test_account.id, -3000, "Wertpapiere COREWEAVE", "Investitionen")
    _post(client, test_account.id, 500, "Von EUR Flexibler Geldmarktfonds", "Investitionen")
    stats = client.get("/api/transactions/stats").json()
    assert (stats["total_income"], stats["total_expenses"], stats["total_invested"]) == (5000, 1200, 2500)
    assert all(c["category"] != "Investitionen" for c in stats["top_categories"])


def test_ignored_booking_stays_in_the_list_but_not_in_totals(client, test_account):
    keep = _post(client, test_account.id, -80, "Migros", "Lebensmittel")
    skip = _post(client, test_account.id, -900, "Doppelt erfasst", "Lebensmittel")
    r = client.put(f"/api/transactions/{skip}", json={"is_ignored": True})
    assert r.status_code == 200 and r.json()["is_ignored"] is True
    rows = {t["id"]: t for t in client.get("/api/transactions").json()}
    assert set(rows) == {keep, skip}
    stats = client.get("/api/transactions/stats").json()
    assert (stats["total_expenses"], stats["transaction_count"]) == (80, 1)
    client.put(f"/api/transactions/{skip}", json={"is_ignored": False})
    assert client.get("/api/transactions/stats").json()["total_expenses"] == 980


def test_fund_transfers_are_categorised_as_investments():
    rule = CategorizationService()._rule_based
    assert rule("Übertrag an UBS Fondskonto")[0] == "Investitionen"
    assert rule("An EUR Flexibler Geldmarktfonds (Transfer)")[0] == "Investitionen"
    assert rule("Wertpapiere HONHAIPR.IND.SP.GDRS/1")[0] == "Investitionen"
    assert rule("Übertrag Claus Medvesek")[0] == "Kontoübertrag"
