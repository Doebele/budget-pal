"""Passwort vergessen, zuruecksetzen und aendern.

Es geht keine echte Mail raus: mailer.send_mail ist ersetzt und sammelt die
Aufrufe ein.
"""
import re
from datetime import datetime, timedelta, timezone

import pytest
from jose import jwt
from sqlalchemy import select

from app.api import auth
from app.core.config import settings
from app.models.models import User

EMAIL = "test@example.com"
OLD_PW = "testpassword123"
NEW_PW = "brandnewpassword456"


@pytest.fixture(autouse=True)
def sent(monkeypatch):
    mails = []

    async def fake_send(to, subject, text):
        mails.append({"to": to, "subject": subject, "text": text})

    monkeypatch.setattr(auth.mailer, "send_mail", fake_send)
    monkeypatch.setattr(settings, "app_base_url", "https://budgetpal.example")
    # Die Limiter sind modulweit; jeder Test beginnt mit leerem Fenster
    for limiter in (auth.forgot_ip_limiter, auth.forgot_email_limiter,
                    auth.reset_limiter, auth.change_limiter, auth.login_rate_limiter):
        limiter._events.clear()
    return mails


def _token_from(mail) -> str:
    return re.search(r"/reset-password#token=([\w-]+)", mail["text"]).group(1)


def _older_token(user_id: int) -> str:
    """Token, das eine Minute vor jetzt ausgestellt wurde — wie eine Sitzung
    auf einem anderen Geraet."""
    now = datetime.now(timezone.utc)
    claims = {"sub": str(user_id), "iat": now - timedelta(minutes=1), "exp": now + timedelta(hours=1)}
    return jwt.encode(claims, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


async def _reload(db_session, user_id) -> User:
    db_session.expire_all()
    return (await db_session.execute(select(User).where(User.id == user_id))).scalar_one()


def _login(client, password):
    return client.post("/api/auth/login", json={"email": EMAIL, "password": password})


# ── Passwort vergessen ───────────────────────────────────────


def test_unknown_email_gets_same_answer_and_no_mail(client, sent):
    known = client.post("/api/auth/password/forgot", json={"email": EMAIL})
    unknown = client.post("/api/auth/password/forgot", json={"email": "nobody@example.com"})
    assert known.status_code == unknown.status_code == 202
    assert known.json() == unknown.json()
    assert [m["to"] for m in sent] == [EMAIL]


def test_link_uses_configured_base_url_not_host_header(client, sent):
    client.post(
        "/api/auth/password/forgot", json={"email": EMAIL}, headers={"Host": "evil.example"}
    )
    assert "https://budgetpal.example/reset-password#token=" in sent[0]["text"]
    assert "evil.example" not in sent[0]["text"]


async def test_only_the_hash_is_stored(client, sent, db_session, test_user):
    client.post("/api/auth/password/forgot", json={"email": EMAIL})
    token = _token_from(sent[0])
    user = await _reload(db_session, test_user.id)
    assert user.password_reset_hash == auth._token_hash(token)
    assert token not in (user.password_reset_hash or "")
    assert len(user.password_reset_hash) <= User.password_reset_hash.type.length


def test_forgot_is_rate_limited_per_email(client, sent):
    codes = [client.post("/api/auth/password/forgot", json={"email": EMAIL}).status_code for _ in range(4)]
    assert codes == [202, 202, 202, 429]


# ── Zuruecksetzen ────────────────────────────────────────────


async def test_reset_works_once_and_ends_old_sessions(client, sent, test_user):
    old_session = _older_token(test_user.id)
    client.post("/api/auth/password/forgot", json={"email": EMAIL})
    token = _token_from(sent[0])

    res = client.post("/api/auth/password/reset", json={"token": token, "new_password": NEW_PW})
    assert res.status_code == 200
    assert _login(client, NEW_PW).status_code == 200
    assert _login(client, OLD_PW).status_code == 401
    # Info-Mail an den Kontoinhaber
    assert sent[-1]["subject"].endswith(("geändert", "changed"))

    # Die Sitzung vom anderen Geraet ist beendet
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {old_session}"})
    assert me.status_code == 401

    again = client.post("/api/auth/password/reset", json={"token": token, "new_password": "another-pw-789"})
    assert again.status_code == 400


def test_wrong_token_is_refused(client, sent):
    res = client.post(
        "/api/auth/password/reset", json={"token": "x" * 43, "new_password": NEW_PW}
    )
    assert res.status_code == 400


async def test_expired_token_is_refused(client, sent, db_session, test_user):
    client.post("/api/auth/password/forgot", json={"email": EMAIL})
    token = _token_from(sent[0])
    user = await _reload(db_session, test_user.id)
    user.password_reset_expires = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db_session.commit()

    res = client.post("/api/auth/password/reset", json={"token": token, "new_password": NEW_PW})
    assert res.status_code == 400
    assert _login(client, OLD_PW).status_code == 200


def test_new_request_replaces_old_link(client, sent):
    client.post("/api/auth/password/forgot", json={"email": EMAIL})
    client.post("/api/auth/password/forgot", json={"email": EMAIL})
    first, second = _token_from(sent[0]), _token_from(sent[1])
    assert client.post("/api/auth/password/reset", json={"token": first, "new_password": NEW_PW}).status_code == 400
    assert client.post("/api/auth/password/reset", json={"token": second, "new_password": NEW_PW}).status_code == 200


def test_reset_enforces_password_length(client, sent):
    client.post("/api/auth/password/forgot", json={"email": EMAIL})
    res = client.post(
        "/api/auth/password/reset", json={"token": _token_from(sent[0]), "new_password": "short"}
    )
    assert res.status_code == 422


# ── Aendern (angemeldet) ─────────────────────────────────────


def test_change_needs_current_password(client, sent):
    res = client.post(
        "/api/auth/password/change",
        json={"current_password": "wrong-password", "new_password": NEW_PW},
    )
    # 400, nicht 401: ein 401 wuerde das Frontend abmelden
    assert res.status_code == 400
    assert sent == []


async def test_change_keeps_this_session_and_ends_others(client, sent, test_user):
    other_device = _older_token(test_user.id)
    res = client.post(
        "/api/auth/password/change",
        json={"current_password": OLD_PW, "new_password": NEW_PW},
    )
    assert res.status_code == 200
    new_token = res.json()["access_token"]

    ok = client.get("/api/auth/me", headers={"Authorization": f"Bearer {new_token}"})
    assert ok.status_code == 200
    gone = client.get("/api/auth/me", headers={"Authorization": f"Bearer {other_device}"})
    assert gone.status_code == 401
    assert _login(client, NEW_PW).status_code == 200
    assert len(sent) == 1


def test_change_is_rate_limited(client, sent):
    codes = [
        client.post(
            "/api/auth/password/change",
            json={"current_password": "wrong-password", "new_password": NEW_PW},
        ).status_code
        for _ in range(6)
    ]
    assert codes == [400] * 5 + [429]


async def test_change_also_voids_open_reset_link(client, sent):
    client.post("/api/auth/password/forgot", json={"email": EMAIL})
    token = _token_from(sent[0])
    client.post(
        "/api/auth/password/change", json={"current_password": OLD_PW, "new_password": NEW_PW}
    )
    res = client.post("/api/auth/password/reset", json={"token": token, "new_password": "third-pw-1234"})
    assert res.status_code == 400
