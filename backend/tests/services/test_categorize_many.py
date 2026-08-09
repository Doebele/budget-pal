"""
Budget-Pal Backend — Sammelkategorisierung

Ein Auszug mit 25 Zeilen ergab 12 einzelne LLM-Aufrufe à 20–30 Sekunden, rund
fünf Minuten nur fürs Kategorisieren. categorize_many() laesst erst die
lokalen Stufen laufen und schickt nur den Rest — in EINEM Aufruf — ans Modell.
"""

from unittest.mock import AsyncMock, patch

import pytest

from app.services.ai_client import AiConfig
from app.services.categorization import CategorizationService
from app.services.user_history import CategoryHints


@pytest.fixture
def service() -> CategorizationService:
    return CategorizationService()


ENABLED = AiConfig(provider="openai", openai_api_key="sk-test")


class TestOnlyOneCall:
    async def test_single_call_for_many_unknown_rows(self, service):
        unknown = [f"Zxqwertyuiop Firma {i} AG" for i in range(10)]
        answer = (
            '{"results": ['
            + ",".join(f'{{"nr": {i}, "category": "Sonstiges"}}' for i in range(1, 11))
            + "]}"
        )
        complete = AsyncMock(return_value=answer)
        with patch("app.services.categorization.ai_client.complete", complete):
            await service.categorize_many(unknown, ENABLED)

        # Der ganze Sinn der Uebung: ein Aufruf statt zehn
        assert complete.await_count == 1

    async def test_no_call_when_rules_already_match(self, service):
        complete = AsyncMock(return_value="{}")
        with patch("app.services.categorization.ai_client.complete", complete):
            results = await service.categorize_many(["Migros Bern", "Coop Zürich"], ENABLED)

        assert complete.await_count == 0
        assert results[0]["category"] == "Lebensmittel"

    async def test_no_call_without_provider(self, service):
        complete = AsyncMock(return_value="{}")
        with patch("app.services.categorization.ai_client.complete", complete):
            results = await service.categorize_many(["Zxqwertyuiop AG"], None)

        assert complete.await_count == 0
        assert results[0]["category"] == "Sonstiges"

    async def test_only_unresolved_rows_are_sent(self, service):
        complete = AsyncMock(
            return_value='{"results": [{"nr": 1, "category": "Bildung"}]}'
        )
        with patch("app.services.categorization.ai_client.complete", complete):
            results = await service.categorize_many(
                ["Migros Bern", "Zxqwertyuiop Unbekannt AG"], ENABLED
            )

        # Nur die unbekannte Zeile steht in der Liste
        listing = complete.await_args.args[2]
        assert "Zxqwertyuiop" in listing
        assert "Migros" not in listing
        assert results[1]["category"] == "Bildung"


class TestResultMapping:
    async def test_positions_are_matched_by_number(self, service):
        unknown = ["Zxqwertyuiop A AG", "Zxqwertyuiop B AG", "Zxqwertyuiop C AG"]
        # Absichtlich in vertauschter Reihenfolge — die Nummer entscheidet
        answer = (
            '{"results": [{"nr": 3, "category": "Reisen"},'
            ' {"nr": 1, "category": "Bildung"},'
            ' {"nr": 2, "category": "Steuern"}]}'
        )
        with patch(
            "app.services.categorization.ai_client.complete",
            AsyncMock(return_value=answer),
        ):
            results = await service.categorize_many(unknown, ENABLED)

        assert [r["category"] for r in results] == ["Bildung", "Steuern", "Reisen"]

    async def test_missing_entries_keep_the_default(self, service):
        unknown = ["Zxqwertyuiop A AG", "Zxqwertyuiop B AG"]
        with patch(
            "app.services.categorization.ai_client.complete",
            AsyncMock(return_value='{"results": [{"nr": 1, "category": "Bildung"}]}'),
        ):
            results = await service.categorize_many(unknown, ENABLED)

        assert results[0]["category"] == "Bildung"
        assert results[1]["category"] == "Sonstiges"

    async def test_garbage_answer_leaves_everything_at_default(self, service):
        with patch(
            "app.services.categorization.ai_client.complete",
            AsyncMock(return_value="Das kann ich nicht."),
        ):
            results = await service.categorize_many(["Zxqwertyuiop AG"], ENABLED)

        assert results[0]["category"] == "Sonstiges"

    async def test_no_answer_leaves_everything_at_default(self, service):
        with patch(
            "app.services.categorization.ai_client.complete",
            AsyncMock(return_value=None),
        ):
            results = await service.categorize_many(["Zxqwertyuiop AG"], ENABLED)

        assert results[0]["category"] == "Sonstiges"

    async def test_out_of_range_numbers_are_ignored(self, service):
        with patch(
            "app.services.categorization.ai_client.complete",
            AsyncMock(return_value='{"results": [{"nr": 99, "category": "Reisen"}]}'),
        ):
            results = await service.categorize_many(["Zxqwertyuiop AG"], ENABLED)

        assert results[0]["category"] == "Sonstiges"

    async def test_empty_input(self, service):
        assert await service.categorize_many([], ENABLED) == []


class TestHistoryStillWins:
    async def test_confirmed_history_needs_no_model(self, service):
        hints = CategoryHints(confirmed={"ZXQWERTYUIOP AG": "Bildung"})
        complete = AsyncMock(return_value="{}")
        with patch("app.services.categorization.ai_client.complete", complete):
            results = await service.categorize_many(["Zxqwertyuiop AG"], ENABLED, hints)

        assert complete.await_count == 0
        assert results[0]["category"] == "Bildung"
