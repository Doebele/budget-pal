"""
Budget-Pal Backend — Session-Dauer und Passkeys

Die WebAuthn-Ceremonies selbst lassen sich ohne echten Authenticator nicht
durchspielen. Getestet wird deshalb alles drumherum: Validierung, dass die
gewaehlte Dauer wirklich im Token landet, Challenge-Handling, Besitzpruefung
und dass ungueltige Antworten sauber abgelehnt werden statt durchzurutschen.
"""

import json
from datetime import datetime, timedelta, timezone

import pytest
from jose import jwt

from app.core.config import settings
from app.core.security import SESSION_TIMEOUTS, session_timeout_delta
from app.models.models import WebAuthnChallenge, WebAuthnCredential


# ── Session-Dauer ─────────────────────────────────────────────


class TestSessionTimeoutValue:
    @pytest.mark.parametrize("value", sorted(SESSION_TIMEOUTS))
    def test_known_values_map_to_a_delta(self, value):
        assert isinstance(session_timeout_delta(value), timedelta)

    def test_unknown_value_falls_back_to_none(self):
        # None heisst: Vorgabe aus der Konfiguration greift
        assert session_timeout_delta("99y") is None
        assert session_timeout_delta(None) is None
        assert session_timeout_delta("") is None


class TestSessionTimeoutApi:
    def test_default_is_returned(self, client):
        assert client.get("/api/auth/me").json()["session_timeout"] == "30m"

    def test_value_can_be_changed(self, client):
        assert client.put("/api/auth/me", json={"session_timeout": "7d"}).status_code == 200
        assert client.get("/api/auth/me").json()["session_timeout"] == "7d"

    def test_unknown_value_is_rejected(self, client):
        response = client.put("/api/auth/me", json={"session_timeout": "99y"})
        assert response.status_code == 422

    def test_login_token_carries_the_chosen_duration(self, client, test_user):
        """Der eigentliche Zweck: die Einstellung muss die Token-Laufzeit
        bestimmen, sonst ist sie reine Zierde."""
        client.put("/api/auth/me", json={"session_timeout": "7d"})

        response = client.post(
            "/api/auth/login",
            json={"email": test_user.email, "password": "testpassword123"},
        )
        assert response.status_code == 200

        payload = jwt.decode(
            response.json()["access_token"],
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
        )
        laufzeit = datetime.fromtimestamp(payload["exp"], tz=timezone.utc) - datetime.fromtimestamp(
            payload["iat"], tz=timezone.utc
        )
        # 7 Tage, mit etwas Spielraum fuer die Sekunde zwischen iat und exp
        assert timedelta(days=7) - timedelta(seconds=5) <= laufzeit <= timedelta(days=7)


# ── Passkeys ──────────────────────────────────────────────────


class TestRegistrationOptions:
    async def test_options_contain_a_challenge_and_are_stored(self, client, db_session):
        response = client.post("/api/auth/webauthn/register/options")
        assert response.status_code == 200

        options = json.loads(response.json())
        assert options["challenge"]
        assert options["rp"]["id"] == settings.webauthn_rp_id

        stored = (await db_session.execute(WebAuthnChallenge.__table__.select())).all()
        assert len(stored) == 1

    def test_requires_authentication(self, client):
        client.headers.pop("Authorization", None)
        assert client.post("/api/auth/webauthn/register/options").status_code == 401


class TestLoginOptions:
    def test_open_without_authentication(self, client):
        """Die Anmeldung muss ohne Token funktionieren — sonst waere sie sinnlos."""
        client.headers.pop("Authorization", None)
        response = client.post("/api/auth/webauthn/login/options")
        assert response.status_code == 200
        assert json.loads(response.json())["challenge"]


class TestVerificationRejects:
    def test_register_without_challenge_is_rejected(self, client):
        response = client.post(
            "/api/auth/webauthn/register/verify", json={"credential": {"id": "x"}}
        )
        assert response.status_code == 400

    async def test_garbage_credential_is_rejected(self, client, db_session):
        client.post("/api/auth/webauthn/register/options")
        response = client.post(
            "/api/auth/webauthn/register/verify",
            json={"credential": {"id": "unsinn", "response": {}}},
        )
        assert response.status_code == 400

    async def test_challenge_is_consumed_even_on_failure(self, client, db_session):
        """Einmalgebrauch ist der Kern des Verfahrens — eine liegengebliebene
        Challenge machte eine abgefangene Antwort wiederverwendbar."""
        client.post("/api/auth/webauthn/register/options")
        client.post(
            "/api/auth/webauthn/register/verify",
            json={"credential": {"id": "unsinn", "response": {}}},
        )
        rest = (await db_session.execute(WebAuthnChallenge.__table__.select())).all()
        assert rest == []

    async def test_unknown_credential_on_login_is_401(self, client, db_session):
        client.headers.pop("Authorization", None)
        client.post("/api/auth/webauthn/login/options")
        response = client.post(
            "/api/auth/webauthn/login/verify",
            json={"credential": {"id": "gibtsnicht", "response": {}}},
        )
        assert response.status_code == 401


class TestCredentialManagement:
    async def test_list_is_empty_initially(self, client):
        assert client.get("/api/auth/webauthn/credentials").json() == []

    async def test_own_credential_is_listed_and_deletable(
        self, client, db_session, test_user
    ):
        credential = WebAuthnCredential(
            user_id=test_user.id,
            credential_id="cred-eigen",
            public_key="pk",
            sign_count=0,
            device_name="MacBook Pro",
        )
        db_session.add(credential)
        await db_session.flush()

        listed = client.get("/api/auth/webauthn/credentials").json()
        assert [c["device_name"] for c in listed] == ["MacBook Pro"]

        assert client.delete(f"/api/auth/webauthn/credentials/{credential.id}").status_code == 204
        assert client.get("/api/auth/webauthn/credentials").json() == []

    async def test_foreign_credential_is_neither_listed_nor_deletable(
        self, client, db_session, test_user_2
    ):
        foreign = WebAuthnCredential(
            user_id=test_user_2.id,
            credential_id="cred-fremd",
            public_key="pk",
            sign_count=0,
            device_name="Fremdes Geraet",
        )
        db_session.add(foreign)
        await db_session.flush()

        assert client.get("/api/auth/webauthn/credentials").json() == []
        assert client.delete(f"/api/auth/webauthn/credentials/{foreign.id}").status_code == 404
