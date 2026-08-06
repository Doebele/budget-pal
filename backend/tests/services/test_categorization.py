"""
Budget-Pal Backend — Categorization Service Tests

Tests for the 5-stage pipeline in app/services/categorization.py:
- Description normalization (noise removal)
- Rule-based keyword matching (MERCHANT_RULES)
- Fuzzy matching with RapidFuzz
- Category name normalization (EN → DE legacy mapping)
- Full async categorize() pipeline with mocked stages

The sentence-transformer and OpenAI stages are mocked everywhere —
tests must not download models or call external APIs.
"""

import time
from unittest.mock import patch

import pytest

from app.services.categorization import (
    CategorizationService,
    EN_TO_DE_CATEGORY,
    MERCHANT_RULES,
)


@pytest.fixture
def service() -> CategorizationService:
    return CategorizationService()


# ── Description Normalization ─────────────────────────────────


class TestNormalizeDescription:
    def test_removes_noise_tokens(self, service):
        result = service._normalize_description("Kartenzahlung Migros Zürich")
        assert "KARTENZAHLUNG" not in result
        assert "MIGROS" in result

    def test_removes_dates_and_iban(self, service):
        result = service._normalize_description(
            "Zahlung 2024-01-15 IBAN: CH9300762011623852957 Coop"
        )
        assert "2024-01-15" not in result
        assert "COOP" in result

    def test_collapses_whitespace(self, service):
        result = service._normalize_description("  Migros    Bern  ")
        assert result == "MIGROS BERN"

    def test_uppercases(self, service):
        assert service._normalize_description("migros") == "MIGROS"


# ── Rule-Based Keyword Matching ───────────────────────────────


class TestRuleBased:
    def test_known_merchant_returns_category(self, service):
        result = service._rule_based("Payment to Migros Bern")
        assert result is not None
        category, subcategory, merchant, confidence = result
        assert category == "Lebensmittel"
        assert merchant == "Migros"
        assert confidence > 0

    def test_case_insensitive(self, service):
        upper = service._rule_based("MIGROS")
        lower = service._rule_based("migros")
        mixed = service._rule_based("MiGrOs")
        assert upper is not None and lower is not None and mixed is not None
        assert upper[0] == lower[0] == mixed[0]

    def test_unknown_merchant_returns_none(self, service):
        assert service._rule_based("Zxqwertyuiop Unbekannt AG") is None

    def test_confidence_in_valid_range(self, service):
        result = service._rule_based("Coop Pronto")
        assert result is not None
        assert 0 <= result[3] <= 1

    def test_substring_match(self, service):
        # Rules match as substring inside longer descriptions
        result = service._rule_based("TWINT Belastung mcdonalds Luzern 12.50")
        assert result is not None
        assert result[0] == "Restaurant & Takeaway"


# ── Fuzzy Matching ────────────────────────────────────────────


class TestFuzzyMatch:
    def test_close_variant_matches(self, service):
        result = service._fuzzy_match("MIGROS")
        assert result is not None
        category, subcategory, merchant, confidence = result
        assert category == "Lebensmittel"
        assert 0 <= confidence <= 1

    def test_no_match_for_distant_string(self, service):
        result = service._fuzzy_match("Zxqwertyuiop Unbekannt")
        assert result is None

    def test_returns_normalized_merchant_name(self, service):
        result = service._fuzzy_match("McDonald's")
        assert result is not None
        merchants = {v[2] for v in MERCHANT_RULES.values()}
        assert result[2] in merchants


# ── Category Name Normalization (EN → DE) ─────────────────────


class TestNormalizeCategory:
    def test_english_mapped_to_german(self):
        assert CategorizationService.normalize_category("groceries") == "Lebensmittel"
        assert CategorizationService.normalize_category("Transport") == "Transport"
        assert CategorizationService.normalize_category("salary") == "Gehalt"

    def test_case_insensitive_lookup(self):
        assert CategorizationService.normalize_category("GROCERIES") == "Lebensmittel"

    def test_unknown_category_returned_unchanged(self):
        assert CategorizationService.normalize_category("Spezialfall") == "Spezialfall"

    def test_pillar_3a_variants(self):
        assert CategorizationService.normalize_category("pillar 3a") == "Säule 3A"
        assert CategorizationService.normalize_category("3. Säule") == "Säule 3A"

    def test_mapping_values_are_german_canonical(self):
        # Every mapping target should itself be stable under normalization
        for target in set(EN_TO_DE_CATEGORY.values()):
            normalized = CategorizationService.normalize_category(target)
            assert normalized == target


# ── Full Pipeline (categorize) ────────────────────────────────


