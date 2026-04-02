from datetime import datetime

from app.services.import_parsers.ubs import UBSParser


def test_recalculate_amounts_uses_lookahead_delta() -> None:
    parser = UBSParser()
    txns = [
        {"date": datetime(2024, 1, 1), "balance": 1000.0, "amount": 0.0},
        {"date": datetime(2024, 1, 2), "balance": 1060.0, "amount": 0.0},
        {"date": datetime(2024, 1, 3), "balance": 1030.0, "amount": 0.0},
    ]

    recalc = parser._recalculate_amounts_from_balance(txns)

    # first row no longer forced to zero; uses next - current
    assert recalc[0]["amount"] == 60.0
    assert recalc[1]["amount"] == -30.0
    # last row has no look-ahead and falls back to 0
    assert recalc[2]["amount"] == 0.0

