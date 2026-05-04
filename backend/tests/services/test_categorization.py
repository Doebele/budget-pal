"""
Budget-Pal Backend — Categorization Service Tests

Tests for:
- Rule-based keyword matching
- Fuzzy matching with RapidFuzz
- Sentence-transformer embedding classification
- OpenAI GPT-4o-mini fallback (when API key is set)
- Category confidence scoring
"""

from unittest.mock import MagicMock, patch

import pytest

# ── Helper to load the service lazily ──────────────────────────


def get_categorization_service():
    """Import and return the CategorizationService."""
    from app.services.categorization import CategorizationService

    return CategorizationService()


# ── Rule-Based Matching Tests ─────────────────────────────────


class TestKeywordMatching:
    """Tests for the rule-based keyword matching component."""

    def test_keyword_match_returns_category(self):
        """Test that keyword matching returns a category for known merchants."""
        service = get_categorization_service()

        # Mock the keyword rules to avoid loading large datasets in tests
        with patch.object(
            service,
            "get_keyword_rules",
            return_value={
                "UBS": "Bank Fees",
                "N26": "Bank Fees",
                "Migros": "Groceries",
                "Coop": "Groceries",
                "Denner": "Groceries",
                "Lidl": "Groceries",
                "Swisscom": "Utilities",
                "SBB": "Transport",
                "PostFinance": "Bank Fees",
            },
        ):
            result = service._match_keywords("Payment to UBS")
            assert result is not None
            assert result["category"] == "Bank Fees"
            assert result["confidence"] > 0

    def test_keyword_match_case_insensitive(self):
        """Test that keyword matching is case-insensitive."""
        service = get_categorization_service()

        with patch.object(
            service,
            "get_keyword_rules",
            return_value={
                "UBS": "Bank Fees",
            },
        ):
            result_upper = service._match_keywords("Payment to UBS")
            result_lower = service._match_keywords("Payment to ubs")
            result_mixed = service._match_keywords("Payment to Ubs")

            assert result_upper is not None
            assert result_lower is not None
            assert result_mixed is not None
            assert (
                result_upper["category"]
                == result_lower["category"]
                == result_mixed["category"]
            )

    def test_keyword_match_no_match(self):
        """Test that keyword matching returns None for unknown merchants."""
        service = get_categorization_service()

        with patch.object(
            service,
            "get_keyword_rules",
            return_value={
                "UBS": "Bank Fees",
            },
        ):
            result = service._match_keywords("Payment to UnknownMerchantXYZ")
            assert result is None

    def test_keyword_match_returns_confidence(self):
        """Test that keyword matching returns a confidence score."""
        service = get_categorization_service()

        with patch.object(
            service,
            "get_keyword_rules",
            return_value={
                "UBS": "Bank Fees",
            },
        ):
            result = service._match_keywords("Payment to UBS")
            assert "confidence" in result
            assert 0 <= result["confidence"] <= 1

    def test_keyword_match_exact_vs_partial(self):
        """Test that exact matches have higher confidence than partial."""
        service = get_categorization_service()

        with patch.object(
            service,
            "get_keyword_rules",
            return_value={
                "UBS": "Bank Fees",
            },
        ):
            exact = service._match_keywords("UBS")
            partial = service._match_keywords("Payment to UBS")

            assert exact is not None
            assert partial is not None
            # Exact match should have higher or equal confidence
            assert exact["confidence"] >= partial["confidence"]


# ── Fuzzy Matching Tests ──────────────────────────────────────


class TestFuzzyMatching:
    """Tests for the fuzzy matching component using RapidFuzz."""

    def test_fuzzy_match_similar_name(self):
        """Test that fuzzy matching finds similar merchant names."""
        service = get_categorization_service()

        # Simulate fuzzy matching with a known dictionary
        merchant_dict = {
            "Migros": "Groceries",
            "Coop": "Groceries",
            "UBS Bank": "Bank Fees",
        }

        result = service.fuzzy_match("Migros Supermarket", merchant_dict, threshold=70)
        assert result is not None
        assert result["category"] == "Groceries"

    def test_fuzzy_match_typo_tolerance(self):
        """Test that fuzzy matching handles typos."""
        service = get_categorization_service()

        merchant_dict = {
            "Migros": "Groceries",
        }

        # With typo tolerance
        result = service.fuzzy_match("Migro", merchant_dict, threshold=60)
        assert result is not None
        assert result["category"] == "Groceries"

    def test_fuzzy_match_no_match_below_threshold(self):
        """Test that fuzzy matching returns None below threshold."""
        service = get_categorization_service()

        merchant_dict = {
            "Migros": "Groceries",
        }

        # High threshold should reject distant matches
        result = service.fuzzy_match(
            "CompletlyDifferentStore", merchant_dict, threshold=90
        )
        assert result is None

    def test_fuzzy_match_returns_confidence(self):
        """Test that fuzzy matching returns a confidence score."""
        service = get_categorization_service()

        merchant_dict = {
            "UBS": "Bank Fees",
        }

        result = service.fuzzy_match("UBS Bank", merchant_dict, threshold=50)
        assert result is not None
        assert "confidence" in result
        assert 0 <= result["confidence"] <= 1

    def test_fuzzy_match_empty_dict(self):
        """Test that fuzzy matching handles empty merchant dictionary."""
        service = get_categorization_service()

        result = service.fuzzy_match("Any Merchant", {}, threshold=50)
        assert result is None

    def test_fuzzy_match_empty_query(self):
        """Test that fuzzy matching handles empty query string."""
        service = get_categorization_service()

        merchant_dict = {
            "UBS": "Bank Fees",
        }

        result = service.fuzzy_match("", merchant_dict, threshold=50)
        assert result is None


