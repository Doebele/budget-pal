"""
Authentication API routes.

POST /auth/register  — create new user
POST /auth/login     — returns JWT
GET  /auth/me        — current user profile
PUT  /auth/me        — update profile
"""
from datetime import datetime, date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db
from app.core.security import hash_password, verify_password, create_access_token, get_current_user
from app.models.models import User

router = APIRouter()


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


class UserUpdateRequest(BaseModel):
    name: Optional[str] = None
    date_of_birth: Optional[datetime] = None
    birthdate: Optional[str] = None  # ISO date string YYYY-MM-DD from frontend datepicker
    retirement_age: Optional[int] = None
    currency: Optional[str] = None
    locale: Optional[str] = None
    current_password: Optional[str] = None
    new_password: Optional[str] = None

    @field_validator("new_password")
    @classmethod
    def new_password_min_length(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and len(v) < 8:
            raise ValueError("New password must be at least 8 characters.")
        return v


# ── Routes ────────────────────────────────────────────────────

@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
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
    await db.flush()  # get the generated ID before commit
    await db.refresh(user)

    token = create_access_token(str(user.id))
    return TokenResponse(
        access_token=token,
        user_id=user.id,
        name=user.name,
        email=user.email,
    )


@router.post("/login", response_model=TokenResponse)
async def login(payload: UserLoginRequest, db: AsyncSession = Depends(get_db)):
    """Authenticate and receive a JWT access token."""
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
        birthdate=current_user.date_of_birth.strftime("%Y-%m-%d") if current_user.date_of_birth else None,
        retirement_age=current_user.retirement_age,
        currency=current_user.currency,
        locale=current_user.locale,
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
            current_user.date_of_birth = datetime.strptime(payload.birthdate, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="birthdate must be in YYYY-MM-DD format.")
    elif payload.birthdate == "":
        current_user.date_of_birth = None
    if payload.retirement_age is not None:
        current_user.retirement_age = payload.retirement_age
    if payload.currency is not None:
        current_user.currency = payload.currency
    if payload.locale is not None:
        current_user.locale = payload.locale

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
    await db.refresh(current_user)

    return UserProfileResponse(
        id=current_user.id,
        email=current_user.email,
        name=current_user.name,
        is_active=current_user.is_active,
        created_at=current_user.created_at,
        date_of_birth=current_user.date_of_birth,
        birthdate=current_user.date_of_birth.strftime("%Y-%m-%d") if current_user.date_of_birth else None,
        retirement_age=current_user.retirement_age,
        currency=current_user.currency,
        locale=current_user.locale,
    )