class TestCategorizePipeline:
    async def test_returns_expected_shape(self, service):
        result = await service.categorize("Migros Bern")
        assert set(result.keys()) == {
            "category",
            "subcategory",
            "merchant_normalized",
            "confidence_score",
        }

    async def test_empty_description_returns_sonstiges(self, service):
        result = await service.categorize("")
        assert result["category"] == "Sonstiges"
        assert result["confidence_score"] == 0.0

    async def test_whitespace_only_returns_sonstiges(self, service):
        result = await service.categorize("   ")
        assert result["category"] == "Sonstiges"
        assert result["confidence_score"] == 0.0

    async def test_rule_match_short_circuits(self, service):
        with patch.object(service, "_fuzzy_match") as fuzzy, patch.object(
            service, "_embedding_classify"
        ) as embed:
            result = await service.categorize("Migros Bern")
        assert result["category"] == "Lebensmittel"
        fuzzy.assert_not_called()
        embed.assert_not_called()

    async def test_fallback_to_fuzzy(self, service):
        with patch.object(service, "_rule_based", return_value=None), patch.object(
            service,
            "_fuzzy_match",
            return_value=("Lebensmittel", "Supermarkt", "Migros", 0.9),
        ):
            result = await service.categorize("Migors Bern")
        assert result["category"] == "Lebensmittel"
        assert result["confidence_score"] == 0.9

    async def test_fallback_to_embeddings(self, service):
        with patch.object(service, "_rule_based", return_value=None), patch.object(
            service, "_fuzzy_match", return_value=None
        ), patch.object(
            service,
            "_embedding_classify",
            return_value=("Freizeit & Unterhaltung", "", "kino", 0.7),
        ):
            result = await service.categorize("Kino Abend")
        assert result["category"] == "Freizeit & Unterhaltung"
        assert result["confidence_score"] == 0.7

    async def test_low_embedding_confidence_skipped(self, service):
        with patch.object(service, "_rule_based", return_value=None), patch.object(
            service, "_fuzzy_match", return_value=None
        ), patch.object(
            service,
            "_embedding_classify",
            return_value=("Freizeit & Unterhaltung", "", "x", 0.3),
        ), patch.object(
            service, "_llm_fallback", return_value=None
        ):
            result = await service.categorize("Unklare Buchung")
        # Confidence below 0.5 → falls through to default
        assert result["category"] == "Sonstiges"
        assert result["confidence_score"] == 0.1

    async def test_llm_fallback_used_when_all_else_fails(self, service):
        with patch.object(service, "_rule_based", return_value=None), patch.object(
            service, "_fuzzy_match", return_value=None
        ), patch.object(
            service, "_embedding_classify", return_value=None
        ), patch.object(
            service,
            "_llm_fallback",
            return_value=("Reisen", "Flug", "Swiss", 0.75),
        ):
            result = await service.categorize("LX1612 ZRH-LHR")
        assert result["category"] == "Reisen"
        assert result["confidence_score"] == 0.75

    async def test_default_fallback_sonstiges(self, service):
        with patch.object(service, "_rule_based", return_value=None), patch.object(
            service, "_fuzzy_match", return_value=None
        ), patch.object(
            service, "_embedding_classify", return_value=None
        ), patch.object(
            service, "_llm_fallback", return_value=None
        ):
            result = await service.categorize("Völlig unbekannte Buchung")
        assert result["category"] == "Sonstiges"
        assert result["confidence_score"] == 0.1


# ── Edge Cases ────────────────────────────────────────────────


class TestEdgeCases:
    async def test_unicode_description(self, service):
        result = await service.categorize("Zahlung an Migros Zürich")
        assert result["category"] == "Lebensmittel"

    async def test_very_long_description(self, service):
        with patch.object(service, "_embedding_classify", return_value=None), \
             patch.object(service, "_llm_fallback", return_value=None):
            result = await service.categorize("A" * 10000)
        assert "category" in result

    async def test_special_characters(self, service):
        with patch.object(service, "_embedding_classify", return_value=None), \
             patch.object(service, "_llm_fallback", return_value=None):
            result = await service.categorize("@#$%^&*()")
        assert "category" in result

    async def test_number_only_description(self, service):
        with patch.object(service, "_embedding_classify", return_value=None), \
             patch.object(service, "_llm_fallback", return_value=None):
            result = await service.categorize("12345")
        assert "category" in result


# ── Performance ───────────────────────────────────────────────


class TestPerformance:
    async def test_rule_based_categorization_is_fast(self, service):
        start = time.time()
        for _ in range(100):
            await service.categorize("Migros Bern Kartenzahlung")
        elapsed = time.time() - start
        # 100 rule-based categorizations without models should be quick
        assert elapsed < 2.0
