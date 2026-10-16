"""Kontoüberträge zwischen eigenen Konten: Erkennung und API."""
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from app.models.models import Account, AccountType, Transaction
from app.services.transfer_matching import find_transfer_pairs

RATES = {"EUR": 1.0, "CHF": 0.93, "USD": 1.08}  # EUR-Basis: 1 EUR = 0.93 CHF
DAY = datetime(2026, 3, 31, tzinfo=timezone.utc)
_ids = iter(range(1, 10_000))


def txn(account_id, amount, currency="CHF", description="Zahlung", days=0, **kw):
    kw.setdefault("is_deleted", False)
    kw.setdefault("is_split", False)
    kw.setdefault("transfer_rejected", False)
    kw.setdefault("user_verified", False)
    return Transaction(
        id=next(_ids), account_id=account_id, amount=amount, currency=currency,
        description=description, date=DAY + timedelta(days=days), **kw,
    )


def ids(pairs):
    return [(o.id, i.id) for o, i in pairs]


class TestFindPairs:
    def test_same_currency_same_day(self):
        out, inc = txn(1, -3000, description="UEBERTRAG"), txn(2, 3000, description="Gutschrift")
        assert ids(find_transfer_pairs([out, inc], RATES)) == [(out.id, inc.id)]

    def test_cross_currency_at_todays_rate(self):
        """UBS CHF −1'847.95 → Comdirect +2'000 EUR (0.924 CHF/EUR, Kurs heute 0.93)."""
        out = txn(1, -1847.95, description="CLAUSMEDVESEK Dauerauftrag")
        inc = txn(2, 2000, currency="EUR", description="Übertrag / MONATSZAHLUNG", days=1)
        assert ids(find_transfer_pairs([out, inc], RATES)) == [(out.id, inc.id)]

    def test_cross_currency_needs_a_hint(self):
        out = txn(1, -1847.95, description="Migros")
        inc = txn(2, 2000, currency="EUR", description="Rückerstattung")
        assert find_transfer_pairs([out, inc], RATES) == []

    def test_cross_currency_needs_hints_on_both_sides(self):
        """Echter Fall: Krankenkasse −957.40 CHF neben einem N26-Eingang 1'000 EUR."""
        out = txn(1, -957.40, description="CSSKranken-VersicherungAG")
        inc = txn(2, 1000, currency="EUR", description="Claus Medvesek", category="Kontoübertrag", days=2)
        assert find_transfer_pairs([out, inc], RATES) == []

    def test_bank_original_amount_matches_exactly(self):
        out = txn(1, -1900, description="Zahlung", original_amount=-2000, original_currency="EUR")
        inc = txn(2, 2000, currency="EUR", description="Eingang", days=2)
        assert ids(find_transfer_pairs([out, inc], RATES)) == [(out.id, inc.id)]

    def test_rate_too_far_off(self):
        out = txn(1, -1500, description="Übertrag")
        inc = txn(2, 2000, currency="EUR", description="Übertrag")
        assert find_transfer_pairs([out, inc], RATES) == []

    def test_too_many_days_apart(self):
        out, inc = txn(1, -500, description="Übertrag"), txn(2, 500, description="Übertrag", days=6)
        assert find_transfer_pairs([out, inc], RATES) == []

    def test_equal_refund_on_another_day_is_no_transfer(self):
        out, inc = txn(1, -80, description="Coop"), txn(2, 80, description="Gutschrift Zalando", days=2)
        assert find_transfer_pairs([out, inc], RATES) == []

    def test_each_booking_pairs_once_closest_day_wins(self):
        out = txn(1, -1000, description="Übertrag")
        far, near = txn(2, 1000, description="Übertrag", days=3), txn(3, 1000, description="Übertrag", days=1)
        assert ids(find_transfer_pairs([out, far, near], RATES)) == [(out.id, near.id)]

    def test_user_decisions_are_kept(self):
        out = txn(1, -3000, description="Übertrag")
        verified = txn(2, 3000, description="Lohn", user_verified=True, category="Gehalt")
        rejected = txn(3, 3000, description="Übertrag", transfer_rejected=True)
        assert find_transfer_pairs([out, verified, rejected], RATES) == []

    def test_revolut_exchange_at_the_rate_of_the_day(self):
        """EUR → USD im April zu 1.1746; der heutige Kurs (1.08) läge 8 % daneben."""
        out = txn(1, -500, currency="EUR", description="Umgetauscht in USD")
        inc = txn(2, 587.32, currency="USD", description="Umgetauscht in USD")
        assert find_transfer_pairs([out, inc], RATES) == []
        series = {DAY.date().isoformat(): {"EUR": 1.0, "USD": 1.1746, "CHF": 0.93}}
        assert ids(find_transfer_pairs([out, inc], RATES, series)) == [(out.id, inc.id)]

    def test_credit_card_bill_pairs_with_the_lsv_payment_on_the_card(self):
        """UBS: Lastschrift auf dem Lohnkonto, LSV-Zahlung zwei Tage später auf dem Kartenkonto."""
        bill = txn(1, -1337.65, description="UBSSwitzerlandAG ECA02WIDERSPRUCHANUBSINNERT30 TAGEN;Lastschrift")
        paid = txn(2, 1337.65, description="LSV-Zahlung vom 26.02.2026", days=2)
        assert ids(find_transfer_pairs([bill, paid], RATES)) == [(bill.id, paid.id)]

    def test_visa_statement_in_the_same_report_a_day_apart(self):
        """Comdirect: Giro bucht die Summe, der Visa-Teil desselben Berichts den Ausgleich."""
        out = txn(4, -148.49, currency="EUR", description="Summe Monatsabrechnung Visa-Karte", days=1)
        inc = txn(4, 148.49, currency="EUR", description="Visa-Kartenabrechnung")
        assert ids(find_transfer_pairs([out, inc], RATES)) == [(out.id, inc.id)]

    def test_fund_purchase_is_no_mirror_of_a_deposit(self):
        """Revolut: Kauf eines Geldmarktfonds und eine gleich hohe Einzahlung am selben Tag."""
        out = txn(9, -2000, currency="EUR", description="An EUR Flexibler Geldmarktfonds (Transfer)")
        inc = txn(9, 2000, currency="EUR", description="Zahlung von CLAUS MEDVESEK (Einzahlung)")
        assert find_transfer_pairs([out, inc], RATES) == []

    def test_two_different_transfers_in_one_account_are_no_pair(self):
        out = txn(4, -2000, currency="EUR", description="Übertrag/ ClausMedvesek LohnMai")
        inc = txn(4, 2000, currency="EUR", description="Übertrag/ ClausPeterMedvesek MONATSZAHLUNG", days=2)
        assert find_transfer_pairs([out, inc], RATES) == []

    def test_cash_withdrawal_is_never_a_transfer(self):
        out = txn(5, -500, currency="EUR", description="COMMERZBANK ATM", category="Kontoübertrag")
        inc = txn(9, 500, currency="EUR", description="Von EUR Flexibler Geldmarktfonds", days=1)
        assert find_transfer_pairs([out, inc], RATES) == []

    def test_mirror_rows_in_one_account(self):
        """Comdirect: Übertrag aufs Tagesgeld steht im selben Auszug als − und +."""
        out = txn(4, -1400, currency="EUR", description="Uebertrag auf Girokonto")
        inc = txn(4, 1400, currency="EUR", description="Uebertrag auf Girokonto")
        assert ids(find_transfer_pairs([out, inc], RATES)) == [(out.id, inc.id)]


