"""
Budget-Pal Backend — /api/settings/ai Tests

Der wichtigste Punkt hier ist das Key-Handling: API-Keys dürfen die API nie
wieder verlassen, und ein weggelassener Key darf den gespeicherten nicht
überschreiben (sonst löscht jedes Speichern aus der UI die Zugangsdaten).
"""


class TestGetAiSettings:
    def test_defaults_to_no_provider(self, client):
        response = client.get("/api/settings/ai")
        assert response.status_code == 200
        data = response.json()
        assert data["provider"] == "none"
        assert data["has_openai_key"] is False

    def test_never_returns_api_keys(self, client):
        client.put("/api/settings/ai", json={"provider": "openai", "openai_api_key": "sk-geheim"})
        body = client.get("/api/settings/ai").text
        assert "sk-geheim" not in body
        assert client.get("/api/settings/ai").json()["has_openai_key"] is True


class TestPutAiSettings:
    def test_saves_provider_and_model(self, client):
        response = client.put(
            "/api/settings/ai", json={"provider": "anthropic", "anthropic_model": "claude-sonnet-5"}
        )
        assert response.status_code == 200
        assert response.json()["provider"] == "anthropic"
        assert client.get("/api/settings/ai").json()["anthropic_model"] == "claude-sonnet-5"

    def test_rejects_unknown_provider(self, client):
        assert client.put("/api/settings/ai", json={"provider": "skynet"}).status_code == 400

    def test_omitted_key_keeps_stored_one(self, client):
        client.put("/api/settings/ai", json={"provider": "openai", "openai_api_key": "sk-abc"})
        # Modellwechsel ohne Key im Payload — der Key muss erhalten bleiben
        client.put("/api/settings/ai", json={"openai_model": "gpt-4o"})
        data = client.get("/api/settings/ai").json()
        assert data["has_openai_key"] is True
        assert data["openai_model"] == "gpt-4o"

    def test_empty_string_clears_key(self, client):
        client.put("/api/settings/ai", json={"provider": "openai", "openai_api_key": "sk-abc"})
        client.put("/api/settings/ai", json={"openai_api_key": ""})
        assert client.get("/api/settings/ai").json()["has_openai_key"] is False


class TestAiModels:
    def test_cloud_provider_returns_static_list(self, client):
        client.put("/api/settings/ai", json={"provider": "anthropic"})
        models = client.get("/api/settings/ai/models").json()
        assert "claude-opus-5" in models

    def test_provider_query_overrides_saved_config(self, client):
        # Gespeichert ist "none" — die UI muss trotzdem eine Liste abfragen können
        models = client.get("/api/settings/ai/models?provider=openai").json()
        assert "gpt-4o-mini" in models

    def test_unreachable_local_server_returns_empty(self, client):
        response = client.get(
            "/api/settings/ai/models?provider=ollama&url=http://127.0.0.1:9"
        )
        assert response.status_code == 200
        assert response.json() == []
