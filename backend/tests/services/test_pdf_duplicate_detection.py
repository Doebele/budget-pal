"""
Budget-Pal Backend — Duplikaterkennung über Textähnlichkeit

Stufe 3 der Erkennung: dieselbe Buchung, anders geschrieben. Nötig, seit
Zeilen auch per KI aus unbekannten PDFs extrahiert werden — deren Buchungstext
weicht von dem ab, was ein Parser gespeichert hätte.

Die Schwelle ist ein Kompromiss: zu locker unterschlägt echte Buchungen (zwei
Kaffees am selben Tag), zu streng lässt Duplikate durch. Diese Tests halten
beide Seiten fest.
"""

from app.services.pdf_duplicate_detection import (
    _descriptions_match,
    normalize_for_match,
)


class TestNormalizeForMatch:
    def test_case_and_punctuation_are_irrelevant(self):
        assert normalize_for_match("Coop Pronto, Zürich") == normalize_for_match(
            "COOP PRONTO ZUERICH"
        )

    def test_collapses_whitespace(self):
        assert normalize_for_match("  MIGROS   BERN ") == "MIGROS BERN"

    def test_umlauts_are_transliterated(self):
        assert "UE" in normalize_for_match("Zürich")
        assert "OE" in normalize_for_match("Öl")
        assert "AE" in normalize_for_match("Ähnlich")

    def test_empty_input(self):
        assert normalize_for_match("") == ""
        assert normalize_for_match(None) == ""


class TestDescriptionsMatch:
    def test_identical_after_normalization(self):
        assert _descriptions_match("COOP PRONTO ZUERICH", "Coop Pronto, Zürich") is True

    def test_parser_vs_ai_phrasing(self):
        # Genau der Fall, für den Stufe 3 existiert
        assert _descriptions_match(
            "KARTENZAHLUNG MIGROS MM BERN BAHNHOF",
            "Kartenzahlung Migros MM Bern Bahnhof",
        ) is True

    def test_extra_tokens_still_match(self):
        assert _descriptions_match(
            "SBB MOBILE TICKET", "SBB Mobile Ticket Zahlung"
        ) is True

    def test_different_merchants_do_not_match(self):
        assert _descriptions_match("MIGROS BERN", "COOP ZUERICH") is False

    def test_unrelated_text_does_not_match(self):
        assert _descriptions_match("LOHN ARBEITGEBER AG", "MIETE WOHNUNG") is False

    def test_empty_never_matches(self):
        # Sonst würde jede Zeile ohne Text als Duplikat aller anderen gelten
        assert _descriptions_match("", "MIGROS") is False
        assert _descriptions_match("MIGROS", "") is False
        assert _descriptions_match("", "") is False
