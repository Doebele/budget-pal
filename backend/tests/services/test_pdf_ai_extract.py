"""
Budget-Pal Backend — KI-Extraktion aus unbekannten PDFs

Schwerpunkt liegt auf dem Parsen der Modellantwort: ein LLM liefert Datum und
Betrag in allen erdenklichen Schreibweisen, und eine halb verstandene Zeile
darf nicht als Transaktion durchrutschen.
"""

from unittest.mock import AsyncMock, patch

import pytest

from app.services import pdf_ai_extract
from app.services.ai_client import AiConfig, Completion
from app.services.pdf_ai_extract import _parse_amount, _parse_date, _rows_from_response
from app.services.user_history import CategoryHints


# ── Datum ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("2026-03-15", "2026-03-15"),
        ("15.03.2026", "2026-03-15"),
        ("15/03/2026", "2026-03-15"),
        ("15.03.26", "2026-03-15"),  # zweistelliges Jahr
        ("", None),
        ("Kein Datum", None),
        (None, None),
    ],
)
def test_parse_date(raw, expected):
    assert _parse_date(raw) == expected


# ── Betrag ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw,expected",
    [
        (-12.34, -12.34),
        ("-12.34", -12.34),
        ("1'234.50", 1234.50),          # Schweizer Tausendertrennung
        ("-1.234,56", -1234.56),        # deutsches Format
        ("1234,56", 1234.56),
        ("12.34-", -12.34),             # nachgestelltes Minus
        ("CHF 99.00", 99.0),
        ("", None),
        ("keine Zahl", None),
    ],
)
def test_parse_amount(raw, expected):
    assert _parse_amount(raw) == expected


# ── Antwort-Parsing ───────────────────────────────────────────


def test_rows_from_response_happy_path():
    raw = """Hier die Buchungen:
    ```json
    {"transactions": [
      {"date": "15.03.2026", "description": "COOP PRONTO", "amount": "-12.50", "category": "Lebensmittel"}
    ]}
    ```"""
    rows = _rows_from_response(raw, "CHF")
    assert rows == [
        {
            "date": "2026-03-15",
            "description": "COOP PRONTO",
            "amount": -12.5,
            "currency": "CHF",
            "category": "Lebensmittel",
        }
    ]


def test_rows_without_date_amount_or_text_are_dropped():
    raw = """{"transactions": [
      {"date": "2026-03-15", "description": "Gueltig", "amount": -1.0},
      {"date": "", "description": "Kein Datum", "amount": -2.0},
      {"date": "2026-03-15", "description": "Kein Betrag", "amount": "abc"},
      {"date": "2026-03-15", "description": "", "amount": -3.0}
    ]}"""
    rows = _rows_from_response(raw, "CHF")
    assert [r["description"] for r in rows] == ["Gueltig"]


def test_rows_from_garbage_response():
    assert _rows_from_response("Ich kann das nicht lesen.", "CHF") == []
    assert _rows_from_response("{kaputtes json", "CHF") == []
    assert _rows_from_response("", "CHF") == []


def test_empty_transaction_list_is_valid():
    assert _rows_from_response('{"transactions": []}', "CHF") == []


# ── Chunking ──────────────────────────────────────────────────


def test_chunks_respect_line_boundaries():
    text = "\n".join(f"Zeile {i} mit etwas Text" for i in range(5000))
    chunks = pdf_ai_extract._chunks(text)
    # _chunks liefert ALLE Abschnitte; der Deckel greift erst beim Verarbeiten,
    # damit die Kuerzung sichtbar wird statt still zu passieren
    assert len(chunks) > pdf_ai_extract.MAX_CHUNKS
    assert all(not c.startswith(" ") for c in chunks)
    assert all("Zeile" in c for c in chunks)


class TestTruncationIsReported:
    """Ein zu langes Dokument wird am Kostendeckel abgeschnitten. Passiert das
    still, importiert der Nutzer ein halbes Dokument im Glauben, es sei
    vollstaendig."""

    async def test_long_document_is_flagged(self):
        response = '{"transactions": []}'
        long_text = "\n".join(f"Buchungszeile {i} mit etwas Text" for i in range(6000))
        with patch.object(
            pdf_ai_extract.ai_client, "complete_detailed",
            AsyncMock(return_value=Completion(response, "m", 1, 1)),
        ):
            result = await pdf_ai_extract.extract_transactions(
                AiConfig(provider="openai", openai_api_key="sk-test"), long_text
            )

        assert result.truncated is True
        assert result.chunks_processed == pdf_ai_extract.MAX_CHUNKS
        assert result.chunks_total > result.chunks_processed

    async def test_short_document_is_not_flagged(self):
        response = '{"transactions": []}'
        with patch.object(
            pdf_ai_extract.ai_client, "complete_detailed",
            AsyncMock(return_value=Completion(response, "m", 1, 1)),
        ):
            result = await pdf_ai_extract.extract_transactions(
                AiConfig(provider="openai", openai_api_key="sk-test"), "Kurzer Text"
            )

        assert result.truncated is False
        assert result.chunks_processed == result.chunks_total == 1


# ── Ende-zu-Ende mit gemocktem Modell ─────────────────────────


class TestExtractTransactions:
    async def test_returns_empty_without_provider(self):
        assert (await pdf_ai_extract.extract_transactions(AiConfig(), "Text")).rows == []
        assert (await pdf_ai_extract.extract_transactions(None, "Text")).rows == []

    async def test_returns_empty_for_blank_text(self):
        cfg = AiConfig(provider="openai", openai_api_key="sk-test")
        assert (await pdf_ai_extract.extract_transactions(cfg, "   ")).rows == []

    async def test_extracts_and_deduplicates_across_chunks(self):
        # Dasselbe Ergebnis für jeden Abschnitt — die Buchung darf nur einmal kommen
        response = '{"transactions": [{"date": "2026-03-15", "description": "MIGROS", "amount": -20.0}]}'
        with patch.object(
            pdf_ai_extract.ai_client, "complete_detailed",
            AsyncMock(return_value=Completion(response, "test-model", 100, 50))
        ):
            rows = (await pdf_ai_extract.extract_transactions(
                AiConfig(provider="openai", openai_api_key="sk-test"),
                "\n".join(f"Zeile {i}" for i in range(3000)),
            )).rows
        assert len(rows) == 1
        assert rows[0]["description"] == "MIGROS"

    async def test_hints_reach_the_prompt(self):
        """Die Kategorien des Nutzers müssen im System-Prompt landen — sonst
        erfindet das Modell eigene."""
        complete = AsyncMock(return_value=Completion('{"transactions": []}', "m", 1, 1))
        hints = CategoryHints(
            categories=["Lebensmittel", "Transport"],
            confirmed={"COOP": "Lebensmittel"},
            seen={"COOP": "Lebensmittel"},
        )
        with patch.object(pdf_ai_extract.ai_client, "complete_detailed", complete):
            await pdf_ai_extract.extract_transactions(
                AiConfig(provider="openai", openai_api_key="sk-test"), "Text", hints
            )

        system_prompt = complete.call_args.args[1]
        assert "Lebensmittel" in system_prompt
        assert "Transport" in system_prompt
        assert "COOP → Lebensmittel" in system_prompt

    async def test_model_failure_yields_no_rows(self):
        with patch.object(
            pdf_ai_extract.ai_client, "complete_detailed", AsyncMock(return_value=Completion())
        ):
            rows = (await pdf_ai_extract.extract_transactions(
                AiConfig(provider="openai", openai_api_key="sk-test"), "Irgendein Text"
            )).rows
        assert rows == []
