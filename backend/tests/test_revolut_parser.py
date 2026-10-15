"""
Budget-Pal Backend — Revolut-CSV auf Deutsch

Revolut exportiert in der App-Sprache. Ein deutscher Export ("..._de-ch_...")
hat andere Spaltennamen und den Status "ABGESCHLOSSEN" statt "COMPLETED".
Bisher scheiterte schon die Formaterkennung (422 "Could not detect bank
format"), und der Parser haette jede Zeile verworfen.
"""

from app.api.imports import detect_bank_format
from app.services.import_parsers.revolut import RevolutParser

GERMAN = (
    "Art,Produkt,Datum des Beginns,Datum des Abschlusses,Beschreibung,Betrag,Gebühr,Währung,Status,Kontostand\n"
    "Einzahlung,Giro,2024-03-06 09:49:16,2024-03-06 09:49:17,Zahlung von Muster,2000.00,0.00,GBP,ABGESCHLOSSEN,2000.00\n"
    "Kartenbezahlung,Giro,2024-11-17 12:10:43,2024-11-19 16:43:50,Evernote,-17.82,0.18,GBP,ABGESCHLOSSEN,1982.00\n"
    "Kartenbezahlung,Giro,2024-11-18 10:00:00,,Kaffee,-3.50,0.00,GBP,AUSSTEHEND,1978.50\n"
).encode()

ENGLISH = (
    "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n"
    "CARD_PAYMENT,Current,2024-11-17 12:10:43,2024-11-19 16:43:50,Evernote,-17.82,0.00,EUR,COMPLETED,100.00\n"
).encode()


def test_german_export_is_detected():
    assert detect_bank_format(GERMAN) == "revolut"
    assert detect_bank_format(ENGLISH) == "revolut"


def test_german_export_is_parsed():
    rows = RevolutParser().parse(GERMAN)
    # Zwei abgeschlossene Buchungen plus die Gebuehr als eigene Zeile;
    # die ausstehende Buchung bleibt draussen
    assert [(r["amount"], r["currency"]) for r in rows] == [(2000.0, "GBP"), (-17.82, "GBP"), (-0.18, "GBP")]
    assert rows[0]["date"].strftime("%Y-%m-%d") == "2024-03-06"
    assert rows[1]["description"] == "Evernote (Kartenbezahlung)"
    assert rows[1]["balance"] == 1982.0


def test_preview_reads_revolut_dates_with_time(client, test_account):
    """Die CSV-Vorschau kannte kein Datum mit Uhrzeit: jede Revolut-Zeile
    landete als Fehler in der Vorschau, obwohl der Import funktionierte."""
    body = client.post(
        "/api/imports/preview",
        files={"file": ("revolut.csv", GERMAN, "text/csv")},
        data={"account_id": str(test_account.id)},
    ).json()
    assert body["bank"] == "revolut"
    # Nur die ausstehende Zeile ohne Abschlussdatum — der Import nimmt sie
    # ebenfalls nicht
    assert body["error_rows"] == 1
    # Abschlussdatum wie beim Import, nicht das Beginn-Datum
    assert body["rows"][1]["date"] == "2024-11-19 16:43:50"
