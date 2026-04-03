"""Unit tests for PDF preview duplicate helpers (in-file and amount tolerance)."""

from app.services.pdf_import_row_match import (
    DUPLICATE_AMOUNT_TOLERANCE,
    find_pdf_internal_duplicate_of,
    row_signature,
)


def test_row_signature_normalizes():
    d, rounded, desc = row_signature(" 2024-01-05 ", 10.456, "  Shop  ")
    assert d == "2024-01-05"
    assert rounded == 10.46
    assert desc == "Shop"


def test_find_pdf_internal_finds_first_id():
    prior = [
        ("a", "2024-01-01", 50.0, "Coffee"),
        ("b", "2024-01-02", -20.0, "Train"),
    ]
    assert find_pdf_internal_duplicate_of(prior, "2024-01-01", 50.0 + DUPLICATE_AMOUNT_TOLERANCE / 2, "Coffee") == "a"
    assert find_pdf_internal_duplicate_of(prior, "2024-01-02", -20.0, "Train") == "b"


def test_find_pdf_internal_none_when_unique():
    prior = [("a", "2024-01-01", 50.0, "Coffee")]
    assert find_pdf_internal_duplicate_of(prior, "2024-01-01", 99.0, "Coffee") is None
    assert find_pdf_internal_duplicate_of(prior, "2024-01-02", 50.0, "Coffee") is None
