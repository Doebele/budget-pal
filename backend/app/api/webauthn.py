"""
Passkeys (WebAuthn / FIDO2) — Anmeldung per Face ID, Touch ID, Windows Hello
oder Sicherheitsschluessel.

Vier Ceremonies, jeweils zweistufig (Optionen holen, Antwort verifizieren):

  POST /auth/webauthn/register/options   angemeldet  → Registrierung starten
  POST /auth/webauthn/register/verify    angemeldet  → Passkey speichern
  POST /auth/webauthn/login/options      offen       → Anmeldung starten
  POST /auth/webauthn/login/verify       offen       → Token ausstellen

  GET    /auth/webauthn/credentials      angemeldet  → eigene Passkeys
  DELETE /auth/webauthn/credentials/{id} angemeldet  → Passkey entfernen

Zwei Dinge, die hier anders sind als in einem Ein-Prozess-Backend:

- Die Challenge liegt in der Datenbank, nicht im Arbeitsspeicher. Das Backend
  laeuft mit mehreren Workern; die Verifikation trifft nicht zwingend den
  Prozess, der die Challenge ausgestellt hat.
- rp_id und origin kommen aus der Konfiguration. WebAuthn bindet einen Passkey
  fest an die Domain — passt der Wert nicht zur aufgerufenen Adresse, lehnt der
  Browser die Ceremony ab, noch bevor das Backend etwas sieht.
"""
from __future__ import annotations

import base64
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from app.core.config import settings
from app.core.database import get_db
from app.core.security import create_access_token, get_current_user, session_timeout_delta
from app.models.models import User, WebAuthnChallenge, WebAuthnCredential

logger = logging.getLogger(__name__)
router = APIRouter()

# Eine Ceremony ist eine Interaktion, keine Sitzung — kurz halten.
CHALLENGE_TTL = timedelta(minutes=5)


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


async def _store_challenge(
    db: AsyncSession, challenge: bytes, purpose: str, user_id: Optional[int]
) -> None:
    """Challenge ablegen und dabei abgelaufene aufraeumen."""
    now = datetime.now(timezone.utc)
    await db.execute(
        delete(WebAuthnChallenge).where(WebAuthnChallenge.expires_at < now)
    )
    db.add(
        WebAuthnChallenge(
            challenge=_b64(challenge),
            user_id=user_id,
            purpose=purpose,
            expires_at=now + CHALLENGE_TTL,
        )
    )
    await db.commit()


async def _take_challenge(db: AsyncSession, purpose: str, user_id: Optional[int]) -> bytes:
    """Juengste gueltige Challenge holen UND verbrauchen.

    Einmalgebrauch ist der Kern des Verfahrens — bliebe sie liegen, waere eine
    abgefangene Antwort wiederverwendbar.
    """
    filters = [
        WebAuthnChallenge.purpose == purpose,
        WebAuthnChallenge.expires_at >= datetime.now(timezone.utc),
    ]
    if user_id is not None:
        filters.append(WebAuthnChallenge.user_id == user_id)

    result = await db.execute(
        select(WebAuthnChallenge)
        .where(*filters)
        .order_by(WebAuthnChallenge.id.desc())
        .limit(1)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Keine gültige Challenge — bitte erneut versuchen.",
        )
    challenge = _unb64(row.challenge)
    await db.delete(row)
    await db.commit()
    return challenge


# ── Schemas ───────────────────────────────────────────────────


class RegisterVerifyRequest(BaseModel):
    credential: dict
    device_name: Optional[str] = None


class LoginVerifyRequest(BaseModel):
    credential: dict


class CredentialResponse(BaseModel):
    id: int
    device_name: Optional[str]
    created_at: datetime
    last_used_at: Optional[datetime]


class PasskeyTokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: int
    name: str
    email: str


# ── Registrierung ─────────────────────────────────────────────


