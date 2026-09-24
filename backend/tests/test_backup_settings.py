"""
Budget-Pal — Backup der Einstellungen inkl. API-Keys.

Nach dem Vorbild des Einstellungs-Backups in fintools: nach einer
Neuinstallation soll niemand jeden Key neu eingeben muessen. Anders als dort
kommen die Keys nur auf ausdruecklichen Wunsch und nach Passwortbestaetigung
mit — BudgetPal laeuft oeffentlich, und ein Session-Token allein darf nicht
genuegen, um alle Keys im Klartext herunterzuladen.

Fuer das Backup gab es vorher keine einzige Testzeile.
"""

import json

import pytest

from app.api import backup as backup_api

PASSWORD = "testpassword123"  # aus conftest.test_user


@pytest.fixture(autouse=True)
def _reset_limiter():
    """Der Rate-Limiter ist modulweit — ohne Reset beeinflussen sich Tests."""
    backup_api.secrets_export_limiter._events.clear()
    yield
    backup_api.secrets_export_limiter._events.clear()


def _configure(client):
    client.put("/api/settings/ai", json={
        "provider": "anthropic",
        "profiles": {
            "anthropic": {"key": "sk-ant-GEHEIM", "model": "claude-opus-5"},
            "ollama": {"endpoint": "http://192.168.1.50:11434", "model": "qwen3.5:9b"},
        },
        "context_chars_override": 40000,
    })
    client.put("/api/auth/me", json={"ui_language": "en", "session_timeout": "7d"})


def _export(client):
    return client.get("/api/backup/export")


def _export_secrets(client, password=PASSWORD):
    return client.post("/api/backup/export-secrets", json={"password": password})


class TestExport:
    def test_contains_the_settings(self, client):
        _configure(client)
        data = _export(client).json()
        assert data["format"] == "budgetpal-backup"
        assert data["version"] == "1.1"
        settings = data["settings"]
        assert settings["ui_language"] == "en"
        assert settings["session_timeout"] == "7d"
        assert settings["ai"]["provider"] == "anthropic"
        assert settings["ai"]["context_chars_override"] == 40000
        assert settings["ai"]["profiles"]["ollama"]["endpoint"] == "http://192.168.1.50:11434"
        assert settings["ai"]["profiles"]["anthropic"]["model"] == "claude-opus-5"

    def test_plain_export_carries_no_keys(self, client):
        _configure(client)
        response = _export(client)
        assert "sk-ant-GEHEIM" not in response.text
        assert response.json()["contains_secrets"] is False
        assert "key" not in response.json()["settings"]["ai"]["profiles"]["anthropic"]

    def test_secrets_export_carries_the_keys(self, client):
        _configure(client)
        response = _export_secrets(client)
        assert response.status_code == 200
        data = response.json()
        assert data["contains_secrets"] is True
        assert data["settings"]["ai"]["profiles"]["anthropic"]["key"] == "sk-ant-GEHEIM"
        assert "_mit_keys" in response.headers["content-disposition"]
        assert response.headers["cache-control"] == "no-store"

    def test_secrets_export_needs_the_password(self, client):
        """Ein Session-Token allein darf nicht reichen, um alle Keys im
        Klartext zu bekommen."""
        _configure(client)
        response = _export_secrets(client, password="falsch")
        # 403, nicht 401 — ein 401 meldet das Frontend ab
        assert response.status_code == 403
        assert "sk-ant-GEHEIM" not in response.text

    def test_password_guessing_is_throttled(self, client):
        _configure(client)
        codes = [_export_secrets(client, password=f"rate-{i}").status_code for i in range(7)]
        assert 429 in codes

    def test_password_is_not_accepted_in_the_url(self, client):
        """Ein Passwort in der URL landet in Zugriffslogs."""
        response = client.get(f"/api/backup/export-secrets?password={PASSWORD}")
        assert response.status_code == 405


