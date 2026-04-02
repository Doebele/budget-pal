"""
Currency Exchange API Routes
Provides endpoints for fetching exchange rates and converting amounts.
"""

from typing import Dict, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.services.currency_service import currency_service
from app.core.security import get_current_user
from app.models.models import User

router = APIRouter()


class ExchangeRatesResponse(BaseModel):
    """Response model for exchange rates."""
    base: str
    rates: Dict[str, float]
    last_updated: Optional[str] = None


class ConversionRequest(BaseModel):
    """Request model for currency conversion."""
    amount: float
    from_currency: str
    to_currency: str


class ConversionResponse(BaseModel):
    """Response model for currency conversion."""
    original_amount: float
    original_currency: str
    converted_amount: float
    target_currency: str
    exchange_rate: float


@router.get("/rates", response_model=ExchangeRatesResponse)
async def get_exchange_rates(
    base: str = Query(default="EUR", description="Base currency (e.g., EUR, CHF, USD)"),
    current_user: User = Depends(get_current_user),
):
    """
    Get current exchange rates with optional base currency.
    Requires authentication.
    """
    try:
        rates = await currency_service.get_rates(base)
        last_update = await currency_service.get_last_update_time()

        return ExchangeRatesResponse(
            base=base,
            rates=rates,
            last_updated=last_update.isoformat() if last_update else None,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch rates: {e}")


@router.post("/convert", response_model=ConversionResponse)
async def convert_currency(
    request: ConversionRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Convert an amount from one currency to another.
    Requires authentication.
    """
    try:
        # Validate currencies exist
        rates = await currency_service.get_rates("EUR")
        if request.from_currency not in rates:
            raise HTTPException(
                status_code=400, detail=f"Unknown currency: {request.from_currency}"
            )
        if request.to_currency not in rates:
            raise HTTPException(
                status_code=400, detail=f"Unknown currency: {request.to_currency}"
            )

        converted = await currency_service.convert(
            request.amount, request.from_currency, request.to_currency
        )

        # Calculate displayed rate
        from_rate = rates[request.from_currency]
        to_rate = rates[request.to_currency]
        exchange_rate = round(to_rate / from_rate, 6)

        return ConversionResponse(
            original_amount=request.amount,
            original_currency=request.from_currency,
            converted_amount=converted,
            target_currency=request.to_currency,
            exchange_rate=exchange_rate,
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Conversion failed: {e}")


@router.get("/supported")
async def get_supported_currencies(
    current_user: User = Depends(get_current_user),
):
    """
    Get list of supported currencies.
    Requires authentication.
    """
    try:
        rates = await currency_service.get_rates("EUR")
        currencies = sorted([c for c in rates.keys() if not c.startswith("_")])

        return {
            "currencies": currencies,
            "count": len(currencies),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch currencies: {e}")
