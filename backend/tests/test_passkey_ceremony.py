"""Vollstaendige Passkey-Ceremonies mit einem Software-Authenticator.

Der Authenticator macht, was Touch ID macht: ein EC-P-256-Schluessel, der
Registrierung (attestation "none") und Anmeldung signiert. So laufen
Registrierung und Anmeldung einmal echt durch das Backend.
"""
import base64
import hashlib
import json
import os
import struct
from datetime import datetime, timedelta, timezone

import cbor2
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import select

from app.api import auth as auth_api
from app.api import webauthn as webauthn_api
from app.core.config import settings
from app.models.models import WebAuthnChallenge, WebAuthnCredential

ORIGIN = settings.webauthn_origins[0]
PASSWORD = "testpassword123"  # Passwort des test_user aus conftest


@pytest.fixture(autouse=True)
def sent(monkeypatch):
    mails = []

    async def fake_send(to, subject, text):
        mails.append({"to": to, "subject": subject})

    monkeypatch.setattr(webauthn_api.mailer, "send_mail", fake_send)
    monkeypatch.setattr(auth_api.mailer, "send_mail", fake_send)
    for limiter in (webauthn_api.login_limiter, webauthn_api.register_limiter,
                    auth_api.forgot_ip_limiter, auth_api.forgot_email_limiter, auth_api.reset_limiter):
        limiter._events.clear()
    return mails


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


class SoftAuthenticator:
    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.cred_id = os.urandom(32)
        self.count = 0
        self.user_handle = b""

    def _rp_hash(self, rp_id):
        return hashlib.sha256(rp_id.encode()).digest()

    def create(self, options):
        self.user_handle = base64.urlsafe_b64decode(options["user"]["id"] + "==")
        client_data = json.dumps({
            "type": "webauthn.create", "challenge": options["challenge"],
            "origin": ORIGIN, "crossOrigin": False,
        }).encode()
        nums = self.key.public_key().public_numbers()
        cose = cbor2.dumps({1: 2, 3: -7, -1: 1,
                            -2: nums.x.to_bytes(32, "big"), -3: nums.y.to_bytes(32, "big")})
        auth_data = (self._rp_hash(options["rp"]["id"]) + bytes([0x45]) + struct.pack(">I", 0)
                     + b"\0" * 16 + struct.pack(">H", len(self.cred_id)) + self.cred_id + cose)
        att = cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": auth_data})
        return {"id": b64(self.cred_id), "rawId": b64(self.cred_id), "type": "public-key",
                "response": {"clientDataJSON": b64(client_data), "attestationObject": b64(att)},
                "clientExtensionResults": {}}

    def get(self, options, *, user_verified=True):
        self.count += 1
        client_data = json.dumps({
            "type": "webauthn.get", "challenge": options["challenge"],
            "origin": ORIGIN, "crossOrigin": False,
        }).encode()
        flags = 0x05 if user_verified else 0x01  # UP (+ UV)
        auth_data = self._rp_hash(options["rpId"]) + bytes([flags]) + struct.pack(">I", self.count)
        sig = self.key.sign(auth_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256()))
        return {"id": b64(self.cred_id), "rawId": b64(self.cred_id), "type": "public-key",
                "response": {"clientDataJSON": b64(client_data), "authenticatorData": b64(auth_data),
                             "signature": b64(sig), "userHandle": b64(self.user_handle)},
                "clientExtensionResults": {}}


def _options(client, path, **kw):
    return json.loads(client.post(path, **kw).json())


def _register(client):
    auth = SoftAuthenticator()
    options = _options(client, "/api/auth/webauthn/register/options", json={"password": PASSWORD})
    res = client.post("/api/auth/webauthn/register/verify",
                      json={"credential": auth.create(options), "device_name": "Test"})
    assert res.status_code == 201, res.text
    return auth


def test_register_then_login_with_passkey(client):
    auth = _register(client)
    options = _options(client, "/api/auth/webauthn/login/options")
    res = client.post("/api/auth/webauthn/login/verify", json={"credential": auth.get(options)})
    assert res.status_code == 200, res.text
    token = res.json()["access_token"]
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200