class TestImport:
    def _import(self, client, backup, **flags):
        return client.post("/api/backup/import", json={"backup": backup, **flags})

    def _fresh(self, client):
        """Alles zurueck auf Vorgabe — wie nach einer Neuinstallation."""
        client.put("/api/settings/ai", json={
            "provider": "none",
            "profiles": {"anthropic": {"key": ""}},
            "context_chars_override": 0,
        })
        client.put("/api/auth/me", json={"ui_language": "de", "session_timeout": "30m"})

    def test_settings_are_left_alone_unless_asked(self, client):
        """Sprache, Session-Dauer und KI-Anbieter werden ueberschrieben — das
        darf nicht nebenbei passieren."""
        _configure(client)
        backup = _export_secrets(client).json()
        self._fresh(client)

        result = self._import(client, backup).json()
        assert result["settings_restored"] is False
        assert client.get("/api/settings/ai").json()["provider"] == "none"

    def test_roundtrip_restores_settings_and_keys(self, client):
        """Der eigentliche Zweck: nach einer Neuinstallation muss kein Key neu
        eingegeben werden."""
        _configure(client)
        backup = _export_secrets(client).json()
        self._fresh(client)

        result = self._import(client, backup, import_settings=True).json()
        assert result["settings_restored"] is True
        assert result["api_keys_restored"] == 1

        ai = client.get("/api/settings/ai").json()
        assert ai["provider"] == "anthropic"
        assert ai["profiles"]["anthropic"]["has_key"] is True
        assert ai["profiles"]["anthropic"]["model"] == "claude-opus-5"
        assert ai["profiles"]["ollama"]["endpoint"] == "http://192.168.1.50:11434"
        assert ai["context_chars_override"] == 40000
        me = client.get("/api/auth/me").json()
        assert me["ui_language"] == "en"
        assert me["session_timeout"] == "7d"

    def test_keyless_backup_keeps_the_stored_keys(self, client):
        """Wer ein Backup ohne Keys einspielt, verliert seine gespeicherten nicht."""
        _configure(client)
        backup = _export(client).json()
        result = self._import(client, backup, import_settings=True).json()
        assert result["api_keys_restored"] == 0
        assert client.get("/api/settings/ai").json()["profiles"]["anthropic"]["has_key"] is True

    def test_restored_profiles_are_not_marked_tested(self, client):
        """Getestet war die alte Umgebung, nicht diese."""
        client.put("/api/settings/ai", json={
            "provider": "ollama", "profiles": {"ollama": {"model": "m", "ok": True}},
        })
        backup = _export(client).json()
        self._import(client, backup, import_settings=True)
        assert client.get("/api/settings/ai").json()["profiles"]["ollama"]["ok"] is False

    def test_crafted_endpoint_does_not_take_the_stored_key_along(self, client):
        """Eine praeparierte Datei mit fremdem Endpunkt und ohne Key darf den
        gespeicherten Key nicht dorthin umlenken — derselbe Angriff wie beim
        Verbindungstest, nur ueber den Import."""
        _configure(client)
        crafted = {
            "format": "budgetpal-backup", "version": "1.1",
            "settings": {"ai": {
                "provider": "anthropic",
                "profiles": {"anthropic": {"endpoint": "https://angreifer.example/v1"}},
            }},
        }
        result = self._import(client, crafted, import_settings=True).json()
        profile = client.get("/api/settings/ai").json()["profiles"]["anthropic"]
        assert profile["endpoint"] == "https://angreifer.example/v1"
        assert profile["has_key"] is False
        assert any("Key verworfen" in w for w in result["warnings"])

    def test_invalid_values_are_skipped_not_stored(self, client):
        self._fresh(client)
        crafted = {
            "format": "budgetpal-backup", "version": "1.1",
            "settings": {
                "ui_language": "xx",
                "session_timeout": "forever",
                "saron_reference_annual_pct": 9999,
                "ai": {
                    "provider": "skynet",
                    "profiles": {
                        "skynet": {"model": "x"},
                        "lm-studio": {"endpoint": "file:///etc/passwd"},
                    },
                },
            },
        }
        result = self._import(client, crafted, import_settings=True).json()
        me = client.get("/api/auth/me").json()
        assert me["ui_language"] == "de"
        assert me["session_timeout"] == "30m"
        ai = client.get("/api/settings/ai").json()
        assert ai["provider"] == "none"
        assert "skynet" not in ai["profiles"]
        assert ai["profiles"].get("lm-studio", {}).get("endpoint", "") != "file:///etc/passwd"
        assert len(result["warnings"]) >= 3

    def test_old_version_backup_still_imports(self, client):
        """Backups von vor den Einstellungen (1.0) muessen weiter einspielbar
        sein — ohne irrefuehrende Versionswarnung."""
        result = self._import(client, {"version": "1.0", "accounts": []}, import_settings=True).json()
        assert not any("differs" in w for w in result["warnings"])
        assert any("keine Einstellungen" in w for w in result["warnings"])