@router.post("/register/options")
async def register_options(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Optionen für einen neuen Passkey des angemeldeten Nutzers."""
    existing = (
        await db.execute(
            select(WebAuthnCredential.credential_id).where(
                WebAuthnCredential.user_id == current_user.id
            )
        )
    ).scalars().all()

    options = generate_registration_options(
        rp_id=settings.webauthn_rp_id,
        rp_name=settings.webauthn_rp_name,
        user_id=str(current_user.id).encode(),
        user_name=current_user.email,
        user_display_name=current_user.name,
        # Bereits registrierte Schluessel ausschliessen, damit derselbe
        # Authenticator nicht zweimal angelegt wird
        exclude_credentials=[
            PublicKeyCredentialDescriptor(id=_unb64(cid)) for cid in existing
        ],
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.PREFERRED,
        ),
    )
    await _store_challenge(db, options.challenge, "register", current_user.id)
    return options_to_json(options)


@router.post("/register/verify", response_model=CredentialResponse, status_code=201)
async def register_verify(
    payload: RegisterVerifyRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Antwort des Authenticators pruefen und den Passkey speichern."""
    challenge = await _take_challenge(db, "register", current_user.id)

    try:
        verified = verify_registration_response(
            credential=payload.credential,
            expected_challenge=challenge,
            expected_rp_id=settings.webauthn_rp_id,
            expected_origin=settings.webauthn_origins,
        )
    except Exception as e:
        logger.warning("Passkey-Registrierung abgelehnt: %s: %s", type(e).__name__, e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Passkey konnte nicht verifiziert werden.",
        )

    credential = WebAuthnCredential(
        user_id=current_user.id,
        credential_id=_b64(verified.credential_id),
        public_key=_b64(verified.credential_public_key),
        sign_count=verified.sign_count,
        device_name=(payload.device_name or "").strip() or None,
    )
    db.add(credential)
    await db.commit()
    await db.refresh(credential)
    return CredentialResponse(
        id=credential.id,
        device_name=credential.device_name,
        created_at=credential.created_at,
        last_used_at=credential.last_used_at,
    )


# ── Anmeldung ─────────────────────────────────────────────────


@router.post("/login/options")
async def login_options(db: AsyncSession = Depends(get_db)):
    """Optionen für die Anmeldung. Bewusst ohne Nutzerbezug — der Authenticator
    waehlt selbst, welcher hinterlegte Passkey passt."""
    options = generate_authentication_options(
        rp_id=settings.webauthn_rp_id,
        user_verification=UserVerificationRequirement.PREFERRED,
    )
    await _store_challenge(db, options.challenge, "login", None)
    return options_to_json(options)


@router.post("/login/verify", response_model=PasskeyTokenResponse)
async def login_verify(
    payload: LoginVerifyRequest, db: AsyncSession = Depends(get_db)
):
    """Antwort pruefen und bei Erfolg ein Token ausstellen."""
    challenge = await _take_challenge(db, "login", None)

    raw_id = payload.credential.get("id")
    if not raw_id:
        raise HTTPException(status_code=400, detail="Ungültige Antwort.")

    credential = (
        await db.execute(
            select(WebAuthnCredential).where(
                WebAuthnCredential.credential_id == raw_id
            )
        )
    ).scalar_one_or_none()
    if credential is None:
        raise HTTPException(status_code=401, detail="Unbekannter Passkey.")

    try:
        verified = verify_authentication_response(
            credential=payload.credential,
            expected_challenge=challenge,
            expected_rp_id=settings.webauthn_rp_id,
            expected_origin=settings.webauthn_origins,
            credential_public_key=_unb64(credential.public_key),
            credential_current_sign_count=credential.sign_count,
        )
    except Exception as e:
        logger.warning("Passkey-Anmeldung abgelehnt: %s: %s", type(e).__name__, e)
        raise HTTPException(status_code=401, detail="Passkey nicht akzeptiert.")

    user = await db.get(User, credential.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=403, detail="Konto ist deaktiviert.")

    credential.sign_count = verified.new_sign_count
    credential.last_used_at = datetime.now(timezone.utc)
    await db.commit()

    token = create_access_token(str(user.id), session_timeout_delta(user.session_timeout))
    return PasskeyTokenResponse(
        access_token=token, user_id=user.id, name=user.name, email=user.email
    )


# ── Verwaltung ────────────────────────────────────────────────


@router.get("/credentials", response_model=List[CredentialResponse])
async def list_credentials(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(WebAuthnCredential)
        .where(WebAuthnCredential.user_id == current_user.id)
        .order_by(WebAuthnCredential.created_at.desc())
    )
    return [
        CredentialResponse(
            id=c.id,
            device_name=c.device_name,
            created_at=c.created_at,
            last_used_at=c.last_used_at,
        )
        for c in result.scalars()
    ]


@router.delete("/credentials/{credential_id}", status_code=204)
async def delete_credential(
    credential_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(WebAuthnCredential).where(
            WebAuthnCredential.id == credential_id,
            WebAuthnCredential.user_id == current_user.id,
        )
    )
    credential = result.scalar_one_or_none()
    if credential is None:
        raise HTTPException(status_code=404, detail="Passkey nicht gefunden.")
    await db.delete(credential)
    await db.commit()
