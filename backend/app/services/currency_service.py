"""
Currency Exchange Rate Service for Budget-Pal
Handles fetching, caching, and converting currency rates.
Uses Frankfurter API (free tier) with SQLite persistence.
"""

import json
import os
import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional
import aiofiles
import httpx

from app.core.database import AsyncSessionLocal as async_session_maker
from sqlalchemy import text

logger = logging.getLogger(__name__)

# Configuration
API_URL = "https://api.frankfurter.app/latest?from=EUR&amount=1"
CACHE_FILE_PATH = os.getenv("RATES_CACHE_PATH", "/app/data/rates.json")

# Fallback rates when API is unavailable (EUR base)
FALLBACK_RATES: Dict[str, float] = {
    "CHF": 0.95,
    "USD": 1.13,
    "GBP": 0.89,
    "JPY": 168.5,
    "SEK": 11.8,
    "CAD": 1.47,
    "AUD": 1.65,
    "NZD": 1.78,
    "NOK": 11.5,
    "DKK": 7.45,
    "PLN": 4.32,
    "CZK": 24.8,
    "HUF": 384.2,
    "RON": 4.97,
    "HRK": 7.53,
    "BGN": 1.96,
    "ISK": 149.5,
    "MXN": 18.4,
    "BRL": 5.35,
    "CNY": 7.82,
    "HKD": 8.62,
    "SGD": 1.45,
    "INR": 90.2,
    "KRW": 1445.8,
    "ZAR": 19.8,
    "TRY": 34.5,
    "AED": 4.0,
    "SAR": 4.15,
    "THB": 38.5,
    "MYR": 5.15,
    "IDR": 17250.0,
    "PHP": 62.5,
    "TWD": 34.8,
    "VND": 27000.0,
    "EGP": 52.5,
    "RUB": 98.5,
    "UAH": 42.8,
    "ILS": 4.05,
    "CLP": 985.0,
    "COP": 4250.0,
    "PEN": 4.05,
    "ARS": 950.0,
}


