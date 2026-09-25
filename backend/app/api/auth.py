"""
Authentication API routes.

POST /auth/register  — create new user
POST /auth/login     — returns JWT
GET  /auth/me        — current user profile
PUT  /auth/me        — update profile
POST /auth/password/forgot — Link zum Zuruecksetzen per E-Mail
POST /auth/password/reset  — neues Passwort mit diesem Link
POST /auth/password/change — Passwort aendern (angemeldet)
"""

import hashlib
import secrets
from datetime import date, datetime, timedelta, timezone
from typing import Annotated, Optional

from app.core.database import get_db
from app.core.rate_limit import SlidingWindowRateLimiter
from app.core.security import (
    SESSION_TIMEOUTS,
    create_access_token,
    session_timeout_delta,
    get_current_user,
    hash_password,
    verify_password,
)
from app.core.config import settings
from app.models.models import User, WebAuthnCredential
from app.services import mailer
from app.services.currency_service import REFERENCE_CURRENCIES
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import AfterValidator, BaseModel, EmailStr, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

# Unterstützte UI-Sprachen — bei neuen Sprachen hier und im Frontend (i18n) ergänzen
SUPPORTED_UI_LANGUAGES = {"de", "en"}

router = APIRouter()
login_rate_limiter = SlidingWindowRateLimiter(max_requests=8, window_seconds=60)
# Passwort vergessen: je IP und je Adresse, damit niemand Postfaecher flutet
forgot_ip_limiter = SlidingWindowRateLimiter(max_requests=10, window_seconds=900)
forgot_email_limiter = SlidingWindowRateLimiter(max_requests=3, window_seconds=900)
reset_limiter = SlidingWindowRateLimiter(max_requests=10, window_seconds=900)
# Je Nutzer: mit einer gestohlenen Sitzung das aktuelle Passwort durchprobieren
change_limiter = SlidingWindowRateLimiter(max_requests=5, window_seconds=300)

RESET_LINK_TTL = timedelta(minutes=30)
MIN_PASSWORD_LENGTH = 8


def _check_password_length(v: str) -> str:
    if len(v) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")
    return v


# Gleiche Regel fuer Registrierung, Zuruecksetzen und Aendern
Password = Annotated[str, AfterValidator(_check_password_length)]


# ── Schemas ───────────────────────────────────────────────────