# ── Embedding Classification Tests ────────────────────────────


class TestEmbeddingClassification:
    """Tests for the sentence-transformer embedding classification."""

    def test_embedding_match_returns_category(self):
        """Test that embedding classification returns a category."""
        service = get_categorization_service()

        # Mock the embedding model to avoid loading it in tests
        mock_embeddings = {
            "Migros": [0.1, 0.2, 0.3],
            "UBS": [0.4, 0.5, 0.6],
            "SBB": [0.7, 0.8, 0.9],
        }

        with patch.object(service, "_get_embeddings", return_value=mock_embeddings):
            result = service._classify_with_embeddings("Migros Supermarket")
            assert result is not None
            assert result["category"] == "Groceries"

    def test_embedding_match_no_match(self):
        """Test that embedding classification returns None for unknown categories."""
        service = get_categorization_service()

        mock_embeddings = {
            "Migros": [0.1, 0.2, 0.3],
        }

        with patch.object(service, "_get_embeddings", return_value=mock_embeddings):
            with patch.object(service, "EMBEDDING_THRESHOLD", 0.99):
                # Very high threshold should reject all matches
                result = service._classify_with_embeddings("CompletelyUnknown")
                assert result is None

    def test_embedding_match_returns_confidence(self):
        """Test that embedding classification returns a confidence score."""
        service = get_categorization_service()

        mock_embeddings = {
            "UBS": [0.4, 0.5, 0.6],
        }

        with patch.object(service, "_get_embeddings", return_value=mock_embeddings):
            result = service._classify_with_embeddings("UBS Bank")
            assert result is not None
            assert "confidence" in result
            assert 0 <= result["confidence"] <= 1

    def test_embedding_match_empty_categories(self):
        """Test that embedding classification handles empty category list."""
        service = get_categorization_service()

        mock_embeddings = {}

        with patch.object(service, "_get_embeddings", return_value=mock_embeddings):
            result = service._classify_with_embeddings("Any Merchant")
            assert result is None


# ── Full Categorization Pipeline Tests ────────────────────────


class TestCategorizationPipeline:
    """Tests for the full categorization pipeline."""

    def test_categorize_transaction_returns_category(self):
        """Test that the full pipeline returns a category."""
        service = get_categorization_service()

        # Mock all components
        with patch.object(
            service,
            "_match_keywords",
            return_value={
                "category": "Groceries",
                "confidence": 0.9,
            },
        ):
            result = service.categorize_transaction("Payment to Migros")
            assert result is not None
            assert "category" in result
            assert "confidence" in result

    def test_categorize_transaction_fallback_chain(self):
        """Test that the pipeline falls back through methods."""
        service = get_categorization_service()

        call_order = []

        def track_calls(*args, **kwargs):
            call_order.append("keyword")
            return None  # No keyword match

        def fuzzy_match(*args, **kwargs):
            call_order.append("fuzzy")
            return {"category": "Groceries", "confidence": 0.7}

        with patch.object(service, "_match_keywords", side_effect=track_calls):
            with patch.object(service, "fuzzy_match", side_effect=fuzzy_match):
                result = service.categorize_transaction("Payment to Migros")
                assert result is not None
                assert "Groceries" in call_order

    def test_categorize_transaction_with_category_id(self):
        """Test that categorization works with category IDs."""
        service = get_categorization_service()

        with patch.object(
            service,
            "_match_keywords",
            return_value={
                "category": "Groceries",
                "confidence": 0.9,
            },
        ):
            with patch.object(service, "_get_category_id", return_value=1):
                result = service.categorize_transaction("Payment to Migros")
                assert result is not None
                assert "category" in result

    def test_categorize_transaction_empty_description(self):
        """Test that categorization handles empty descriptions."""
        service = get_categorization_service()

        result = service.categorize_transaction("")
        assert result is None

    def test_categorize_transaction_none_description(self):
        """Test that categorization handles None descriptions."""
        service = get_categorization_service()

        result = service.categorize_transaction(None)
        assert result is None


