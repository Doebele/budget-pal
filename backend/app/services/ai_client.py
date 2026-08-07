"""
Budget-Pal — provider-agnostischer KI-Client.

Eine Stelle, die weiß, wie man mit einem LLM spricht, damit alle KI-Features
(Import-Auswertung, Kategorisierung, Ausgabemuster, Sparvorschläge) dasselbe
vom Nutzer gewählte Modell verwenden.

Die Konfiguration liegt pro User in `users.ai_config_json` und wird von der API
als AiConfig durchgereicht — der Service hält bewusst keinen Zustand, weil die
Router ein Modul-Singleton der CategorizationService teilen.

Vier der sieben Provider (openai, openrouter, lm-studio, ollama) sprechen
dieselbe OpenAI-kompatible API und teilen sich einen Codepfad; nur Anthropic
und Gemini haben ein eigenes Format.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, NamedTuple, Optional

import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

PROVIDERS = (
    "none",
    "lm-studio",
    "ollama",
    "anthropic",
    "openai",
    "gemini",
    "openrouter",
)

# Provider mit einem lokalen Server, dessen Modellliste live abgefragt wird
LOCAL_PROVIDERS = ("lm-studio", "ollama")

DEFAULT_LM_STUDIO_URL = "http://localhost:1234"
DEFAULT_OLLAMA_URL = "http://localhost:11434"

# Kuratierte Modelllisten für Cloud-Provider (die APIs liefern hunderte
# irrelevanter Einträge). OpenRouter bleibt ein Freitextfeld.
CLOUD_MODELS: Dict[str, List[str]] = {
    # Ohne Datums-Suffix — die exakten IDs laut Anthropic-Doku
    "anthropic": [
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-haiku-4-5",
        "claude-opus-4-8",
    ],
    "openai": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    "gemini": [
        "gemini-2.0-flash",
        "gemini-2.0-flash-lite",
        "gemini-1.5-pro",
        "gemini-1.5-flash",
    ],
}

_LOCALHOST_RE = re.compile(r"^(https?://)(localhost|127\.0\.0\.1)(:\d+)?", re.I)

# Lokale Modelle sind langsam: ein 35B-Reasoning-Modell braucht fuer einen
# 8000-Zeichen-Abschnitt gemessene ~170s. Der Wert ist eine Obergrenze fuer den
# Notfall, keine Wartezeit — Cloud-APIs antworten in Sekunden.
COMPLETION_TIMEOUT = 600.0
LISTING_TIMEOUT = 5.0


class Completion(NamedTuple):
    """Antwort plus Verbrauch — die UI zeigt Modell und Tokens an, damit
    sichtbar ist, was ein Import tatsaechlich gekostet hat."""

    text: Optional[str] = None
    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


class AiConfig(BaseModel):
    """Per-User-Auswahl von Provider und Modell. API-Keys werden nie roh
    zurückgegeben — die API maskiert sie zu has_*-Flags."""

    provider: str = "none"

    lm_studio_url: str = DEFAULT_LM_STUDIO_URL
    lm_studio_model: str = ""

    ollama_url: str = DEFAULT_OLLAMA_URL
    ollama_model: str = ""

    anthropic_api_key: str = ""
    anthropic_model: str = "claude-opus-5"

    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"

    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.0-flash"

    openrouter_api_key: str = ""
    openrouter_model: str = Field(default="anthropic/claude-haiku-4-5")

    @property
    def enabled(self) -> bool:
        return self.provider in PROVIDERS and self.provider != "none"


def resolve_host_url(url: str) -> str:
    """localhost → host.docker.internal.

    Das Backend läuft im Container; ein lokal laufendes LM Studio oder Ollama
    ist von dort unter `localhost` NICHT erreichbar. Ohne diese Umschreibung
    scheitern die lokalen Provider still.
    """
    return _LOCALHOST_RE.sub(r"\1host.docker.internal\3", (url or "").rstrip("/"))


def from_user(user: Any) -> AiConfig:
    """AiConfig aus dem User-Modell lesen; NULL/Schrott ⇒ Provider 'none'."""
    raw = getattr(user, "ai_config_json", None)
    if not isinstance(raw, dict):
        return AiConfig()
    try:
        return AiConfig(**raw)
    except Exception:  # defekte Altdaten dürfen keine Requests killen
        logger.warning("Ungültige ai_config_json für user_id=%s", getattr(user, "id", "?"))
        return AiConfig()


# ── Provider-Dispatch ─────────────────────────────────────────


class _Target(NamedTuple):
    base_url: str
    api_key: str
    model: str
    extra_headers: dict
    # LM Studio lehnt response_format "json_object" ab und verlangt
    # "json_schema" oder "text" — dort wird der Parameter weggelassen und die
    # JSON-Form allein über den Prompt erzwungen. Die Aufrufer schneiden das
    # Objekt ohnehin tolerant aus der Antwort.
    supports_json_object: bool = True


def _openai_compatible_target(cfg: AiConfig) -> Optional[_Target]:
    """Endpunkt-Parameter für die OpenAI-kompatiblen Provider."""
    if cfg.provider == "openai":
        if not cfg.openai_api_key:
            return None
        return _Target("https://api.openai.com", cfg.openai_api_key, cfg.openai_model, {})
    if cfg.provider == "openrouter":
        if not cfg.openrouter_api_key:
            return None
        return _Target(
            "https://openrouter.ai/api",
            cfg.openrouter_api_key,
            cfg.openrouter_model,
            {"HTTP-Referer": "https://budgetpal.doebele12.de", "X-Title": "Budget-Pal"},
        )
    if cfg.provider == "lm-studio":
        base = resolve_host_url(cfg.lm_studio_url or DEFAULT_LM_STUDIO_URL)
        return _Target(base, "", cfg.lm_studio_model, {}, supports_json_object=False)
    if cfg.provider == "ollama":
        base = resolve_host_url(cfg.ollama_url or DEFAULT_OLLAMA_URL)
        return _Target(base, "", cfg.ollama_model, {})
    return None


async def _complete_openai_compatible(
    cfg: AiConfig, system: str, user: str, max_tokens: int, json_mode: bool
) -> Completion:
    target = _openai_compatible_target(cfg)
    if target is None:
        return Completion()

    body: Dict[str, Any] = {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": 0,
    }
    if target.model:
        body["model"] = target.model
    if json_mode and target.supports_json_object:
        body["response_format"] = {"type": "json_object"}

    headers = {"Content-Type": "application/json", **target.extra_headers}
    if target.api_key:
        headers["Authorization"] = f"Bearer {target.api_key}"

    async with httpx.AsyncClient(timeout=COMPLETION_TIMEOUT) as client:
        res = await client.post(
            f"{target.base_url}/v1/chat/completions", json=body, headers=headers
        )
        if res.status_code >= 400:
            # Fehlertext mitloggen — sonst ist ein 400 nicht diagnostizierbar
            logger.warning(
                "%s antwortete %s: %s", cfg.provider, res.status_code, res.text[:300]
            )
        res.raise_for_status()
        data = res.json()

    usage = data.get("usage") or {}
    meta = dict(
        model=data.get("model") or target.model,
        prompt_tokens=int(usage.get("prompt_tokens") or 0),
        completion_tokens=int(usage.get("completion_tokens") or 0),
    )

    choices = data.get("choices") or []
    if not choices:
        return Completion(**meta)

    message = choices[0].get("message") or {}
    content = (message.get("content") or "").strip()
    if content:
        return Completion(content, **meta)

    # Reasoning-Modelle (z. B. ornith in LM Studio) legen ihre Gedanken in
    # reasoning_content ab. Ist content leer, ging das Token-Budget beim
    # Denken auf — die Antwort steckt dann allenfalls noch im Reasoning.
    reasoning = (message.get("reasoning_content") or "").strip()
    if reasoning:
        logger.warning(
            "%s lieferte leeres content-Feld (Reasoning-Modell, max_tokens=%d "
            "womöglich zu klein) — versuche Reasoning-Text",
            cfg.provider,
            max_tokens,
        )
        return Completion(reasoning, **meta)
    return Completion(**meta)


async def _complete_anthropic(
    cfg: AiConfig, system: str, user: str, max_tokens: int
) -> Completion:
    if not cfg.anthropic_api_key:
        return Completion()

    # Kein temperature/top_p: auf aktuellen Claude-Modellen sind die Sampling-
    # Parameter entfernt und liefern 400.
    body = {
        "model": cfg.anthropic_model or "claude-opus-5",
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    headers = {
        "x-api-key": cfg.anthropic_api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

    async with httpx.AsyncClient(timeout=COMPLETION_TIMEOUT) as client:
        res = await client.post(
            "https://api.anthropic.com/v1/messages", json=body, headers=headers
        )
        res.raise_for_status()
        data = res.json()

    # Sicherheits-Klassifikatoren können ablehnen — das ist HTTP 200 mit
    # stop_reason "refusal" und leerem content, kein Fehler.
    usage = data.get("usage") or {}
    meta = dict(
        model=data.get("model") or cfg.anthropic_model,
        prompt_tokens=int(usage.get("input_tokens") or 0),
        completion_tokens=int(usage.get("output_tokens") or 0),
    )

    if data.get("stop_reason") == "refusal":
        logger.warning("Anthropic hat die Anfrage abgelehnt (refusal)")
        return Completion(**meta)

    text = "".join(
        block.get("text", "")
        for block in data.get("content", [])
        if block.get("type") == "text"
    )
    return Completion(text or None, **meta)


async def _complete_gemini(
    cfg: AiConfig, system: str, user: str, max_tokens: int, json_mode: bool
) -> Completion:
    if not cfg.gemini_api_key:
        return Completion()

    model = cfg.gemini_model or "gemini-2.0-flash"
    generation: Dict[str, Any] = {"temperature": 0, "maxOutputTokens": max_tokens}
    if json_mode:
        generation["responseMimeType"] = "application/json"

    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": generation,
    }
    # Key im Header, nicht als Query-Parameter — der landet sonst in Logs.
    headers = {"Content-Type": "application/json", "x-goog-api-key": cfg.gemini_api_key}

    async with httpx.AsyncClient(timeout=COMPLETION_TIMEOUT) as client:
        res = await client.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            json=body,
            headers=headers,
        )
        res.raise_for_status()
        data = res.json()

    usage = data.get("usageMetadata") or {}
    meta = dict(
        model=model,
        prompt_tokens=int(usage.get("promptTokenCount") or 0),
        completion_tokens=int(usage.get("candidatesTokenCount") or 0),
    )

    candidates = data.get("candidates") or []
    if not candidates:
        return Completion(**meta)
    parts = (candidates[0].get("content") or {}).get("parts") or []
    return Completion("".join(p.get("text", "") for p in parts) or None, **meta)


async def complete(
    cfg: Optional[AiConfig],
    system: str,
    user: str,
    *,
    max_tokens: int = 1024,
    json_mode: bool = False,
) -> Optional[str]:
    """Nur den Antworttext. Fuer Aufrufer, die den Verbrauch nicht brauchen."""
    result = await complete_detailed(
        cfg, system, user, max_tokens=max_tokens, json_mode=json_mode
    )
    return result.text


async def complete_detailed(
    cfg: Optional[AiConfig],
    system: str,
    user: str,
    *,
    max_tokens: int = 1024,
    json_mode: bool = False,
) -> Completion:
    """Eine Completion beim konfigurierten Provider anfragen, inkl. Verbrauch.

    `text` ist None, wenn kein Provider konfiguriert ist, Zugangsdaten fehlen
    oder der Aufruf scheitert — Aufrufer müssen einen Fallback haben. KI ist in
    dieser App überall optional.
    """
    if cfg is None or not cfg.enabled:
        return Completion()

    try:
        if cfg.provider == "anthropic":
            return await _complete_anthropic(cfg, system, user, max_tokens)
        if cfg.provider == "gemini":
            return await _complete_gemini(cfg, system, user, max_tokens, json_mode)
        return await _complete_openai_compatible(cfg, system, user, max_tokens, json_mode)
    except Exception as e:
        # Typ mitloggen: httpx.ReadTimeout & Co. haben eine leere Meldung, ein
        # nacktes "fehlgeschlagen: " ist nicht diagnostizierbar
        logger.warning(
            "KI-Aufruf über %s fehlgeschlagen: %s: %s",
            cfg.provider,
            type(e).__name__,
            e or "(keine Meldung)",
        )
        return Completion()


async def list_models(cfg: AiConfig) -> List[str]:
    """Verfügbare Modelle. Lokale Provider werden live abgefragt, Cloud-Provider
    liefern die kuratierte Liste; OpenRouter bleibt leer (Freitextfeld)."""
    if cfg.provider in CLOUD_MODELS:
        return CLOUD_MODELS[cfg.provider]
    if cfg.provider not in LOCAL_PROVIDERS:
        return []

    base = resolve_host_url(
        (cfg.lm_studio_url or DEFAULT_LM_STUDIO_URL)
        if cfg.provider == "lm-studio"
        else (cfg.ollama_url or DEFAULT_OLLAMA_URL)
    )
    try:
        async with httpx.AsyncClient(timeout=LISTING_TIMEOUT) as client:
            res = await client.get(f"{base}/v1/models")
            res.raise_for_status()
            data = res.json()
    except Exception as e:
        logger.info("Modellliste von %s nicht abrufbar: %s", base, e)
        return []

    return [m["id"] for m in data.get("data", []) if isinstance(m, dict) and m.get("id")]
