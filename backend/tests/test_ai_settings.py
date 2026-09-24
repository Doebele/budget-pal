"""
Budget-Pal Backend — /api/settings/ai Tests

Der wichtigste Punkt hier ist das Key-Handling: API-Keys dürfen die API nie
wieder verlassen, und ein weggelassener Key darf den gespeicherten nicht
überschreiben (sonst löscht jedes Speichern aus der UI die Zugangsdaten).

Seit dem Umbau auf Profile nach dem Vorbild von fintools kommt hinzu: beim
Anbieterwechsel bleibt jedes Profil erhalten, und alte, flach gespeicherte
Konfigurationen verlieren ihren Key nicht.
"""

from unittest.mock import AsyncMock, patch

from sqlalchemy import select

from app.models.models import User
from app.services import ai_client


def _put(client, **payload):
    return client.put("/api/settings/ai", json=payload)


class TestGetAiSettings:
    def test_defaults_to_no_provider(self, client):
        response = client.get("/api/settings/ai")
        assert response.status_code == 200
        data = response.json()
        assert data["provider"] == "none"
        assert data["profiles"] == {}

    def test_never_returns_api_keys(self, client):
        _put(client, provider="openai", profiles={"openai": {"key": "sk-geheim"}})
        body = client.get("/api/settings/ai").text
        assert "sk-geheim" not in body
        assert client.get("/api/settings/ai").json()["profiles"]["openai"]["has_key"] is True

    async def test_old_flat_config_keeps_its_key(self, client, db_session, test_user):
        """Konfigurationen von vor dem Umbau liegen flach in der DB. Nach dem
        Update muss der Key noch da sein — sonst schweigt die KI ohne Hinweis."""
        user = (await db_session.execute(select(User).where(User.id == test_user.id))).scalar_one()
        user.ai_config_json = {
            "provider": "anthropic",
            "anthropic_api_key": "sk-ant-alt",
            "anthropic_model": "claude-sonnet-5",
        }
        await db_session.commit()

        data = client.get("/api/settings/ai").json()
        assert data["provider"] == "anthropic"
        assert data["profiles"]["anthropic"]["has_key"] is True
        assert data["profiles"]["anthropic"]["model"] == "claude-sonnet-5"
        assert "sk-ant-alt" not in client.get("/api/settings/ai").text


class TestPutAiSettings:
    def test_saves_provider_and_model(self, client):
        response = _put(client, provider="anthropic",
                        profiles={"anthropic": {"model": "claude-sonnet-5"}})
        assert response.status_code == 200
        assert response.json()["provider"] == "anthropic"
        assert client.get("/api/settings/ai").json()["profiles"]["anthropic"]["model"] == "claude-sonnet-5"

    def test_rejects_unknown_provider(self, client):
        assert _put(client, provider="skynet").status_code == 400
        assert _put(client, profiles={"skynet": {"model": "x"}}).status_code == 400

    def test_accepts_every_catalog_provider(self, client):
        for pid in ai_client.CATALOG:
            assert _put(client, provider=pid).status_code == 200, pid

    def test_rejects_non_http_endpoint(self, client):
        """Der Server ruft diese Adresse selbst auf — nur http(s)."""
        for bad in ("file:///etc/passwd", "gopher://x", "ftp://host"):
            response = _put(client, profiles={"lm-studio": {"endpoint": bad}})
            assert response.status_code == 400, bad

    def test_omitted_key_keeps_stored_one(self, client):
        _put(client, provider="openai", profiles={"openai": {"key": "sk-abc"}})
        # Modellwechsel ohne Key im Payload — der Key muss erhalten bleiben
        _put(client, profiles={"openai": {"model": "gpt-5"}})
        profile = client.get("/api/settings/ai").json()["profiles"]["openai"]
        assert profile["has_key"] is True
        assert profile["model"] == "gpt-5"

    def test_empty_string_clears_key(self, client):
        _put(client, provider="openai", profiles={"openai": {"key": "sk-abc"}})
        _put(client, profiles={"openai": {"key": ""}})
        assert client.get("/api/settings/ai").json()["profiles"]["openai"]["has_key"] is False

    def test_switching_provider_keeps_every_profile(self, client):
        """Wie in fintools: jeder Anbieter behaelt Endpunkt, Modell und Key.
        Ein Key wird nie auf einen anderen Anbieter uebertragen."""
        _put(client, provider="openai", profiles={"openai": {"key": "sk-o", "model": "gpt-5"}})
        _put(client, provider="mistral", profiles={"mistral": {"key": "m-k", "model": "mistral-large"}})
        _put(client, provider="openai")

        data = client.get("/api/settings/ai").json()
        assert data["provider"] == "openai"
        assert data["profiles"]["openai"]["model"] == "gpt-5"
        assert data["profiles"]["mistral"]["model"] == "mistral-large"
        assert data["profiles"]["mistral"]["has_key"] is True

    def test_changing_values_drops_the_tested_mark(self, client):
        """Der Haken gilt fuer genau die getesteten Werte."""
        _put(client, provider="openai",
             profiles={"openai": {"key": "sk-a", "model": "gpt-5", "ok": True}})
        assert client.get("/api/settings/ai").json()["profiles"]["openai"]["ok"] is True

        _put(client, profiles={"openai": {"key": "sk-b"}})
        assert client.get("/api/settings/ai").json()["profiles"]["openai"]["ok"] is False

    def test_same_values_keep_the_tested_mark(self, client):
        _put(client, provider="openai",
             profiles={"openai": {"model": "gpt-5", "ok": True}})
        _put(client, profiles={"openai": {"model": "gpt-5"}})
        assert client.get("/api/settings/ai").json()["profiles"]["openai"]["ok"] is True