class CurrencyService:
    """Service for managing currency exchange rates."""

    def __init__(self):
        self.cache_file = Path(CACHE_FILE_PATH)
        self._ensure_cache_directory()

    def _ensure_cache_directory(self) -> None:
        """Ensure the cache directory exists."""
        try:
            self.cache_file.parent.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            logger.warning(f"Could not create cache directory: {e}")

    async def load_rates(self) -> Dict[str, float]:
        """
        Fetch rates from API and persist to cache.
        Falls back to cached or default rates on failure.
        """
        logger.info("[CurrencyService] Loading currency rates...")

        try:
            # Try to fetch from API
            rates = await self._fetch_from_api()
            await self._persist_rates(rates)
            await self._update_database(rates, "api")
            logger.info(f"[CurrencyService] ✅ Loaded {len(rates)} rates from API")
            return rates

        except Exception as e:
            logger.error(f"[CurrencyService] ❌ API fetch failed: {e}")

            # Try to load existing cache
            cached_rates = await self._load_cached_rates()
            if cached_rates:
                logger.info("[CurrencyService] ⚠️ Using cached rates")
                return cached_rates

            # Use fallback rates
            logger.info("[CurrencyService] ⚠️ Using fallback rates")
            await self._persist_rates(FALLBACK_RATES)
            await self._update_database(FALLBACK_RATES, "fallback")
            return FALLBACK_RATES.copy()

    async def _fetch_from_api(self) -> Dict[str, float]:
        """Fetch rates from Frankfurter API."""
        headers = {
            "User-Agent": "budget-pal/1.0 (Python Backend)",
            "Accept": "application/json",
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(API_URL, headers=headers)
            
            if response.status_code != 200:
                raise httpx.HTTPError(
                    f"HTTP {response.status_code}: {response.reason_phrase}"
                )

            data = response.json()

            if not data.get("rates"):
                raise ValueError("Invalid API response: missing rates")

            # Build rates dict with EUR as base
            rates: Dict[str, float] = {"EUR": 1.0}
            for currency, rate in data["rates"].items():
                if isinstance(rate, (int, float)):
                    rates[currency] = round(float(rate), 6)

            # Add metadata
            rates["_meta"] = {
                "last_updated": datetime.utcnow().isoformat(),
                "source": "frankfurter.app",
                "base": "EUR",
            }

            return rates

    async def _persist_rates(self, rates: Dict[str, float]) -> None:
        """Persist rates to JSON cache file."""
        try:
            async with aiofiles.open(self.cache_file, "w", encoding="utf-8") as f:
                await f.write(json.dumps(rates, indent=2, ensure_ascii=False))
        except Exception as e:
            logger.error(f"[CurrencyService] Failed to persist rates: {e}")
            raise

    async def _load_cached_rates(self) -> Optional[Dict[str, float]]:
        """Load rates from JSON cache file."""
        try:
            if not self.cache_file.exists():
                return None

            async with aiofiles.open(self.cache_file, "r", encoding="utf-8") as f:
                content = await f.read()
                data = json.loads(content)

            # Filter out metadata keys
            return {
                k: v for k, v in data.items()
                if not k.startswith("_") and isinstance(v, (int, float))
            }
        except Exception as e:
            logger.warning(f"[CurrencyService] Failed to load cached rates: {e}")
            return None

    async def _update_database(
        self, rates: Dict[str, float], source: str
    ) -> None:
        """Update exchange rates in SQLite database."""
        try:
            async with async_session_maker() as session:
                # Create table if not exists
                await session.execute(
                    text("""
                        CREATE TABLE IF NOT EXISTS exchange_rates (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                            currency TEXT NOT NULL,
                            rate REAL NOT NULL,
                            source TEXT CHECK(source IN ('api', 'fallback')) DEFAULT 'api',
                            UNIQUE(timestamp, currency)
                        )
                    """)
                )

                # Create index
                await session.execute(
                    text("""
                        CREATE INDEX IF NOT EXISTS idx_exchange_rates_currency_timestamp 
                        ON exchange_rates(currency, timestamp DESC)
                    """)
                )

                # Insert/update rates
                timestamp = datetime.utcnow().isoformat()
                for currency, rate in rates.items():
                    if not currency.startswith("_") and isinstance(rate, (int, float)):
                        await session.execute(
                            text("""
                                INSERT INTO exchange_rates (timestamp, currency, rate, source)
                                VALUES (:timestamp, :currency, :rate, :source)
                                ON CONFLICT(timestamp, currency) DO UPDATE SET
                                    rate = excluded.rate,
                                    source = excluded.source
                            """),
                            {
                                "timestamp": timestamp,
                                "currency": currency,
                                "rate": rate,
                                "source": source,
                            },
                        )

                await session.commit()
                logger.info(f"[CurrencyService] 📊 Database updated ({source})")

        except Exception as e:
            logger.error(f"[CurrencyService] Failed to update database: {e}")
            # Non-fatal: JSON cache is primary storage

    async def get_rates(self, base_currency: str = "EUR") -> Dict[str, float]:
        """
        Get all exchange rates with optional base currency conversion.
        """
        rates = await self._load_cached_rates()

        if not rates:
            # Initialize if empty
            rates = await self.load_rates()

        if base_currency == "EUR":
            return rates

        # Convert to new base currency
        base_rate = rates.get(base_currency)
        if not base_rate:
            raise ValueError(f"Unknown base currency: {base_currency}")

        return {
            currency: round(rate / base_rate, 6)
            for currency, rate in rates.items()
            if not currency.startswith("_")
        }

    async def convert(
        self, amount: float, from_currency: str, to_currency: str
    ) -> float:
        """
        Convert amount from one currency to another.
        """
        if from_currency == to_currency:
            return amount

        rates = await self.get_rates("EUR")

        from_rate = rates.get(from_currency)
        to_rate = rates.get(to_currency)

        if not from_rate or not to_rate:
            raise ValueError(
                f"Conversion not available: {from_currency} -> {to_currency}"
            )

        # Convert via EUR: (amount / from_rate) * to_rate
        result = (amount / from_rate) * to_rate
        return round(result, 2)

    async def get_last_update_time(self) -> Optional[datetime]:
        """Get the timestamp of the last rate update."""
        try:
            rates = await self._load_cached_rates()
            if rates and "_meta" in rates:
                meta = rates["_meta"]
                if "last_updated" in meta:
                    return datetime.fromisoformat(meta["last_updated"])
        except Exception:
            pass
        return None


# Singleton instance
currency_service = CurrencyService()
