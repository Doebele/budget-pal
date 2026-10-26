"""Reale Angaben: Summe aller Treffer eines Zeitraums als Header der Liste."""
from datetime import datetime, timezone


def _post(client, account_id, amount, category, day=10):
    r = client.post("/api/transactions", json={
        "account_id": account_id, "description": category, "amount": amount,
        "date": datetime(2026, 3, day, tzinfo=timezone.utc).isoformat(),
        "currency": "CHF", "category": category,
    })
    assert r.status_code == 201
    return r.json()["id"]


def test_totals_follow_the_list_filters_and_skip_ignored(client, test_account):
    _post(client, test_account.id, -120, "Lebensmittel")
    _post(client, test_account.id, -80, "Lebensmittel")
    _post(client, test_account.id, 15, "Lebensmittel")  # Rueckerstattung
    _post(client, test_account.id, -50, "Lebensmittel", day=20)
    skip = _post(client, test_account.id, -900, "Lebensmittel")
    client.put(f"/api/transactions/{skip}", json={"is_ignored": True})
    _post(client, test_account.id, 5000, "Gehalt")

    r = client.get("/api/transactions", params={
        "category": "Lebensmittel", "start": "2026-03-01", "end": "2026-03-15", "limit": 1,
    })
    # Summe ueber alle Treffer, nicht nur die eine geladene Zeile
    assert (r.headers["x-total-in"], r.headers["x-total-out"]) == ("15.00", "-200.00")
    assert r.headers["x-total-count"] == "4"  # die ignorierte bleibt in der Liste

    nxt = client.get("/api/transactions", params={"cursor": r.headers["x-next-cursor"]})
    assert "x-total-in" not in nxt.headers
