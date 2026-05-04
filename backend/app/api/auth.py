"""
Authentication API routes.

POST /auth/register  — create new user
POST /auth/login     — returns JWT
GET  /auth/me        — current user profile
PUT  /auth/me        — update profile
"""

from datetime import date, datetime
from typing import Optional

from app.core.database import get_db
from app.core.rate_limit import SlidingWindowRateLimiter
from app.core.security import (
    create_access_token,
    get_current_user,
    hash_password,
    verify_password,
)
from app.models.models import User
from app.services.currency_service import REFERENCE_CURRENCIES
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter()
login_rate_limiter = SlidingWindowRateLimiter(max_requests=8, window_seconds=60)


# ── Schemas ───────────────────────────────────────────────────


class UserRegisterRequest(BaseModel):
    email: EmailStr
    password: str
    name: str

    @field_validator("password")
    @classmethod
    def password_min_length(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters.")
        return v


class UserLoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: int
    name: str
    email: str


class UserProfileResponse(BaseModel):
    id: int
    email: str
    name: str
    is_active: bool
    created_at: datetime
    date_of_birth: Optional[datetime]
    birthdate: Optional[str]  # ISO date string YYYY-MM-DD for frontend convenience
    retirement_age: int
    currency: str
    locale: str
    saron_reference_annual_pct: float


class UserUpdateRequest(BaseModel):
    name: Optional[str] = None
    date_of_birth: Optional[datetime] = None
    birthdate: Optional[str] = (
        None  # ISO date string YYYY-MM-DD from frontend datepicker
    )
    retirement_age: Optional[int] = None
    currency: Optional[str] = None
    locale: Optional[str] = None
    saron_reference_annual_pct: Optional[float] = Field(default=None, ge=0.0, le=25.0)
    current_password: Optional[str] = None
    new_password: Optional[str] = None

    @field_validator("new_password")
    @classmethod
    def new_password_min_length(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and len(v) < 8:
            raise ValueError("New password must be at least 8 characters.")
        return v


# ── Routes ────────────────────────────────────────────────────


@router.post(
    "/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED
)
async def register(payload: UserRegisterRequest, db: AsyncSession = Depends(get_db)):
    """Register a new user account."""
    existing = await db.execute(select(User).where(User.email == payload.email))
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="An account with this email already exists.",
        )

    user = User(
        email=payload.email,
        hashed_password=hash_password(payload.password),
        name=payload.name,
        is_active=True,
    )
    db.add(user)
    await db.flush()
    await db.commit()
    await db.refresh(user)

    token = create_access_token(str(user.id))
    return TokenResponse(
        access_token=token,
        user_id=user.id,
        name=user.name,
        email=user.email,
    )


@router.post("/login", response_model=TokenResponse)
async def login(
    payload: UserLoginRequest, request: Request, db: AsyncSession = Depends(get_db)
):
    """Authenticate and receive a JWT access token."""
    # Basic brute-force protection: limit attempts per client+email.
    client_ip = request.client.host if request.client else "unknown"
    limit_key = f"{client_ip}:{payload.email.lower()}"
    decision = login_rate_limiter.check(limit_key)
    if not decision.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many login attempts. Try again in {decision.retry_after_seconds}s.",
        )

    result = await db.execute(select(User).where(User.email == payload.email))
    user = result.scalar_one_or_none()

    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is deactivated.",
        )

    token = create_access_token(str(user.id))
    # Successful login resets the attempt window for this key.
    login_rate_limiter.reset(limit_key)
    return TokenResponse(
        access_token=token,
        user_id=user.id,
        name=user.name,
        email=user.email,
    )


@router.get("/me", response_model=UserProfileResponse)
async def get_me(current_user: User = Depends(get_current_user)):
    """Return the current user's profile."""
    return UserProfileResponse(
        id=current_user.id,
        email=current_user.email,
        name=current_user.name,
        is_active=current_user.is_active,
        created_at=current_user.created_at,
        date_of_birth=current_user.date_of_birth,
        birthdate=current_user.date_of_birth.strftime("%Y-%m-%d")
        if current_user.date_of_birth
        else None,
        retirement_age=current_user.retirement_age,
        currency=current_user.currency,
        locale=current_user.locale,
        saron_reference_annual_pct=float(current_user.saron_reference_annual_pct),
    )


@router.put("/me", response_model=UserProfileResponse)
async def update_me(
    payload: UserUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update the current user's profile."""
    if payload.name is not None:
        current_user.name = payload.name
    if payload.date_of_birth is not None:
        current_user.date_of_birth = payload.date_of_birth
    if payload.birthdate is not None:
        # Accept ISO date string "YYYY-MM-DD" from frontend datepicker
        try:
            current_user.date_of_birth = datetime.strptime(
                payload.birthdate, "%Y-%m-%d"
            )
        except ValueError:
            raise HTTPException(
                status_code=400, detail="birthdate must be in YYYY-MM-DD format."
            )
    elif payload.birthdate == "":
        current_user.date_of_birth = None
    if payload.retirement_age is not None:
        current_user.retirement_age = payload.retirement_age
    if payload.currency is not None:
        cur = payload.currency.strip().upper()
        if cur not in REFERENCE_CURRENCIES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"currency must be one of: {', '.join(sorted(REFERENCE_CURRENCIES))}",
            )
        current_user.currency = cur
    if payload.locale is not None:
        current_user.locale = payload.locale
    if payload.saron_reference_annual_pct is not None:
        current_user.saron_reference_annual_pct = float(
            payload.saron_reference_annual_pct
        )

    # Handle password change
    if payload.new_password:
        if not payload.current_password:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="current_password is required to change password.",
            )
        if not verify_password(payload.current_password, current_user.hashed_password):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Current password is incorrect.",
            )
        current_user.hashed_password = hash_password(payload.new_password)

    await db.flush()
    await db.commit()
    await db.refresh(current_user)

    return UserProfileResponse(
        id=current_user.id,
        email=current_user.email,
        name=current_user.name,
        is_active=current_user.is_active,
        created_at=current_user.created_at,
        date_of_birth=current_user.date_of_birth,
        birthdate=current_user.date_of_birth.strftime("%Y-%m-%d")
        if current_user.date_of_birth
        else None,
        retirement_age=current_user.retirement_age,
        currency=current_user.currency,
        locale=current_user.locale,
        saron_reference_annual_pct=float(current_user.saron_reference_annual_pct),
    )