# ── Category Mapping Tests ────────────────────────────────────


class TestCategoryMapping:
    """Tests for category mapping and normalization."""

    def test_normalize_category_lowercase(self):
        """Test that category names are normalized to lowercase."""
        service = get_categorization_service()

        result = service._normalize_category("Food & Groceries")
        assert result == "food & groceries"

    def test_normalize_category_strip_whitespace(self):
        """Test that category names have whitespace stripped."""
        service = get_categorization_service()

        result = service._normalize_category("  Food  ")
        assert result == "food"

    def test_normalize_category_remove_special_chars(self):
        """Test that special characters are handled."""
        service = get_categorization_service()

        result = service._normalize_category("Food/Groceries")
        assert result == "food groceries"

    def test_map_category_to_standard(self):
        """Test mapping to standard category names."""
        service = get_categorization_service()

        # Simulate category mapping
        mapping = {
            "food": "Groceries",
            "transport": "Transport",
            "bank": "Bank Fees",
        }

        result = service._map_to_standard_category("food", mapping)
        assert result == "Groceries"

    def test_map_category_unknown_returns_input(self):
        """Test that unknown categories return the input."""
        service = get_categorization_service()

        mapping = {
            "food": "Groceries",
        }

        result = service._map_to_standard_category("unknown", mapping)
        assert result == "unknown"


# ── Confidence Scoring Tests ──────────────────────────────────


class TestConfidenceScoring:
    """Tests for confidence scoring logic."""

    def test_confidence_from_keyword_match(self):
        """Test confidence scoring for keyword matches."""
        service = get_categorization_service()

        # Exact match should have high confidence
        confidence = service._calculate_confidence("exact", 1.0)
        assert confidence > 0.8

    def test_confidence_from_fuzzy_match(self):
        """Test confidence scoring for fuzzy matches."""
        service = get_categorization_service()

        # Fuzzy match should have medium confidence
        confidence = service._calculate_confidence("fuzzy", 0.8)
        assert 0.5 <= confidence <= 0.9

    def test_confidence_from_embedding(self):
        """Test confidence scoring for embedding matches."""
        service = get_categorization_service()

        # Embedding match should have lower confidence
        confidence = service._calculate_confidence("embedding", 0.7)
        assert 0.3 <= confidence <= 0.8

    def test_confidence_threshold_filtering(self):
        """Test that low confidence results are filtered."""
        service = get_categorization_service()

        # Low confidence should be filtered out
        result = service._filter_by_confidence(
            {
                "category": "Groceries",
                "confidence": 0.2,
            },
            min_confidence=0.5,
        )
        assert result is None

    def test_confidence_high_threshold(self):
        """Test confidence scoring with high threshold."""
        service = get_categorization_service()

        result = service._filter_by_confidence(
            {
                "category": "Groceries",
                "confidence": 0.9,
            },
            min_confidence=0.5,
        )
        assert result is not None


# ── Bulk Categorization Tests ─────────────────────────────────


class TestBulkCategorization:
    """Tests for bulk categorization functionality."""

    def test_bulk_categorize_returns_results(self):
        """Test that bulk categorization returns results for all transactions."""
        service = get_categorization_service()

        transactions = [
            {"id": 1, "description": "Payment to Migros"},
            {"id": 2, "description": "Payment to UBS"},
            {"id": 3, "description": "Payment to SBB"},
        ]

        with patch.object(
            service,
            "categorize_transaction",
            return_value={
                "category": "Groceries",
                "confidence": 0.8,
            },
        ):
            results = service.bulk_categorize(transactions)
            assert len(results) == 3
            for result in results:
                assert "id" in result
                assert "category" in result

    def test_bulk_categorize_handles_empty_list(self):
        """Test that bulk categorization handles empty transaction list."""
        service = get_categorization_service()

        results = service.bulk_categorize([])
        assert results == []

    def test_bulk_categorize_handles_none_descriptions(self):
        """Test that bulk categorization handles None descriptions."""
        service = get_categorization_service()

        transactions = [
            {"id": 1, "description": None},
            {"id": 2, "description": "Valid Description"},
        ]

        with patch.object(
            service,
            "categorize_transaction",
            return_value={
                "category": "Groceries",
                "confidence": 0.8,
            },
        ):
            results = service.bulk_categorize(transactions)
            assert len(results) == 2


# ── Edge Cases ────────────────────────────────────────────────