class TestProviders:
    def test_lists_the_catalog(self, client):
        providers = client.get("/api/settings/ai/providers").json()
        assert [p["id"] for p in providers] == [p.id for p in ai_client.PROVIDER_CATALOG]
        local = {p["id"] for p in providers if p["local"]}
        assert local == {"lm-studio", "ollama"}

    def test_cloud_entries_carry_a_key_link(self, client):
        for p in client.get("/api/settings/ai/providers").json():
            assert bool(p["key_url"]) != p["local"], p["id"]


class TestAiModels:
    def test_uses_the_stored_key(self, client):
        """Der Browser kennt den gespeicherten Key nicht — die Modellliste muss
        ihn serverseitig ergaenzen."""
        _put(client, profiles={"openai": {"key": "sk-gespeichert"}})
        seen = {}

        async def fake_fetch(cfg):
            seen["key"] = cfg.profile().key
            seen["provider"] = cfg.provider
            return ["gpt-5"]

        with patch.object(ai_client, "fetch_models", fake_fetch):
            models = client.get("/api/settings/ai/models?provider=openai").json()

        assert models == ["gpt-5"]
        assert seen == {"key": "sk-gespeichert", "provider": "openai"}

    def test_unreachable_local_server_returns_empty(self, client):
        response = client.get(
            "/api/settings/ai/models?provider=ollama&endpoint=http://127.0.0.1:9"
        )
        assert response.status_code == 200
        assert response.json() == []


class TestConnectionTest:
    def test_falls_back_to_the_stored_key(self, client):
        _put(client, profiles={"anthropic": {"key": "sk-ant-gespeichert"}})
        seen = {}

        async def fake_check(cfg):
            seen["key"] = cfg.profile().key
            seen["model"] = cfg.profile().model
            return ai_client.ConnectionResult(ok=True, models=["m"], model="m", reply="OK")

        with patch.object(ai_client, "check_connection", fake_check):
            body = client.post("/api/settings/ai/test", json={
                "provider": "anthropic", "model": "claude-opus-5",
            }).json()

        assert body["ok"] is True
        assert seen == {"key": "sk-ant-gespeichert", "model": "claude-opus-5"}

    def test_typed_key_wins_over_stored_one(self, client):
        _put(client, profiles={"openai": {"key": "sk-alt"}})
        seen = {}

        async def fake_check(cfg):
            seen["key"] = cfg.profile().key
            return ai_client.ConnectionResult(ok=True)

        with patch.object(ai_client, "check_connection", fake_check):
            client.post("/api/settings/ai/test", json={"provider": "openai", "key": "sk-neu"})
        assert seen["key"] == "sk-neu"

    def test_test_does_not_save_anything(self, client):
        _put(client, provider="openai", profiles={"openai": {"model": "gpt-5"}})
        with patch.object(ai_client, "check_connection",
                          AsyncMock(return_value=ai_client.ConnectionResult(ok=True))):
            client.post("/api/settings/ai/test", json={
                "provider": "mistral", "model": "anders", "key": "k",
            })
        data = client.get("/api/settings/ai").json()
        assert data["provider"] == "openai"
        assert "mistral" not in data["profiles"]

    def test_failed_test_is_a_200_with_ok_false(self, client):
        with patch.object(ai_client, "check_connection", AsyncMock(
            return_value=ai_client.ConnectionResult(ok=False, error="HTTP 401: bad key")
        )):
            response = client.post("/api/settings/ai/test", json={"provider": "openai"})
        assert response.status_code == 200
        assert response.json() == {
            "ok": False, "models": None, "model": "", "reply": "",
            "latency_ms": 0, "error": "HTTP 401: bad key",
        }

    def test_rejects_none_and_unknown(self, client):
        assert client.post("/api/settings/ai/test", json={"provider": "none"}).status_code == 400
        assert client.post("/api/settings/ai/test", json={"provider": "skynet"}).status_code == 400

    def test_rejects_non_http_endpoint(self, client):
        response = client.post("/api/settings/ai/test", json={
            "provider": "lm-studio", "endpoint": "file:///etc/passwd",
        })
        assert response.status_code == 400


