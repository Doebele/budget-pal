"""
Budget-Pal — anonymer Beispiel-Datensatz.

Der Datensatz ist die Vorfuehrung der App: wer ihm nicht traut, gibt ihr
keine echten Kontoauszuege. Er muss also in sich stimmen — und bei jedem
Aufruf gleich aussehen, sonst zeigt eine Demo zweimal andere Zahlen.
"""

from datetime import date

import pytest

from app.services.demo_data import (
    DEMO_ENTRIES,
    build_demo_transactions,
    demo_closing_balance,
)

TODAY = date(2026, 6, 15)


class TestBuildDemoTransactions:
    def test_same_seed_gives_the_same_data(self):
        """Ohne festen Startwert zeigt dieselbe Vorfuehrung zweimal
        verschiedene Zahlen."""
        a = build_demo_transactions(today=TODAY)
        b = build_demo_transactions(today=TODAY)
        assert [r["amount"] for r in a] == [r["amount"] for r in b]
        assert [r["description"] for r in a] == [r["description"] for r in b]

    def test_covers_roughly_a_year(self):
        rows = build_demo_transactions(today=TODAY)
        months = {(r["date"].year, r["date"].month) for r in rows}
        assert len(months) == 12

    def test_never_books_into_the_future(self):
        """Eine Buchung von morgen entlarvt den Datensatz sofort."""
        rows = build_demo_transactions(today=TODAY)
        assert all(r["date"].date() <= TODAY for r in rows)

    def test_has_income_and_expenses(self):
        rows = build_demo_transactions(today=TODAY)
        assert any(r["amount"] > 0 for r in rows)
        assert any(r["amount"] < 0 for r in rows)

    def test_household_saves_something(self):
        """Ein Haushalt, der jeden Monat ins Minus laeuft, taugt nicht als
        Beispiel fuer eine Finanzplanung."""
        rows = build_demo_transactions(today=TODAY)
        assert sum(r["amount"] for r in rows) > 0

    def test_every_row_carries_a_category(self):
        """Unkategorisierte Buchungen liessen die Auswertungen leer wirken."""
        rows = build_demo_transactions(today=TODAY)
        assert all(r["category"] for r in rows)

    def test_categories_exist_in_the_taxonomy(self):
        """Ein erfundener Kategoriename landet stumm unter "Sonstiges"."""
        import json
        from pathlib import Path

        for candidate in (Path("/shared/taxonomy.json"), Path("shared/taxonomy.json")):
            if candidate.exists():
                taxonomy = json.loads(candidate.read_text())
                break
        else:
            pytest.skip("taxonomy.json nicht gefunden")

        known = {
            name.strip().lower()
            for sc in taxonomy["superCategories"]
            for name in sc["txnCategories"]
        }
        used = {r["category"].strip().lower() for r in build_demo_transactions(today=TODAY)}
        assert used <= known, f"unbekannt: {sorted(used - known)}"

    def test_month_end_entries_survive_short_months(self):
        """Der 28. im Februar, der 31. gibt es nicht ueberall."""
        rows = build_demo_transactions(today=date(2026, 3, 1), months=3)
        assert rows  # keine Exception, keine leeren Monate

    def test_fixed_entries_repeat_every_month(self):
        rows = build_demo_transactions(today=TODAY)
        rent = [r for r in rows if r["description"] == "Mietzins Wohnung"]
        assert len(rent) == 12
        assert all(r["amount"] == rent[0]["amount"] for r in rent)

    def test_variable_entries_actually_vary(self):
        rows = build_demo_transactions(today=TODAY)
        groceries = [r["amount"] for r in rows if r["category"] == "Lebensmittel"]
        assert len(set(groceries)) > 1

    def test_bonus_lands_only_in_its_month(self):
        rows = build_demo_transactions(today=TODAY)
        bonus = [r for r in rows if r["description"] == "Bonuszahlung"]
        assert {r["date"].month for r in bonus} == {3}


class TestClosingBalance:
    def test_balance_matches_the_bookings(self):
        """Ein Kontostand, der nicht zu den Buchungen passt, faellt in der
        ersten Auswertung auf."""
        rows = build_demo_transactions(today=TODAY)
        assert demo_closing_balance(rows, opening=1_000.0) == pytest.approx(
            1_000.0 + sum(r["amount"] for r in rows), abs=0.01
        )


class TestEntryDefinitions:
    def test_no_anonymous_entry_names_a_real_company(self):
        """Der Datensatz ist erfunden — echte Marken hier waeren eine
        stillschweigende Aussage ueber echte Preise."""
        real_brands = {"migros", "coop", "swisscom", "netflix", "spotify", "denner", "sunrise"}
        for entry in DEMO_ENTRIES:
            words = f"{entry.description} {entry.merchant}".lower()
            assert not any(b in words for b in real_brands), entry.merchant
