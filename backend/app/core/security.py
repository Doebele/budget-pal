"""
Security utilities: JWT token creation/verification, password hashing.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi import HTTPException, status, Depends
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.config import settings
from app.core.database import get_db

# ── Password Hashing ─────────────────────────────────────────

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)


def hash_password(plain_password: str) -> str:
    """Hash a plaintext password using bcrypt."""
    return pwd_context.hash(plain_password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a plaintext password against its hash."""
    return pwd_context.verify(plain_password, hashed_password)


# ── JWT ───────────────────────────────────────────────────────

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def create_access_token(subject: str, expires_delta: Optional[timedelta] = None) -> str:
    """Create a signed JWT access token.

    Args:
        subject: The user ID (as string) to embed in the token.
        expires_delta: Optional custom TTL. Defaults to settings value.
    """
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.access_token_expire_minutes)
    )
    payload = {
        "sub": subject,
        "exp": expire,
        "iat": datetime.now(timezone.utc),
        "type": "access",
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> str:
    """Decode and validate a JWT access token.

    Returns:
        The subject (user ID) extracted from the token.

    Raises:
        HTTPException 401 if token is invalid or expired.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials.",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        subject: Optional[str] = payload.get("sub")
        if subject is None:
            raise credentials_exception
        return subject
    except JWTError:
        raise credentials_exception


# ── Current User Dependency ───────────────────────────────────

async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
):
    """FastAPI dependency — returns the current authenticated user model.

    Raises 401 if token invalid or user not found / inactive.
    """
    from app.models.models import User  # local import to avoid circular

    user_id_str = decode_access_token(token)
    try:
        user_id = int(user_id_str)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token subject.")

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()

    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found.")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user account.")

    return user