class UserRegisterRequest(BaseModel):
    email: EmailStr
    password: Password
    name: str


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
    ui_language: str
    session_timeout: str
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
    ui_language: Optional[str] = None
    session_timeout: Optional[str] = None
    saron_reference_annual_pct: Optional[float] = Field(default=None, ge=0.0, le=25.0)

    @field_validator("session_timeout")
    @classmethod
    def known_session_timeout(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in SESSION_TIMEOUTS:
            raise ValueError(
                f"session_timeout must be one of {sorted(SESSION_TIMEOUTS)}"
            )
        return v


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    new_password: Password


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: Password


# ── Routes ────────────────────────────────────────────────────


@router.post(
    "/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED
)
async def register(payload: UserRegisterRequest, db: AsyncSession = Depends(get_db)):
    """Register a new user account."""
    existing = await db.execute(
        select(User).where(func.lower(User.email) == payload.email.lower())
    )
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

    result = await db.execute(
        select(User).where(func.lower(User.email) == payload.email.lower())
    )
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

    # Anmeldedauer aus dem Profil — wirkt ab dieser Anmeldung
    token = create_access_token(
        str(user.id), session_timeout_delta(user.session_timeout)
    )
    # Successful login resets the attempt window for this key.
    login_rate_limiter.reset(limit_key)
    return TokenResponse(
        access_token=token,
        user_id=user.id,
        name=user.name,
        email=user.email,
    )


# ── Passwort ──────────────────────────────────────────────────

_MAILS = {
    "de": {
        "reset_subject": "Budget-Pal: Passwort zurücksetzen",
        "reset_text": (
            "Hallo {name}\n\n"
            "Für dein Budget-Pal-Konto wurde ein neues Passwort angefordert. "
            "Mit diesem Link setzt du es. Er gilt 30 Minuten und nur einmal:\n\n"
            "{link}\n\n"
            "Hast du das nicht angefordert, ignoriere diese Mail. Dein Passwort bleibt, wie es ist."
        ),
        "changed_subject": "Budget-Pal: Passwort geändert",
        "changed_text": (
            "Hallo {name}\n\n"
            "Das Passwort deines Budget-Pal-Kontos wurde eben geändert. "
            "Alle anderen Geräte sind abgemeldet.\n\n"
            "Warst du das nicht, setze das Passwort sofort über „Passwort vergessen?“ zurück:\n"
            "{link}"
        ),
        "passkey_subject": "Budget-Pal: neuer Passkey hinzugefügt",
        "passkey_text": (
            "Hallo {name}\n\n"
            "Deinem Budget-Pal-Konto wurde eben ein neuer Passkey hinzugefügt. "
            "Mit ihm kann man sich ohne Passwort anmelden.\n\n"
            "Warst du das nicht, entferne ihn unter Einstellungen → Sicherheit und "
            "ändere dein Passwort:\n{link}"
        ),
    },
    "en": {
        "reset_subject": "Budget-Pal: reset your password",
        "reset_text": (
            "Hello {name}\n\n"
            "A new password was requested for your Budget-Pal account. "
            "Use this link to set it. It is valid for 30 minutes and works once:\n\n"
            "{link}\n\n"
            "If you did not request this, ignore this email. Your password stays as it is."
        ),
        "changed_subject": "Budget-Pal: password changed",
        "changed_text": (
            "Hello {name}\n\n"
            "The password of your Budget-Pal account was just changed. "
            "All other devices have been signed out.\n\n"
            "If this wasn't you, reset your password right away via “Forgot password?”:\n"
            "{link}"
        ),
        "passkey_subject": "Budget-Pal: new passkey added",
        "passkey_text": (
            "Hello {name}\n\n"
            "A new passkey was just added to your Budget-Pal account. "
            "It can be used to sign in without a password.\n\n"
            "If this wasn't you, remove it under Settings → Security and "
            "change your password:\n{link}"
        ),
    },
}


def _mail_text(user: User, kind: str, link: str) -> tuple[str, str]:
    texts = _MAILS.get(user.ui_language, _MAILS["en"])
    return texts[f"{kind}_subject"], texts[f"{kind}_text"].format(name=user.name, link=link)


def _app_url(path: str) -> str:
    # Immer aus der Konfiguration, nie aus dem Host-Header der Anfrage
    return settings.app_base_url.rstrip("/") + path


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _as_utc(value: Optional[datetime]) -> Optional[datetime]:
    # SQLite liefert DateTime ohne Zeitzone zurueck; gespeichert ist UTC
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _set_password(user: User, new_password: str) -> None:
    """Einziger Weg, ein Passwort zu setzen: beendet alle bestehenden Sitzungen
    (password_changed_at) und macht einen offenen Reset-Link ungueltig."""
    user.hashed_password = hash_password(new_password)
    user.password_changed_at = datetime.now(timezone.utc)
    user.password_reset_hash = None
    user.password_reset_expires = None


def _limit(limiter: SlidingWindowRateLimiter, key: str) -> None:
    decision = limiter.check(key)
    if not decision.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many attempts. Try again in {decision.retry_after_seconds}s.",
        )