class TestKeyStaysWithItsEndpoint:
    """Ein gespeicherter Key geht nur an den Endpunkt, mit dem er gespeichert
    wurde. Sonst genuegt ein gestohlenes Session-Token: Test mit fremdem
    Endpunkt ohne Key — und der Server schickt den gespeicherten Key dorthin."""

    def test_test_with_foreign_endpoint_does_not_send_the_stored_key(self, client):
        _put(client, profiles={"openai": {"key": "sk-gespeichert"}})
        seen = {}

        async def fake_check(cfg):
            seen["key"] = cfg.profile().key
            seen["endpoint"] = cfg.profile().endpoint
            return ai_client.ConnectionResult(ok=False, error="x")

        with patch.object(ai_client, "check_connection", fake_check):
            client.post("/api/settings/ai/test", json={
                "provider": "openai", "endpoint": "https://angreifer.example/v1",
            })

        assert seen["endpoint"] == "https://angreifer.example/v1"
        assert seen["key"] == ""

    def test_model_list_with_foreign_endpoint_does_not_send_it_either(self, client):
        _put(client, profiles={"openai": {"key": "sk-gespeichert"}})
        seen = {}

        async def fake_fetch(cfg):
            seen["key"] = cfg.profile().key
            return []

        with patch.object(ai_client, "fetch_models", fake_fetch):
            client.get("/api/settings/ai/models?provider=openai&endpoint=https://angreifer.example/v1")
        assert seen["key"] == ""

    def test_same_endpoint_still_uses_the_stored_key(self, client):
        """Die Bindung darf den normalen Fall nicht stoeren — auch nicht, wenn
        der Endpunkt nur mit Schraegstrich am Ende mitkommt."""
        _put(client, profiles={"openai": {"key": "sk-gespeichert"}})
        seen = {}

        async def fake_check(cfg):
            seen["key"] = cfg.profile().key
            return ai_client.ConnectionResult(ok=True)

        with patch.object(ai_client, "check_connection", fake_check):
            client.post("/api/settings/ai/test", json={
                "provider": "openai", "endpoint": "https://api.openai.com/v1/",
            })
        assert seen["key"] == "sk-gespeichert"

    def test_saving_a_new_endpoint_without_new_key_is_refused(self, client):
        _put(client, profiles={"openai": {"key": "sk-gespeichert"}})
        response = _put(client, profiles={"openai": {"endpoint": "https://angreifer.example/v1"}})
        assert response.status_code == 400
        # Nichts gespeichert
        profile = client.get("/api/settings/ai").json()["profiles"]["openai"]
        assert profile["endpoint"] == ""
        assert profile["has_key"] is True

    def test_new_endpoint_with_new_key_is_fine(self, client):
        _put(client, profiles={"openai": {"key": "sk-alt"}})
        response = _put(client, profiles={"openai": {
            "endpoint": "https://proxy.example/v1", "key": "sk-neu",
        }})
        assert response.status_code == 200
        assert response.json()["profiles"]["openai"]["endpoint"] == "https://proxy.example/v1"

    def test_local_providers_have_no_key_to_protect(self, client):
        _put(client, profiles={"lm-studio": {"model": "x"}})
        assert _put(client, profiles={"lm-studio": {"endpoint": "http://192.168.1.50:1234"}}).status_code == 200
