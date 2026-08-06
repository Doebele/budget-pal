"""
Budget-Pal Backend — Kategorie-Hinweise aus der eigenen Historie

Der kritische Punkt: nur vom Nutzer bestätigte Zuordnungen dürfen die
Regel-Pipeline überstimmen. Automatisch vergebene Kategorien als Beleg zu
werten würde jeden Fehlgriff zementieren.
"""

from app.services.user_history import CategoryHints


class TestLookupConfirmed:
    def test_exact_match(self):
        hints = CategoryHints(confirmed={"MIGROS": "Lebensmittel"})
        assert hints.lookup_confirmed("MIGROS") == "Lebensmittel"

    def test_case_insensitive(self):
        hints = CategoryHints(confirmed={"MIGROS": "Lebensmittel"})
        assert hints.lookup_confirmed("migros") == "Lebensmittel"

    def test_substring_match_for_noisy_booking_text(self):
        hints = CategoryHints(confirmed={"COOP PRONTO": "Lebensmittel"})
        assert hints.lookup_confirmed("COOP PRONTO ZUERICH HB 12.05") == "Lebensmittel"

    def test_longest_merchant_wins(self):
        # "COOP PRONTO" ist spezifischer als "COOP" und muss gewinnen
        hints = CategoryHints(
            confirmed={"COOP": "Lebensmittel", "COOP PRONTO": "Restaurant & Takeaway"}
        )
        assert hints.lookup_confirmed("COOP PRONTO BERN") == "Restaurant & Takeaway"

    def test_short_merchants_do_not_match_as_substring(self):
        # Ein 3-Zeichen-Händler würde sonst in fast jedem Text zufällig treffen
        hints = CategoryHints(confirmed={"SBB": "Transport"})
        assert hints.lookup_confirmed("SBB") == "Transport"
        assert hints.lookup_confirmed("PRESSBUERO LAUSANNE") is None

    def test_unconfirmed_entries_never_match(self):
        """seen speist nur den Prompt — es darf die Pipeline nicht überstimmen."""
        hints = CategoryHints(seen={"MIGROS": "Lebensmittel"})
        assert hints.lookup_confirmed("MIGROS") is None

    def test_empty_inputs(self):
        assert CategoryHints().lookup_confirmed("MIGROS") is None
        assert CategoryHints(confirmed={"X": "Y"}).lookup_confirmed("") is None


class TestPromptHelpers:
    def test_confirmed_examples_come_first(self):
        hints = CategoryHints(
            confirmed={"MIGROS": "Lebensmittel"},
            seen={"MIGROS": "Lebensmittel", "SBB": "Transport"},
        )
        assert hints.prompt_examples()[0] == ("MIGROS", "Lebensmittel")
        assert ("SBB", "Transport") in hints.prompt_examples()

    def test_examples_are_not_duplicated(self):
        hints = CategoryHints(
            confirmed={"MIGROS": "Lebensmittel"}, seen={"MIGROS": "Lebensmittel"}
        )
        assert hints.prompt_examples() == [("MIGROS", "Lebensmittel")]

    def test_is_empty(self):
        assert CategoryHints().is_empty is True
        assert CategoryHints(seen={"A": "B"}).is_empty is False
