"""Kontostand laut Kontoauszug: Schlusssaldo lesen und übernehmen."""
from datetime import date, datetime

from app.models.models import Account
from app.services.import_parsers.ubs import UBSParser
from app.services.statement_balance import StatementBalance, apply, from_rows, from_text

RATES = {"EUR": 1.0, "CHF": 0.93, "USD": 1.08, "GBP": 0.85}

# Ausschnitte aus echten Auszügen (Beträge und Namen verändert)
COMDIRECT = """Finanzreport Nr. 6 per 01.07.2026 02.07.2026
Ihre aktuellen Salden IBAN Saldo in
Girokonto DE00 2004 1111 0000 0000 00 +6.159,33
Gesamtsaldo 01.07.2026 +420.060,95
Alter Saldo 01.06.2026 +32.385,68
Neuer Saldo 01.07.2026 +6.159,33
Tagesgeld PLUS-Konto
Neuer Saldo 01.07.2026 +665,41"""

UBS = """UBS Switzerland AG
UBS Privatkonto CHF6'106.97
IBAN CH00 0000 0000 0000 0000 A Aktueller Saldo
Erstellt am 14.10.2026
Schlusssaldo 6'106.97
14.10.2026 Schule -18'000.00 14.10.2026 6'106.97
Anfangssaldo 2'713.73"""

UBS_NO_SALDO_COLUMN = """UBS Switzerland AG
UBS Privatkonto CHF2'281.99
IBAN CH00 0000 0000 0000 0000 A Aktueller Saldo
Erstellt am 10.08.2026
Zeitraum: 01.01.2026 - 10.08.2026"""

N26 = """Bank Statement Nr. 04/2026
01.04.2026 until 30.04.2026
Previous balance +10.212,47€
Your new balance +4.017,34€
Previous balance +59,28€
Your new balance +59,28€"""

REVOLUT = """EUR-Kontoauszug
Generiert am 06.08.2026
Revolut Bank UAB
Zusammenfassung der Bilanz
Produkt Eröffnungssaldo Geldausgang Geldeingang Schlusssaldo
Konto (Girokonto) 737.21€ 10’667.53€ 11’000.00€ 1’069.68€
Gesamt 737.21€ 10’667.53€ 11’000.00€ 1’069.68€"""


class TestFromText:
    def test_comdirect_takes_the_girokonto(self):
        assert from_text(COMDIRECT) == StatementBalance(date(2026, 7, 1), 6159.33)

    def test_ubs_closing_balance(self):
        assert from_text(UBS) == StatementBalance(date(2026, 10, 14), 6106.97)

    def test_ubs_export_without_saldo_column(self):
        assert from_text(UBS_NO_SALDO_COLUMN) == StatementBalance(date(2026, 8, 10), 2281.99)

    def test_n26_main_account_at_period_end(self):
        assert from_text(N26) == StatementBalance(date(2026, 4, 30), 4017.34, "EUR")

    def test_revolut_summary_in_its_currency(self):
        assert from_text(REVOLUT) == StatementBalance(date(2026, 8, 6), 1069.68, "EUR")

    def test_unknown_text(self):
        assert from_text("Rechnung Nr. 12\nTotal 45.00") is None


class TestFromRows:
    def test_newest_row_also_when_sorted_descending(self):
        rows = [
            {"date": datetime(2026, 3, 31), "balance": 900.0},  # letzte Buchung des Tages
            {"date": datetime(2026, 3, 31), "balance": 1000.0},
            {"date": datetime(2026, 3, 1), "balance": 500.0},
        ]
        assert from_rows(rows) == [StatementBalance(date(2026, 3, 31), 900.0, None)]

    def test_one_balance_per_currency(self):
        rows = [
            {"date": datetime(2026, 1, 1), "balance": 10.0, "balance_currency": "EUR"},
            {"date": datetime(2026, 1, 2), "balance": 20.0, "balance_currency": "CHF"},
            {"date": datetime(2026, 1, 3), "balance": 15.0, "balance_currency": "EUR"},
        ]
        assert sorted(from_rows(rows)) == sorted([
            StatementBalance(date(2026, 1, 3), 15.0, "EUR"),
            StatementBalance(date(2026, 1, 2), 20.0, "CHF"),
        ])

    def test_ubs_csv_with_debit_credit_keeps_the_saldo(self):
        csv = (
            "Bewertungsdatum;Buchungsdatum;Beschreibung1;Belastung;Gutschrift;Saldo\n"
            "31.03.2026;31.03.2026;Migros;50.00;;950.00\n"
            "30.03.2026;30.03.2026;Lohn;;1000.00;1000.00\n"
        ).encode()
        txns = UBSParser().parse(csv)
        assert from_rows(txns) == [StatementBalance(date(2026, 3, 31), 950.0, None)]