@pytest.fixture
async def second_account(db_session, test_user):
    acc = Account(user_id=test_user.id, name="Comdirect", bank="Commerzbank", currency="EUR",
                  balance=0, account_type=AccountType.checking, is_active=True)
    db_session.add(acc)
    await db_session.flush()
    return acc


def _post(client, account_id, amount, currency, description):
    r = client.post("/api/transactions", json={
        "account_id": account_id, "date": DAY.isoformat(), "description": description,
        "amount": amount, "currency": currency,
    })
    assert r.status_code == 201
    return r.json()["id"]


class TestApi:
    def test_match_excludes_from_stats_and_unlink_sticks(self, client, test_account, second_account):
        with patch("app.api.transactions.currency_service.get_rates", new=AsyncMock(return_value=RATES)), \
                patch("app.services.transfer_matching.get_rate_series", new=AsyncMock(return_value={})):
            out = _post(client, test_account.id, -1847.95, "CHF", "CLAUSMEDVESEK Dauerauftrag")
            inc = _post(client, second_account.id, 2000, "EUR", "MONATSZAHLUNG Übertrag")
            _post(client, test_account.id, -50, "CHF", "Migros")

            assert client.post("/api/transactions/match-transfers").json() == {"pairs": 1}
            rows = {t["id"]: t for t in client.get("/api/transactions").json()}
            assert rows[out]["is_transfer"] and rows[out]["transfer_pair_id"] == inc
            assert rows[out]["transfer_account_name"] == "Comdirect"
            assert rows[inc]["category"] == "Kontoübertrag"

            stats = client.get("/api/transactions/stats").json()
            assert stats["total_income"] == 0 and stats["transaction_count"] == 1

            # Paar auflösen: beide Seiten zählen wieder und bleiben getrennt
            assert client.put(f"/api/transactions/{out}", json={"is_transfer": False}).status_code == 200
            rows = {t["id"]: t for t in client.get("/api/transactions").json()}
            assert not rows[out]["is_transfer"] and not rows[inc]["is_transfer"]
            assert client.post("/api/transactions/match-transfers").json() == {"pairs": 0}

    def test_deleting_one_side_releases_the_other(self, client, test_account, second_account):
        with patch("app.api.transactions.currency_service.get_rates", new=AsyncMock(return_value=RATES)), \
                patch("app.services.transfer_matching.get_rate_series", new=AsyncMock(return_value={})):
            out = _post(client, test_account.id, -500, "CHF", "Übertrag")
            inc = _post(client, test_account.id, 500, "CHF", "Übertrag")
            client.post("/api/transactions/match-transfers")
            assert client.delete(f"/api/transactions/{out}").status_code == 204
            client.post("/api/transactions/match-transfers")
            rows = {t["id"]: t for t in client.get("/api/transactions").json()}
            assert rows[inc]["is_transfer"] is False and rows[inc]["transfer_pair_id"] is None


def test_ubs_card_parser_keeps_the_lsv_payment_as_transfer():
    from types import SimpleNamespace

    from app.services.import_parsers.ubs_creditcard_pdf import parse_ubs_creditcard_pdf

    text = "16.02.2026 F und F Kantine Zuerich 18.00\n27.02.2026 LSV-Zahlung vom 26.02.2026 -1'337.65\n"
    pdf = SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda: text)])
    rows = parse_ubs_creditcard_pdf(pdf)
    lsv = [r for r in rows if r["description"].startswith("LSV")]
    assert lsv == [{"date": "2026-02-27", "description": "LSV-Zahlung vom 26.02.2026", "amount": 1337.65,
                    "currency": "CHF", "category": "Kontoübertrag", "notes": "Kartenrechnung beglichen"}]
    assert any(r["amount"] == -18.0 for r in rows)