@router.post("/password/forgot", status_code=status.HTTP_202_ACCEPTED)
async def forgot_password(
    payload: ForgotPasswordRequest,
    request: Request,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Schickt einen Link zum Zuruecksetzen. Die Antwort ist immer dieselbe —
    sie verraet nicht, ob es zur Adresse ein Konto gibt. Die Mail geht im
    Hintergrund raus, damit auch die Antwortzeit nichts verraet."""
    email = payload.email.lower()
    _limit(forgot_ip_limiter, request.client.host if request.client else "unknown")
    _limit(forgot_email_limiter, email)

    user = (
        await db.execute(select(User).where(func.lower(User.email) == email))
    ).scalar_one_or_none()
    if user and user.is_active:
        token = secrets.token_urlsafe(32)
        user.password_reset_hash = _token_hash(token)
        user.password_reset_expires = datetime.now(timezone.utc) + RESET_LINK_TTL
        await db.commit()
        # Token im Fragment: der Browser schickt es nie an einen Server,
        # es steht also in keinem Zugriffslog und keinem Referer
        link = _app_url(f"/reset-password#token={token}")
        background.add_task(mailer.send_mail, user.email, *_mail_text(user, "reset", link))

    return {"detail": "If an account exists for this address, an email is on its way."}


@router.post("/password/reset")
async def reset_password(
    payload: ResetPasswordRequest,
    request: Request,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Setzt das Passwort mit dem Link aus der Mail. Danach ist der Link
    verbraucht und jede bestehende Sitzung beendet."""
    _limit(reset_limiter, request.client.host if request.client else "unknown")

    user = (
        await db.execute(
            select(User).where(User.password_reset_hash == _token_hash(payload.token))
        )
    ).scalar_one_or_none()
    expires = _as_utc(user.password_reset_expires) if user else None
    if not user or not user.is_active or not expires or expires < datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This link is invalid or has expired.",
        )

    _set_password(user, payload.new_password)
    # "Passwort vergessen" ist der Weg zur Kontorettung: ein Passkey, den ein
    # Eindringling angelegt hat, muss dabei mit raus. Eigene Passkeys legt der
    # Nutzer danach neu an.
    await db.execute(delete(WebAuthnCredential).where(WebAuthnCredential.user_id == user.id))
    await db.commit()
    background.add_task(
        mailer.send_mail, user.email, *_mail_text(user, "changed", _app_url("/forgot-password"))
    )
    return {"detail": "Password has been reset."}


@router.post("/password/change", response_model=TokenResponse)
async def change_password(
    payload: ChangePasswordRequest,
    background: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Passwort aendern. Alle anderen Sitzungen enden; diese bekommt ein neues
    Token. Falsches aktuelles Passwort ist 400, nicht 401 — ein 401 meldet das
    Frontend ab."""
    _limit(change_limiter, str(current_user.id))
    if not verify_password(payload.current_password, current_user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect.",
        )

    _set_password(current_user, payload.new_password)
    await db.commit()
    # Nach dem Wechsel ausgestellt, gilt also weiter
    token = create_access_token(
        str(current_user.id), session_timeout_delta(current_user.session_timeout)
    )
    background.add_task(
        mailer.send_mail,
        current_user.email,
        *_mail_text(current_user, "changed", _app_url("/forgot-password")),
    )
    return TokenResponse(
        access_token=token,
        user_id=current_user.id,
        name=current_user.name,
        email=current_user.email,
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
        ui_language=current_user.ui_language,
        session_timeout=current_user.session_timeout,
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
        if payload.birthdate == "":
            # Empty string clears the birthdate
            current_user.date_of_birth = None
        else:
            # Accept ISO date string "YYYY-MM-DD" from frontend datepicker
            try:
                current_user.date_of_birth = datetime.strptime(
                    payload.birthdate, "%Y-%m-%d"
                )
            except ValueError:
                raise HTTPException(
                    status_code=400, detail="birthdate must be in YYYY-MM-DD format."
                )
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
    if payload.session_timeout is not None:
        current_user.session_timeout = payload.session_timeout
    if payload.ui_language is not None:
        lang = payload.ui_language.strip().lower()
        if lang not in SUPPORTED_UI_LANGUAGES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"ui_language must be one of: {', '.join(sorted(SUPPORTED_UI_LANGUAGES))}",
            )
        current_user.ui_language = lang
    if payload.saron_reference_annual_pct is not None:
        current_user.saron_reference_annual_pct = float(
            payload.saron_reference_annual_pct
        )

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
        ui_language=current_user.ui_language,
        session_timeout=current_user.session_timeout,
        saron_reference_annual_pct=float(current_user.saron_reference_annual_pct),
    )