def account(**kw):
    return Account(name="Konto", bank="Bank", currency=kw.pop("currency", "CHF"), balance=5000.0, **kw)


class TestApply:
    def test_newer_statement_wins_older_is_ignored(self):
        acc = account()
        assert apply(acc, StatementBalance(date(2026, 6, 1), 1200.0), RATES)
        assert not apply(acc, StatementBalance(date(2026, 5, 1), 800.0), RATES)
        assert (acc.balance, acc.balance_date) == (1200.0, date(2026, 6, 1))
        assert apply(acc, StatementBalance(date(2026, 7, 1), 1500.0), RATES)
        assert acc.balance == 1500.0

    def test_currency_pockets_add_up_in_the_account_currency(self):
        """Revolut: je Währungstasche ein Auszug; der Kontostand ist die Summe."""
        acc = account(currency="CHF")
        apply(acc, StatementBalance(date(2026, 8, 6), 840.54, "CHF"), RATES)
        apply(acc, StatementBalance(date(2026, 8, 6), 1000.0, "EUR"), RATES)
        assert acc.balance == round(840.54 + 930.0, 2)
        apply(acc, StatementBalance(date(2026, 9, 1), 900.0, "CHF"), RATES)  # nur CHF neuer
        assert acc.balance == round(900.0 + 930.0, 2)
        assert acc.balance_date == date(2026, 9, 1)

    def test_no_statement_keeps_the_manual_balance(self):
        acc = account()
        assert not apply(acc, None, RATES)
        assert acc.balance == 5000.0


class TestImportApi:
    def _csv(self, last_day, last_saldo):
        return (
            "Bewertungsdatum;Buchungsdatum;Beschreibung1;Belastung;Gutschrift;Saldo\n"
            f"{last_day};{last_day};Migros;50.00;;{last_saldo}\n"
            "02.03.2026;02.03.2026;Lohn;;1000.00;1000.00\n"
        ).encode()

    def test_newest_statement_sets_the_balance_in_any_order(self, client, test_account):
        from unittest.mock import AsyncMock, patch

        with patch("app.api.imports.currency_service.get_rates", new=AsyncMock(return_value=RATES)):
            for day, saldo in (("31.05.2026", "1450.00"), ("31.03.2026", "950.00")):
                r = client.post("/api/imports/csv",
                                files={"file": ("ubs.csv", self._csv(day, saldo), "text/csv")},
                                data={"account_id": str(test_account.id), "bank": "ubs"})
                assert r.status_code == 201
        acc = next(a for a in client.get("/api/accounts").json() if a["id"] == test_account.id)
        assert (acc["balance"], acc["balance_date"]) == (1450.0, "2026-05-31")

        # Von Hand geändert: gilt nicht mehr als «laut Auszug»
        body = {k: acc[k] for k in ("name", "bank", "currency", "account_type")} | {"balance": 2000.0}
        assert client.put(f"/api/accounts/{test_account.id}", json=body).json()["balance_date"] is None

    def test_pdf_confirm_takes_the_balance_from_the_preview(self, client, test_account):
        from unittest.mock import AsyncMock, patch

        with patch("app.api.imports.currency_service.get_rates", new=AsyncMock(return_value=RATES)):
            r = client.post("/api/imports/pdf/confirm", json={
                "account_id": test_account.id, "bank": "ubs", "rows": [],
                "statement_balance": {"date": "2026-10-14", "amount": 6106.97, "currency": None},
            })
            assert r.status_code == 201, r.text
        acc = next(a for a in client.get("/api/accounts").json() if a["id"] == test_account.id)
        assert (acc["balance"], acc["balance_date"]) == (6106.97, "2026-10-14")