class TestEdgeCases:
    """Tests for edge cases and error handling."""

    def test_categorize_unicode_description(self):
        """Test categorization with Unicode characters."""
        service = get_categorization_service()

        with patch.object(
            service,
            "_match_keywords",
            return_value={
                "category": "Groceries",
                "confidence": 0.9,
            },
        ):
            result = service.categorize_transaction("Payment to Zürich Migros")
            assert result is not None

    def test_categorize_very_long_description(self):
        """Test categorization with very long description."""
        service = get_categorization_service()

        long_description = "A" * 10000

        with patch.object(
            service,
            "_match_keywords",
            return_value={
                "category": "Groceries",
                "confidence": 0.9,
            },
        ):
            result = service.categorize_transaction(long_description)
            assert result is not None

    def test_categorize_special_characters(self):
        """Test categorization with special characters."""
        service = get_categorization_service()

        with patch.object(
            service,
            "_match_keywords",
            return_value={
                "category": "Groceries",
                "confidence": 0.9,
            },
        ):
            result = service.categorize_transaction("Payment to @#$%^&*()")
            assert result is not None

    def test_categorize_whitespace_only(self):
        """Test categorization with whitespace-only description."""
        service = get_categorization_service()

        result = service.categorize_transaction("   ")
        assert result is None

    def test_categorize_number_only(self):
        """Test categorization with number-only description."""
        service = get_categorization_service()

        with patch.object(service, "_match_keywords", return_value=None):
            result = service.categorize_transaction("12345")
            # Should not crash, may return None or a category
            assert result is None or "category" in result


# ── Integration Tests ─────────────────────────────────────────


class TestCategorizationIntegration:
    """Integration tests for the categorization service."""

    def test_full_pipeline_with_mocked_components(self):
        """Test the full pipeline with all components mocked."""
        service = get_categorization_service()

        with patch.object(service, "_match_keywords", return_value=None):
            with patch.object(service, "fuzzy_match", return_value=None):
                with patch.object(
                    service, "_classify_with_embeddings", return_value=None
                ):
                    result = service.categorize_transaction(
                        "Payment to UnknownMerchant"
                    )
                    # Should return None when all methods fail
                    assert result is None

    def test_full_pipeline_with_keyword_match(self):
        """Test the full pipeline with keyword match succeeding."""
        service = get_categorization_service()

        with patch.object(
            service,
            "_match_keywords",
            return_value={
                "category": "Groceries",
                "confidence": 0.9,
            },
        ):
            result = service.categorize_transaction("Payment to Migros")
            assert result is not None
            assert result["category"] == "Groceries"
            assert result["confidence"] > 0.5

    def test_full_pipeline_with_fuzzy_match(self):
        """Test the full pipeline with fuzzy match succeeding."""
        service = get_categorization_service()

        with patch.object(service, "_match_keywords", return_value=None):
            with patch.object(
                service,
                "fuzzy_match",
                return_value={
                    "category": "Groceries",
                    "confidence": 0.7,
                },
            ):
                result = service.categorize_transaction("Payment to Migro")
                assert result is not None
                assert result["category"] == "Groceries"
                assert result["confidence"] > 0.3

    def test_full_pipeline_with_embedding_match(self):
        """Test the full pipeline with embedding match succeeding."""
        service = get_categorization_service()

        with patch.object(service, "_match_keywords", return_value=None):
            with patch.object(service, "fuzzy_match", return_value=None):
                with patch.object(
                    service,
                    "_classify_with_embeddings",
                    return_value={
                        "category": "Groceries",
                        "confidence": 0.6,
                    },
                ):
                    result = service.categorize_transaction("Payment to Grocery Store")
                    assert result is not None
                    assert result["category"] == "Groceries"
                    assert result["confidence"] > 0.2


# ── Performance Tests ─────────────────────────────────────────


class TestPerformance:
    """Tests for performance characteristics."""

    def test_categorize_single_transaction_speed(self):
        """Test that single transaction categorization is fast (< 100ms)."""
        import time

        service = get_categorization_service()

        with patch.object(
            service,
            "_match_keywords",
            return_value={
                "category": "Groceries",
                "confidence": 0.9,
            },
        ):
            start = time.time()
            result = service.categorize_transaction("Payment to Migros")
            elapsed = time.time() - start

            assert result is not None
            assert elapsed < 0.1  # Should be fast without embeddings

    def test_bulk_categorize_speed(self):
        """Test that bulk categorization scales reasonably."""
        import time

        service = get_categorization_service()

        transactions = [
            {"id": i, "description": f"Payment to Merchant {i}"} for i in range(100)
        ]

        with patch.object(
            service,
            "categorize_transaction",
            return_value={
                "category": "Groceries",
                "confidence": 0.8,
            },
        ):
            start = time.time()
            results = service.bulk_categorize(transactions)
            elapsed = time.time() - start

            assert len(results) == 100
            # Should complete in reasonable time
            assert elapsed < 10.0  # 10 seconds for 100 transactions
