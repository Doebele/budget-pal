"""
Budget-Pal Backend — Plausibilitaetspruefung des Auffang-Parsers

Hintergrund: bei einem unbekannten PDF-Format greift als letzter Versuch der
generische UBS-Regex-Parser. Der schlaegt gelegentlich auf einer Kopfzeile an
("Auszug fuer den Zeitraum 01.03.2026 bis 31.03.2026") und liefert dann eine
einzige Sammelzeile — ganzer Auszugstext als Beschreibung, Betrag 0.

Diese Ausgabe ist schlechter als gar keine: sie verhinderte den KI-Fallback
(weil "es kam ja etwas zurueck") und wurde als echte Buchung importiert.
"""

from app.api.imports import MAX_PLAUSIBLE_DESCRIPTION, _rows_look_implausible


class TestRowsLookImplausible:
    def test_empty_result_is_implausible(self):
        assert _rows_look_implausible([]) is True

    def test_single_collector_row_is_implausible(self):
        """Der konkrete Fall, der die KI-Extraktion ausgehebelt hat."""
        rows = [
            {
                "date": "2026-03-01",
                "amount": 0.0,
                "description": (
                    "bis Alter Saldo per 01.03.2026 2450.00 03.03.2026 Coop Pronto "
                    "Zuerich HB 12.50 05.03.2026 SBB Mobile Ticket Bern-Zuerich 34.00 "
                    "07.03.2026 Lohn Musterfirma AG Maerz 2026 5200.00 11.03.2026 "
                    "Krankenkasse Helsana Praemie 03/2026 389.40"
                ),
            }
        ]
        assert _rows_look_implausible(rows) is True

    def test_all_zero_amounts_is_implausible(self):
        rows = [
            {"date": "2026-03-03", "amount": 0.0, "description": "COOP"},
            {"date": "2026-03-05", "amount": 0.0, "description": "SBB"},
        ]
        assert _rows_look_implausible(rows) is True

    def test_overlong_description_is_implausible(self):
        rows = [
            {"date": "2026-03-03", "amount": -12.5, "description": "COOP"},
            {
                "date": "2026-03-05",
                "amount": -34.0,
                "description": "X" * (MAX_PLAUSIBLE_DESCRIPTION + 1),
            },
        ]
        assert _rows_look_implausible(rows) is True

    def test_normal_rows_are_plausible(self):
        rows = [
            {"date": "2026-03-03", "amount": -12.50, "description": "COOP PRONTO ZUERICH"},
            {"date": "2026-03-07", "amount": 5200.0, "description": "LOHN MUSTERFIRMA AG"},
        ]
        assert _rows_look_implausible(rows) is False

    def test_single_real_booking_is_plausible(self):
        # Ein Auszug mit genau einer Buchung ist legitim
        rows = [{"date": "2026-03-03", "amount": -12.50, "description": "COOP PRONTO"}]
        assert _rows_look_implausible(rows) is False

    def test_zero_amount_among_real_ones_is_plausible(self):
        # Eine einzelne 0.00-Buchung (z. B. Gebuehrengutschrift) ist kein Grund,
        # das gesamte Parse-Ergebnis zu verwerfen
        rows = [
            {"date": "2026-03-03", "amount": -12.50, "description": "COOP"},
            {"date": "2026-03-04", "amount": 0.0, "description": "GEBUEHR ERLASSEN"},
        ]
        assert _rows_look_implausible(rows) is False

    def test_missing_amount_field_counts_as_zero(self):
        assert _rows_look_implausible([{"date": "2026-03-03", "description": "X"}]) is True