def test_login_uses_the_challenge_it_was_given(client):
    """Zwei Anmeldungen zur selben Zeit (zwei Nutzer, zwei Tabs): jede geht mit
    ihrer eigenen Challenge durch. Frueher nahm verify die juengste Challenge
    aller Anmeldungen — wer die offene Route oft aufrief, blockierte alle."""
    auth = _register(client)
    mine = _options(client, "/api/auth/webauthn/login/options")
    _options(client, "/api/auth/webauthn/login/options")  # jemand anders, kurz danach
    res = client.post("/api/auth/webauthn/login/verify", json={"credential": auth.get(mine)})
    assert res.status_code == 200, res.text


def test_replayed_assertion_is_refused(client):
    auth = _register(client)
    options = _options(client, "/api/auth/webauthn/login/options")
    assertion = auth.get(options)
    assert client.post("/api/auth/webauthn/login/verify", json={"credential": assertion}).status_code == 200
    _options(client, "/api/auth/webauthn/login/options")
    again = client.post("/api/auth/webauthn/login/verify", json={"credential": assertion})
    assert again.status_code in (400, 401)


def test_adding_a_passkey_needs_the_password(client):
    res = client.post("/api/auth/webauthn/register/options", json={"password": "falsch-falsch"})
    # 400, nicht 401: ein 401 wuerde das Frontend abmelden
    assert res.status_code == 400
    assert client.post("/api/auth/webauthn/register/options").status_code == 422


def test_new_passkey_sends_info_mail(client, sent, test_user):
    _register(client)
    assert [m["to"] for m in sent] == [test_user.email]
    assert "Passkey" in sent[0]["subject"]


def test_login_without_user_verification_is_refused(client):
    """Ein Schluessel ohne PIN/Biometrie: Besitz allein reicht nicht."""
    auth = _register(client)
    options = _options(client, "/api/auth/webauthn/login/options")
    res = client.post(
        "/api/auth/webauthn/login/verify",
        json={"credential": auth.get(options, user_verified=False)},
    )
    assert res.status_code == 401


async def test_challenge_is_consumed_even_when_signature_fails(client, db_session):
    """Einmalgebrauch: auch eine gescheiterte Antwort verbraucht ihre Challenge."""
    auth = _register(client)
    options = _options(client, "/api/auth/webauthn/login/options")
    assertion = auth.get(options)
    assertion["response"]["signature"] = b64(b"\x30\x06\x02\x01\x01\x02\x01\x01")
    assert client.post("/api/auth/webauthn/login/verify", json={"credential": assertion}).status_code == 401
    left = (await db_session.execute(
        select(WebAuthnChallenge).where(WebAuthnChallenge.challenge == options["challenge"])
    )).scalars().all()
    assert left == []


def test_login_options_are_rate_limited(client):
    codes = [client.post("/api/auth/webauthn/login/options").status_code for _ in range(31)]
    assert codes[:30] == [200] * 30 and codes[30] == 429


def test_device_name_is_limited_to_the_column(client):
    auth = SoftAuthenticator()
    options = _options(client, "/api/auth/webauthn/register/options", json={"password": PASSWORD})
    res = client.post(
        "/api/auth/webauthn/register/verify",
        json={"credential": auth.create(options), "device_name": "x" * 121},
    )
    assert res.status_code == 422
    assert WebAuthnCredential.device_name.type.length == 120


async def test_password_reset_removes_passkeys(client, db_session, test_user):
    """"Passwort vergessen" rettet ein Konto — ein Passkey, den ein Eindringling
    angelegt hat, muss dabei mit raus."""
    uid = test_user.id  # vor den Anfragen lesen: danach ist das Objekt abgelaufen
    _register(client)
    # Offenen Reset-Link direkt anlegen, wie ihn /password/forgot anlegt
    raw = "reset-token-for-passkey-test-0123456789"
    user = (await db_session.execute(
        select(auth_api.User).where(auth_api.User.id == uid)
    )).scalar_one()
    user.password_reset_hash = auth_api._token_hash(raw)
    user.password_reset_expires = datetime.now(timezone.utc) + timedelta(minutes=5)
    await db_session.commit()

    res = client.post("/api/auth/password/reset", json={"token": raw, "new_password": "new-password-123"})
    assert res.status_code == 200
    db_session.expire_all()
    left = (await db_session.execute(
        select(WebAuthnCredential).where(WebAuthnCredential.user_id == uid)
    )).scalars().all()
    assert left == []
