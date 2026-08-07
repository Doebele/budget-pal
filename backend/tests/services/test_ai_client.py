"""
Budget-Pal Backend — AI-Client Tests

Deckt ab:
- localhost → host.docker.internal (sonst sind lokale Modelle aus dem Container
  unerreichbar — der Fehler wäre still)
- Provider-Dispatch auf den richtigen Endpunkt und Body
- Anthropic sendet kein `temperature` (auf aktuellen Claude-Modellen ein 400)
- Fehler und fehlende Zugangsdaten geben None statt zu werfen

Es gehen keine echten Netzwerk-Requests raus: httpx.AsyncClient ist gemockt.
"""

from unittest.mock import patch

import pytest

from app.services import ai_client
from app.services.ai_client import AiConfig


# ── Host-Auflösung ────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("http://localhost:1234", "http://host.docker.internal:1234"),
        ("http://127.0.0.1:11434", "http://host.docker.internal:11434"),
        ("http://LOCALHOST:1234", "http://host.docker.internal:1234"),
        ("http://localhost:1234/", "http://host.docker.internal:1234"),
        # Fremde Hosts bleiben unangetastet
        ("http://192.168.1.50:1234", "http://192.168.1.50:1234"),
        ("https://api.example.com", "https://api.example.com"),
    ],
)
def test_resolve_host_url(raw, expected):
    assert ai_client.resolve_host_url(raw) == expected


# ── Config aus dem User-Modell ────────────────────────────────


class _FakeUser:
    def __init__(self, cfg):
        self.id = 1
        self.ai_config_json = cfg


def test_from_user_defaults_to_none_provider():
    assert ai_client.from_user(_FakeUser(None)).provider == "none"
    assert ai_client.from_user(_FakeUser("kaputt")).provider == "none"
    # Defekte Altdaten dürfen keinen Request killen
    assert ai_client.from_user(_FakeUser({"provider": 42})).provider == "none"


def test_from_user_reads_saved_config():
    cfg = ai_client.from_user(_FakeUser({"provider": "openai", "openai_model": "gpt-4o"}))
    assert cfg.provider == "openai"
    assert cfg.openai_model == "gpt-4o"
    assert cfg.enabled is True


def test_enabled_is_false_for_none_provider():
    assert AiConfig().enabled is False


# ── Dispatch ──────────────────────────────────────────────────


class _FakeResponse:
    status_code = 200
    text = ""

    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _FakeAsyncClient:
    """Fängt den letzten POST ab, damit Tests URL und Body prüfen können."""

    last_call: dict = {}

    def __init__(self, payload):
        self._payload = payload

    def __call__(self, *args, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, json=None, headers=None):
        type(self).last_call = {"url": url, "json": json, "headers": headers}
        return _FakeResponse(self._payload)

    async def get(self, url):
        type(self).last_call = {"url": url}
        return _FakeResponse(self._payload)


@pytest.mark.asyncio
async def test_complete_returns_none_without_provider():
    assert await ai_client.complete(AiConfig(), "sys", "user") is None
    assert await ai_client.complete(None, "sys", "user") is None


@pytest.mark.asyncio
async def test_complete_returns_none_without_api_key():
    # Provider gewählt, aber kein Key hinterlegt
    cfg = AiConfig(provider="openai", openai_api_key="")
    assert await ai_client.complete(cfg, "sys", "user") is None


@pytest.mark.asyncio
async def test_openai_compatible_dispatch():
    fake = _FakeAsyncClient({"choices": [{"message": {"content": "hallo"}}]})
    cfg = AiConfig(provider="openai", openai_api_key="sk-test", openai_model="gpt-4o-mini")

    with patch("app.services.ai_client.httpx.AsyncClient", fake):
        out = await ai_client.complete(cfg, "sys", "user", json_mode=True)

    assert out == "hallo"
    call = _FakeAsyncClient.last_call
    assert call["url"] == "https://api.openai.com/v1/chat/completions"
    assert call["json"]["model"] == "gpt-4o-mini"
    assert call["json"]["response_format"] == {"type": "json_object"}
    assert call["headers"]["Authorization"] == "Bearer sk-test"


@pytest.mark.asyncio
async def test_lm_studio_uses_docker_host_and_no_auth_header():
    fake = _FakeAsyncClient({"choices": [{"message": {"content": "ok"}}]})
    cfg = AiConfig(provider="lm-studio", lm_studio_model="ornith-35b")

    with patch("app.services.ai_client.httpx.AsyncClient", fake):
        assert await ai_client.complete(cfg, "sys", "user") == "ok"

    call = _FakeAsyncClient.last_call
    assert call["url"].startswith("http://host.docker.internal:1234")
    assert "Authorization" not in call["headers"]


