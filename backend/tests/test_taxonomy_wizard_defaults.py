"""Sanity checks for wizard → transaction category defaults used by recurring-plan suggest."""
from app.core import taxonomy
from app.core.taxonomy import (
    default_transaction_category_for_wizard_label,
    load_base_super_categories,
    merge_taxonomy_with_categories,
    resolve_super_category_row,
)


def test_saeule_3a_explicit_default():
    assert taxonomy.DEFAULT_WIZARD_TO_TXN["säule 3a"] == "Säule 3A"


def test_netflix_resolves_to_txn_category():
    merged = merge_taxonomy_with_categories(load_base_super_categories(), [])
    cat = default_transaction_category_for_wizard_label(merged, "netflix")
    assert cat == "Abonnements"


def test_saeule_3a_under_steuern_super():
    rows = load_base_super_categories()
    sc = resolve_super_category_row(rows, "Säule 3A", is_wizard=False)
    assert sc.get("id") == "steuern"
    sc_w = resolve_super_category_row(rows, "säule 3a", is_wizard=True)
    assert sc_w.get("id") == "steuern"
