from datetime import datetime

import pytest

from app.services.currency_service import CurrencyService


@pytest.mark.asyncio
async def test_cached_payload_preserves_meta_and_last_updated(tmp_path) -> None:
    service = CurrencyService()
    service.cache_file = tmp_path / "rates.json"

    payload = {
        "EUR": 1.0,
        "CHF": 0.95,
        "_meta": {
            "last_updated": "2026-01-01T12:34:56",
            "source": "frankfurter.app",
            "base": "EUR",
        },
    }
    await service._persist_rates(payload)

    rates = await service._load_cached_rates()
    assert rates is not None
    assert rates["EUR"] == 1.0
    assert rates["CHF"] == 0.95
    assert "_meta" not in rates

    last = await service.get_last_update_time()
    assert last == datetime.fromisoformat("2026-01-01T12:34:56")