@pytest.mark.asyncio
async def test_lm_studio_does_not_receive_json_object_response_format():
    """LM Studio (Bionic) lehnt response_format 'json_object' mit 400 ab und
    verlangt 'json_schema' oder 'text' — dort wird der Parameter weggelassen."""
    fake = _FakeAsyncClient({"choices": [{"message": {"content": "{}"}}]})
    cfg = AiConfig(provider="lm-studio", lm_studio_model="ornith-35b")

    with patch("app.services.ai_client.httpx.AsyncClient", fake):
        await ai_client.complete(cfg, "sys", "user", json_mode=True)

    assert "response_format" not in _FakeAsyncClient.last_call["json"]


@pytest.mark.asyncio
async def test_openai_still_receives_json_object_response_format():
    fake = _FakeAsyncClient({"choices": [{"message": {"content": "{}"}}]})
    cfg = AiConfig(provider="openai", openai_api_key="sk-test")

    with patch("app.services.ai_client.httpx.AsyncClient", fake):
        await ai_client.complete(cfg, "sys", "user", json_mode=True)

    assert _FakeAsyncClient.last_call["json"]["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_reasoning_content_used_when_content_is_empty():
    """Reasoning-Modelle legen ihre Ausgabe in reasoning_content ab und lassen
    content leer, wenn das Token-Budget beim Denken aufgeht."""
    fake = _FakeAsyncClient(
        {"choices": [{"message": {"content": "", "reasoning_content": "gedacht"}}]}
    )
    cfg = AiConfig(provider="lm-studio", lm_studio_model="ornith-35b")

    with patch("app.services.ai_client.httpx.AsyncClient", fake):
        assert await ai_client.complete(cfg, "sys", "user") == "gedacht"


@pytest.mark.asyncio
async def test_empty_content_without_reasoning_returns_none():
    fake = _FakeAsyncClient({"choices": [{"message": {"content": ""}}]})
    cfg = AiConfig(provider="openai", openai_api_key="sk-test")

    with patch("app.services.ai_client.httpx.AsyncClient", fake):
        assert await ai_client.complete(cfg, "sys", "user") is None


@pytest.mark.asyncio
async def test_anthropic_dispatch_omits_temperature():
    """temperature/top_p sind auf aktuellen Claude-Modellen entfernt und
    liefern 400 — der Anthropic-Zweig darf sie nicht senden."""
    fake = _FakeAsyncClient({"content": [{"type": "text", "text": "hallo"}]})
    cfg = AiConfig(provider="anthropic", anthropic_api_key="sk-ant-test")

    with patch("app.services.ai_client.httpx.AsyncClient", fake):
        assert await ai_client.complete(cfg, "sys", "user") == "hallo"

    call = _FakeAsyncClient.last_call
    assert call["url"] == "https://api.anthropic.com/v1/messages"
    assert "temperature" not in call["json"]
    assert "top_p" not in call["json"]
    assert call["json"]["system"] == "sys"
    assert call["headers"]["anthropic-version"] == "2023-06-01"
    assert call["headers"]["x-api-key"] == "sk-ant-test"


@pytest.mark.asyncio
async def test_anthropic_refusal_returns_none():
    # Ablehnung ist HTTP 200 mit stop_reason "refusal", kein Fehler
    fake = _FakeAsyncClient({"stop_reason": "refusal", "content": []})
    cfg = AiConfig(provider="anthropic", anthropic_api_key="sk-ant-test")

    with patch("app.services.ai_client.httpx.AsyncClient", fake):
        assert await ai_client.complete(cfg, "sys", "user") is None


@pytest.mark.asyncio
async def test_gemini_sends_key_as_header_not_query():
    fake = _FakeAsyncClient(
        {"candidates": [{"content": {"parts": [{"text": "hallo"}]}}]}
    )
    cfg = AiConfig(provider="gemini", gemini_api_key="AIza-test")

    with patch("app.services.ai_client.httpx.AsyncClient", fake):
        assert await ai_client.complete(cfg, "sys", "user") == "hallo"

    call = _FakeAsyncClient.last_call
    assert "AIza-test" not in call["url"]  # Key gehört nicht in die URL
    assert call["headers"]["x-goog-api-key"] == "AIza-test"


# ── Modell und Tokenverbrauch ─────────────────────────────────
#
# Die Vorschau zeigt beides an. Jeder Provider benennt die Felder anders.


@pytest.mark.asyncio
async def test_openai_compatible_reports_model_and_tokens():
    fake = _FakeAsyncClient(
        {
            "model": "ornith-35b",
            "choices": [{"message": {"content": "ok"}}],
            "usage": {"prompt_tokens": 3720, "completion_tokens": 6536},
        }
    )
    cfg = AiConfig(provider="lm-studio", lm_studio_model="angefragtes-modell")

    with patch("app.services.ai_client.httpx.AsyncClient", fake):
        result = await ai_client.complete_detailed(cfg, "sys", "user")

    assert result.text == "ok"
    # Der Server meldet das tatsaechlich geladene Modell — das gilt
    assert result.model == "ornith-35b"
    assert result.prompt_tokens == 3720
    assert result.completion_tokens == 6536
    assert result.total_tokens == 10256


@pytest.mark.asyncio
async def test_anthropic_maps_input_output_tokens():
    fake = _FakeAsyncClient(
        {
            "model": "claude-opus-5",
            "content": [{"type": "text", "text": "hallo"}],
            "usage": {"input_tokens": 100, "output_tokens": 42},
        }
    )
    cfg = AiConfig(provider="anthropic", anthropic_api_key="sk-ant-test")

    with patch("app.services.ai_client.httpx.AsyncClient", fake):
        result = await ai_client.complete_detailed(cfg, "sys", "user")

    assert result.model == "claude-opus-5"
    assert (result.prompt_tokens, result.completion_tokens) == (100, 42)


@pytest.mark.asyncio
async def test_gemini_maps_usage_metadata():
    fake = _FakeAsyncClient(
        {
            "candidates": [{"content": {"parts": [{"text": "hallo"}]}}],
            "usageMetadata": {"promptTokenCount": 80, "candidatesTokenCount": 20},
        }
    )
    cfg = AiConfig(provider="gemini", gemini_api_key="AIza-test")

    with patch("app.services.ai_client.httpx.AsyncClient", fake):
        result = await ai_client.complete_detailed(cfg, "sys", "user")

    assert result.model == "gemini-2.0-flash"
    assert (result.prompt_tokens, result.completion_tokens) == (80, 20)


@pytest.mark.asyncio
async def test_missing_usage_block_yields_zero_not_crash():
    fake = _FakeAsyncClient({"choices": [{"message": {"content": "ok"}}]})
    cfg = AiConfig(provider="openai", openai_api_key="sk-test")

    with patch("app.services.ai_client.httpx.AsyncClient", fake):
        result = await ai_client.complete_detailed(cfg, "sys", "user")

    assert result.text == "ok"
    assert result.total_tokens == 0


@pytest.mark.asyncio
async def test_failed_call_reports_empty_completion():
    class _Boom(_FakeAsyncClient):
        async def post(self, url, json=None, headers=None):
            raise RuntimeError("weg")

    cfg = AiConfig(provider="openai", openai_api_key="sk-test")
    with patch("app.services.ai_client.httpx.AsyncClient", _Boom({})):
        result = await ai_client.complete_detailed(cfg, "sys", "user")

    assert result.text is None
    assert result.total_tokens == 0


@pytest.mark.asyncio
async def test_complete_swallows_transport_errors():
    class _Boom(_FakeAsyncClient):
        async def post(self, url, json=None, headers=None):
            raise RuntimeError("Verbindung abgelehnt")

    cfg = AiConfig(provider="openai", openai_api_key="sk-test")
    with patch("app.services.ai_client.httpx.AsyncClient", _Boom({})):
        assert await ai_client.complete(cfg, "sys", "user") is None


# ── Modellliste ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_models_local_provider_queries_server():
    fake = _FakeAsyncClient({"data": [{"id": "ornith-35b"}, {"id": "gemma3:12b"}]})
    with patch("app.services.ai_client.httpx.AsyncClient", fake):
        models = await ai_client.list_models(AiConfig(provider="ollama"))

    assert models == ["ornith-35b", "gemma3:12b"]
    assert _FakeAsyncClient.last_call["url"].startswith("http://host.docker.internal:11434")


@pytest.mark.asyncio
async def test_list_models_unreachable_server_returns_empty():
    class _Boom(_FakeAsyncClient):
        async def get(self, url):
            raise RuntimeError("nicht erreichbar")

    with patch("app.services.ai_client.httpx.AsyncClient", _Boom({})):
        assert await ai_client.list_models(AiConfig(provider="lm-studio")) == []


@pytest.mark.asyncio
async def test_list_models_cloud_provider_is_static():
    models = await ai_client.list_models(AiConfig(provider="anthropic"))
    assert "claude-opus-5" in models
    # Modell-IDs tragen kein Datums-Suffix
    assert all("-2025" not in m and "-2026" not in m for m in models)
