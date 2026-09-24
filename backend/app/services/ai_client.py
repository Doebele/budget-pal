"""
Budget-Pal — provider-agnostischer KI-Client.

Eine Stelle, die weiß, wie man mit einem LLM spricht, damit alle KI-Features
(Import-Auswertung, Kategorisierung, Ausgabemuster, Sparvorschläge) dasselbe
vom Nutzer gewählte Modell verwenden.

Die Anbieterliste und das Profil-Modell folgen dem Schwesterprojekt fintools:
Anthropic spricht seine eigene Messages-API, *jeder andere* Anbieter die
OpenAI-kompatible `/chat/completions` + `/models` — auch Gemini, über Googles
`/v1beta/openai`. Damit ist ein neuer Anbieter eine Zeile in PROVIDER_CATALOG
statt eines neuen Codepfads.

Die Konfiguration liegt pro User in `users.ai_config_json`: welcher Anbieter
aktiv ist, und je Anbieter ein Profil aus Endpunkt, Modell und Key. Beim
Wechsel bleibt jedes Profil erhalten — ein Key wird nie auf einen anderen
Anbieter übertragen.

Abweichung von fintools, bewusst: Keys verlassen den Server nie. fintools gibt
sie roh an den Browser zurück; hier meldet die API nur `has_key`.
"""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

import httpx
from pydantic import BaseModel, Field, model_validator

logger = logging.getLogger(__name__)


# ── Anbieter ──────────────────────────────────────────────────


@dataclass(frozen=True)
class ProviderInfo:
    """Ein Eintrag der Anbieterliste. Ohne `key_url` ist er lokal und braucht
    keinen Key."""

    id: str
    label: str
    url: str
    key_url: str = ""
    placeholder: str = ""
    #: i18n-Schluessel eines Warnhinweises, der unter dem Key-Feld steht.
    note: str = ""
    #: Kontextfenster in Tokens, sofern verlaesslich bekannt. Lokale Server
    #: melden es selbst; None faellt auf eine vorsichtige Blockgroesse zurueck.
    context_tokens: Optional[int] = None
    #: `response_format: json_object` nur, wo es nachweislich ankommt. Alle
    #: anderen erhalten die JSON-Form ueber den Prompt — die Antwort wird
    #: ohnehin tolerant mit parse_json_object gelesen.
    json_object: bool = False

    @property
    def local(self) -> bool:
        return not self.key_url


# Reihenfolge und Endpunkte wie in fintools (frontend/src/App.jsx, AI_PROVIDERS),
# grob nach den fuehrenden Modellherstellern auf artificialanalysis.ai.
PROVIDER_CATALOG: Tuple[ProviderInfo, ...] = (
    # LM Studio lehnt response_format "json_object" ab (verlangt json_schema).
    ProviderInfo("lm-studio", "LM Studio", "http://localhost:1234"),
    ProviderInfo("ollama", "Ollama", "http://localhost:11434", json_object=True),
    ProviderInfo(
        "anthropic", "Anthropic (Claude)", "https://api.anthropic.com/v1",
        key_url="https://platform.claude.com/settings/keys", placeholder="sk-ant-...",
        context_tokens=200_000,
    ),
    ProviderInfo(
        "openai", "OpenAI (GPT)", "https://api.openai.com/v1",
        key_url="https://platform.openai.com/api-keys", placeholder="sk-...",
        context_tokens=128_000, json_object=True,
    ),
    ProviderInfo(
        "gemini", "Google (Gemini)", "https://generativelanguage.googleapis.com/v1beta/openai",
        key_url="https://aistudio.google.com/apikey", placeholder="AIza...",
        context_tokens=1_000_000,
    ),
    ProviderInfo("xai", "xAI (Grok)", "https://api.x.ai/v1",
                 key_url="https://console.x.ai/", placeholder="xai-..."),
    ProviderInfo("meta", "Meta (Muse)", "https://api.meta.ai/v1",
                 key_url="https://ai.developer.meta.com/"),
    ProviderInfo("mistral", "Mistral", "https://api.mistral.ai/v1",
                 key_url="https://console.mistral.ai/api-keys"),
    ProviderInfo("deepseek", "DeepSeek", "https://api.deepseek.com/v1",
                 key_url="https://platform.deepseek.com/api_keys", placeholder="sk-..."),
    ProviderInfo("qwen", "Alibaba (Qwen)",
                 "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
                 key_url="https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key",
                 placeholder="sk-..."),
    ProviderInfo("moonshot", "Kimi Platform (API)", "https://api.moonshot.ai/v1",
                 key_url="https://platform.kimi.ai/console/api-keys", placeholder="sk-..."),
    ProviderInfo("kimi-code", "Kimi Code (Coding Plan)", "https://api.kimi.ai/coding/v1",
                 key_url="https://www.kimi.ai/code/console", placeholder="sk-kimi-...",
                 note="ai.kimiCodeNote"),
    ProviderInfo("zai", "Z.AI (GLM) — Global", "https://api.z.ai/api/paas/v4",
                 key_url="https://z.ai/manage-apikey/apikey-list"),
    ProviderInfo("zai-cn", "BigModel (GLM) — China", "https://open.bigmodel.cn/api/paas/v4",
                 key_url="https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys"),
    ProviderInfo("minimax", "MiniMax", "https://api.minimax.io/v1",
                 key_url="https://platform.minimax.io/console/access"),
    ProviderInfo("mimo", "Xiaomi (MiMo)", "https://api.xiaomimimo.com/v1",
                 key_url="https://platform.xiaomimimo.com/"),
    ProviderInfo("stepfun", "StepFun (Step)", "https://api.stepfun.ai/v1",
                 key_url="https://platform.stepfun.ai/"),
    ProviderInfo(
        "openrouter", "OpenRouter", "https://openrouter.ai/api/v1",
        key_url="https://openrouter.ai/settings/keys", placeholder="sk-or-...",
        context_tokens=128_000,  # variiert stark je Modell — konservativ
        json_object=True,
    ),
)

CATALOG: Dict[str, ProviderInfo] = {p.id: p for p in PROVIDER_CATALOG}
PROVIDERS: Tuple[str, ...] = ("none", *CATALOG)
LOCAL_PROVIDERS: Tuple[str, ...] = tuple(p.id for p in PROVIDER_CATALOG if p.local)

DEFAULT_LM_STUDIO_URL = CATALOG["lm-studio"].url
DEFAULT_OLLAMA_URL = CATALOG["ollama"].url

#: Was `/models` liefert, ist nicht alles ein Chatmodell — Einbettungen,
#: Sprachausgabe und Bilder fliegen raus (Muster aus fintools).
_NON_CHAT_RE = re.compile(
    r"embed|tts|whisper|dall-e|moderation|transcri|realtime|audio|image|rerank", re.I
)

MODELS_TIMEOUT = 15.0
#: Verbindungstest. Ein lokales Modell muss beim ersten Aufruf evtl. erst
#: geladen werden — dort bekommt es mehr Zeit als eine Cloud-API.
TEST_TIMEOUT_CLOUD = 30.0
TEST_TIMEOUT_LOCAL = 90.0

_LOCALHOST_RE = re.compile(r"^(https?://)(localhost|127\.0\.0\.1)(:\d+)?", re.I)

# Lokale Modelle sind langsam: ein 35B-Reasoning-Modell braucht fuer einen
# 8000-Zeichen-Abschnitt gemessene ~170s. Der Wert ist eine Obergrenze fuer den
# Notfall, keine Wartezeit — Cloud-APIs antworten in Sekunden.
COMPLETION_TIMEOUT = 600.0
LISTING_TIMEOUT = 5.0

# Rueckfallwert, wenn das Kontextfenster unbekannt ist — bewusst klein, damit
# ein unbekanntes Modell nicht am ersten Aufruf scheitert.
DEFAULT_CHUNK_CHARS = 8_000


def parse_json_object(raw: Optional[str]) -> Optional[Dict[str, Any]]:
    """Das JSON-Objekt aus einer Modellantwort holen.

    Modelle halten sich nicht an json_mode: sie verpacken die Antwort in
    ```json-Fences, stellen Fliesstext voran oder — bei Reasoning-Modellen —
    erklaeren vorher das gewuenschte Format MIT Beispielklammern. Ein gieriges
    "vom ersten { bis zum letzten }" spannt dann ueber Beispiel UND Antwort und
    ist unparsebar.

    Deshalb: erst die ganze Antwort versuchen, dann jede balancierte
    {...}-Gruppe einzeln — die letzte gueltige gewinnt, weil die eigentliche
    Antwort hinter der Erklaerung steht.
    """
    text = (raw or "").strip()
    if not text:
        return None

    try:
        direct = json.loads(text)
        if isinstance(direct, dict):
            return direct
    except ValueError:
        pass

    best: Optional[Dict[str, Any]] = None
    depth = 0
    start = -1
    in_string = False
    escaped = False

    for index, char in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}":
            if depth == 0:
                continue
            depth -= 1
            if depth == 0 and start >= 0:
                try:
                    candidate = json.loads(text[start : index + 1])
                except ValueError:
                    continue
                if isinstance(candidate, dict):
                    best = candidate
    return best


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



class AiProfile(BaseModel):
    """Einstellungen eines Anbieters. Leerer Endpunkt = Vorgabe aus dem Katalog."""

    endpoint: str = ""
    model: str = ""
    key: str = ""
    #: Der letzte Verbindungstest mit genau diesen Werten war erfolgreich.
    ok: bool = False


# Frueheres, flaches Format: je Anbieter eigene Felder. Wird beim Lesen in
# Profile umgeschrieben und beim naechsten Speichern im neuen Format abgelegt.
_LEGACY_FIELDS: Dict[str, Tuple[Optional[str], Optional[str], Optional[str], str]] = {
    # provider: (url-Feld, key-Feld, model-Feld, damaliger Modell-Vorgabewert)
    "lm-studio": ("lm_studio_url", None, "lm_studio_model", ""),
    "ollama": ("ollama_url", None, "ollama_model", ""),
    "anthropic": (None, "anthropic_api_key", "anthropic_model", "claude-opus-5"),
    "openai": (None, "openai_api_key", "openai_model", "gpt-4o-mini"),
    "gemini": (None, "gemini_api_key", "gemini_model", "gemini-2.0-flash"),
    "openrouter": (None, "openrouter_api_key", "openrouter_model", "anthropic/claude-haiku-4-5"),
}


def _legacy_to_profiles(data: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Flache Altfelder → Profile. Nur Anbieter, zu denen etwas hinterlegt ist,
    plus der aktive — dessen damaliger Vorgabe-Modellname galt ja."""
    active = data.get("provider")
    profiles: Dict[str, Dict[str, Any]] = {}
    for provider, (url_f, key_f, model_f, default_model) in _LEGACY_FIELDS.items():
        url = data.get(url_f) if url_f else None
        key = data.get(key_f) if key_f else None
        model = data.get(model_f) if model_f else None
        if not (url or key or model or provider == active):
            continue
        profiles[provider] = {
            "endpoint": url or "",
            "key": key or "",
            "model": model if model is not None else default_model,
        }
    return profiles


class AiConfig(BaseModel):
    """Aktiver Anbieter plus ein Profil je Anbieter."""

    provider: str = "none"
    profiles: Dict[str, AiProfile] = Field(default_factory=dict)
    # Zeichen pro Anfrage bei der PDF-Auswertung. 0 = automatisch aus dem
    # Kontextfenster des Modells ableiten.
    context_chars_override: int = 0

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy(cls, data: Any) -> Any:
        """Das alte flache Format lesen koennen — aus der DB wie im Code
        (`AiConfig(provider="openai", openai_api_key=...)`)."""
        if not isinstance(data, dict):
            return data
        legacy_keys = {f for spec in _LEGACY_FIELDS.values() for f in spec[:3] if f}
        if not legacy_keys & data.keys():
            return data
        merged = dict(data)
        profiles = dict(merged.get("profiles") or {})
        for provider, prof in _legacy_to_profiles(data).items():
            profiles.setdefault(provider, prof)
        merged["profiles"] = profiles
        for field in legacy_keys:
            merged.pop(field, None)
        return merged

    @property
    def enabled(self) -> bool:
        return self.provider in CATALOG

    def profile(self, provider: Optional[str] = None) -> AiProfile:
        """Profil eines Anbieters, Endpunkt mit Katalog-Vorgabe aufgefuellt."""
        pid = provider or self.provider
        stored = self.profiles.get(pid) or AiProfile()
        info = CATALOG.get(pid)
        return stored.model_copy(
            update={"endpoint": stored.endpoint or (info.url if info else "")}
        )


def effective_endpoint(provider: str, endpoint: Optional[str]) -> str:
    """Endpunkt, wie er tatsaechlich angesprochen wird — leer heisst Vorgabe."""
    info = CATALOG.get(provider)
    return ((endpoint or "").strip() or (info.url if info else "")).rstrip("/")


def endpoint_moves(provider: str, stored: AiProfile, endpoint: Optional[str]) -> bool:
    """Zeigt `endpoint` woanders hin als der, mit dem der Key gespeichert wurde?

    Die Regel dahinter: ein gespeicherter Key geht nur an den Endpunkt, mit
    dem er gespeichert wurde. Test, Speichern und Backup-Import pruefen sie
    alle hier — sonst genuegte ein gestohlenes Session-Token (oder eine
    praeparierte Backup-Datei), um den Key an einen fremden Server zu lenken.
    """
    if endpoint is None:
        return False
    return effective_endpoint(provider, endpoint) != effective_endpoint(provider, stored.endpoint)


def export_config(cfg: AiConfig, *, include_keys: bool) -> Dict[str, Any]:
    """Konfiguration fuer das Backup. Keys nur auf ausdruecklichen Wunsch."""
    profiles: Dict[str, Dict[str, Any]] = {}
    for pid, prof in cfg.profiles.items():
        entry: Dict[str, Any] = {"endpoint": prof.endpoint, "model": prof.model}
        if include_keys and prof.key:
            entry["key"] = prof.key
        profiles[pid] = entry
    return {
        "provider": cfg.provider,
        "context_chars_override": cfg.context_chars_override,
        "profiles": profiles,
    }


def import_config(cfg: AiConfig, data: Any) -> Tuple[AiConfig, int, List[str]]:
    """Konfiguration aus einem Backup uebernehmen.

    Die Datei ist Nutzereingabe: unbekannte Anbieter, kaputte Endpunkte und
    falsche Typen werden uebersprungen statt uebernommen. Test-Haken werden
    zurueckgesetzt — getestet war die alte Umgebung, nicht diese.

    Gibt (neue Konfiguration, Zahl uebernommener Keys, Warnungen) zurueck.
    """
    warnings: List[str] = []
    if not isinstance(data, dict):
        return cfg, 0, ["KI-Einstellungen im Backup unlesbar — übersprungen."]

    result = cfg.model_copy(deep=True)
    keys = 0

    provider = data.get("provider")
    if provider in PROVIDERS:
        result.provider = provider
    elif provider is not None:
        warnings.append(f"Unbekannter KI-Anbieter '{provider}' — nicht übernommen.")

    override = data.get("context_chars_override")
    if isinstance(override, int) and override >= 0:
        result.context_chars_override = override

    for pid, raw in (data.get("profiles") or {}).items():
        if pid not in CATALOG or not isinstance(raw, dict):
            warnings.append(f"KI-Profil '{pid}' unbekannt — übersprungen.")
            continue
        endpoint = raw.get("endpoint")
        if endpoint is not None and (
            not isinstance(endpoint, str)
            or (endpoint and not re.match(r"^https?://[^\s/]+", endpoint.strip()))
        ):
            warnings.append(f"KI-Profil '{pid}': ungültiger Endpunkt — übersprungen.")
            continue

        stored = result.profiles.get(pid) or AiProfile()
        key = raw.get("key") if isinstance(raw.get("key"), str) else None
        updated = stored.model_copy(update={"ok": False})
        if isinstance(endpoint, str):
            updated.endpoint = endpoint
        if isinstance(raw.get("model"), str):
            updated.model = raw["model"]
        if key:
            updated.key = key
            keys += 1
        elif stored.key and endpoint_moves(pid, stored, endpoint):
            # Ohne Key in der Datei zieht der gespeicherte nicht mit um
            updated.key = ""
            warnings.append(
                f"KI-Profil '{pid}': anderer Endpunkt ohne Key im Backup — "
                "gespeicherter Key verworfen, bitte neu eingeben."
            )
        result.profiles[pid] = updated

    return result, keys, warnings


def resolve_host_url(url: str) -> str:
    """localhost → host.docker.internal.

    Das Backend läuft im Container; ein lokal laufendes LM Studio oder Ollama
    ist von dort unter `localhost` NICHT erreichbar. Ohne diese Umschreibung
    scheitern die lokalen Provider still.
    """
    return _LOCALHOST_RE.sub(r"\1host.docker.internal\3", (url or "").rstrip("/"))


def api_base(endpoint: str) -> str:
    """Basis-URL der OpenAI-kompatiblen API.

    Ein nackter Host (LM Studio, Ollama) bekommt `/v1`; ein Pfad wird
    uebernommen, wie er ist — Z.AI endet auf `/paas/v4`, Gemini auf
    `/v1beta/openai`, Kimi Code auf `/coding/v1`.
    """
    base = resolve_host_url(endpoint)
    return f"{base}/v1" if re.fullmatch(r"https?://[^/]+", base) else base


def _host_root(endpoint: str) -> str:
    """Server-Wurzel fuer die nativen Schnittstellen von LM Studio und Ollama."""
    return re.sub(r"/v1$", "", resolve_host_url(endpoint))


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


# ── Aufruf ────────────────────────────────────────────────────


class AiHttpError(Exception):
    """Ein Anbieter hat mit einem Fehlerstatus geantwortet."""


def _headers(provider: str, key: str) -> Dict[str, str]:
    if provider == "anthropic":
        return {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        }
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    if provider == "openrouter":
        headers.update({"HTTP-Referer": "https://budgetpal.doebele12.de", "X-Title": "Budget-Pal"})
    return headers


def _error_message(res: httpx.Response) -> str:
    """Fehlertext fuer den Nutzer.

    Nur `error.message` aus einer JSON-Antwort — nie der rohe Antworttext.
    Der Endpunkt ist frei waehlbar; wer ihn auf eine interne Adresse zeigt,
    soll deren Seiteninhalt nicht zurueckgespiegelt bekommen. fintools gibt
    hier 200 Zeichen Rohtext zurueck; BudgetPal laeuft oeffentlich.
    """
    detail = ""
    try:
        payload = res.json()
        err = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(err, dict):
            detail = str(err.get("message") or "")
        elif isinstance(err, str):
            detail = err
    except ValueError:
        pass
    return f"HTTP {res.status_code}" + (f": {detail[:200]}" if detail else "")


def _needs_key(provider: str) -> bool:
    info = CATALOG.get(provider)
    return bool(info and not info.local)


async def _complete_raw(
    cfg: AiConfig,
    system: str,
    user: str,
    *,
    max_tokens: int,
    json_mode: bool = False,
    timeout: float = 600.0,
) -> Completion:
    """Ein Aufruf beim aktiven Anbieter. Wirft bei Fehlern — `complete_detailed`
    faengt sie ab, der Verbindungstest will sie sehen."""
    provider = cfg.provider
    info = CATALOG[provider]
    prof = cfg.profile()
    if _needs_key(provider) and not prof.key:
        raise AiHttpError("Kein API-Key hinterlegt")

    base = api_base(prof.endpoint)
    if provider == "anthropic":
        url = f"{base}/messages"
        # Kein temperature/top_p: auf aktuellen Claude-Modellen sind die
        # Sampling-Parameter entfernt und liefern 400.
        body: Dict[str, Any] = {
            "model": prof.model or "claude-opus-5",
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
    elif info.local:
        url = f"{base}/chat/completions"
        # Lokale Reasoning-Modelle (Qwen3 u. a.) verbrauchen sonst das ganze
        # Token-Budget beim Denken; `/no_think` ist Qwens Schalter dafuer.
        body = {
            "messages": [
                {"role": "system", "content": f"/no_think {system}"},
                {"role": "user", "content": user},
            ],
            "max_tokens": max_tokens,
            "temperature": 0,
            "reasoning_effort": "none",
        }
        if prof.model:
            body["model"] = prof.model
    else:
        url = f"{base}/chat/completions"
        # Cloud: kein temperature — OpenAIs Reasoning-Modelle lehnen andere
        # Werte als den Standard ab. Neuere OpenAI-Modelle verlangen
        # max_completion_tokens statt max_tokens.
        body = {
            "model": prof.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_completion_tokens" if provider == "openai" else "max_tokens": max_tokens,
        }
    if json_mode and info.json_object and provider != "anthropic":
        body["response_format"] = {"type": "json_object"}

    async with httpx.AsyncClient(timeout=timeout) as client:
        res = await client.post(url, json=body, headers=_headers(provider, prof.key))
    if res.status_code >= 400:
        # Fehlertext mitloggen — sonst ist ein 400 nicht diagnostizierbar
        logger.warning("%s antwortete %s: %s", provider, res.status_code, res.text[:300])
        raise AiHttpError(_error_message(res))
    data = res.json()

    if provider == "anthropic":
        usage = data.get("usage") or {}
        meta = dict(
            model=data.get("model") or prof.model,
            prompt_tokens=int(usage.get("input_tokens") or 0),
            completion_tokens=int(usage.get("output_tokens") or 0),
        )
        # Sicherheits-Klassifikatoren können ablehnen — das ist HTTP 200 mit
        # stop_reason "refusal" und leerem content, kein Fehler.
        if data.get("stop_reason") == "refusal":
            logger.warning("Anthropic hat die Anfrage abgelehnt (refusal)")
            return Completion(**meta)
        text = "".join(
            block.get("text", "")
            for block in data.get("content", [])
            if block.get("type") == "text"
        )
        return Completion(text or None, **meta)

    usage = data.get("usage") or {}
    meta = dict(
        model=data.get("model") or prof.model,
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

    # Reasoning-Modelle legen ihre Gedanken in reasoning_content ab. Ist
    # content leer, ging das Token-Budget beim Denken auf — die Antwort
    # steckt dann allenfalls noch im Reasoning.
    reasoning = (message.get("reasoning_content") or "").strip()
    if reasoning:
        logger.warning(
            "%s lieferte leeres content-Feld (Reasoning-Modell, max_tokens=%d "
            "womöglich zu klein) — versuche Reasoning-Text",
            provider,
            max_tokens,
        )
        return Completion(reasoning, **meta)
    return Completion(**meta)


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
        return await _complete_raw(
            cfg, system, user,
            max_tokens=max_tokens, json_mode=json_mode, timeout=COMPLETION_TIMEOUT,
        )
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


# ── Modellliste und Verbindungstest ───────────────────────────


async def fetch_models(cfg: AiConfig) -> List[str]:
    """Chatfaehige Modelle des aktiven Anbieters, live vom `/models`-Endpunkt.
    Wirft bei Fehlern."""
    provider = cfg.provider
    prof = cfg.profile()
    if _needs_key(provider) and not prof.key:
        raise AiHttpError("Kein API-Key hinterlegt")
    query = "?limit=1000" if provider == "anthropic" else ""
    async with httpx.AsyncClient(timeout=MODELS_TIMEOUT) as client:
        res = await client.get(
            f"{api_base(prof.endpoint)}/models{query}", headers=_headers(provider, prof.key)
        )
    if res.status_code >= 400:
        raise AiHttpError(_error_message(res))
    ids = []
    for entry in res.json().get("data", []) or []:
        if not isinstance(entry, dict) or not entry.get("id"):
            continue
        model_id = re.sub(r"^models/", "", str(entry["id"]))  # Gemini: "models/…"
        if not _NON_CHAT_RE.search(model_id):
            ids.append(model_id)
    return sorted(ids)


async def list_models(cfg: AiConfig) -> List[str]:
    """Wie fetch_models, aber still: bei Fehlern eine leere Liste."""
    if not cfg.enabled:
        return []
    try:
        return await fetch_models(cfg)
    except Exception as e:
        logger.info("Modellliste von %s nicht abrufbar: %s", cfg.provider, e)
        return []


class ConnectionResult(NamedTuple):
    ok: bool
    models: Optional[List[str]] = None
    model: str = ""
    reply: str = ""
    latency_ms: int = 0
    error: str = ""


async def check_connection(cfg: AiConfig) -> ConnectionResult:
    """Endpunkt und Key pruefen, Modelle auflisten und — falls eines gewaehlt
    ist — mit einer Minimalanfrage anpingen (wie fintools' /tools/test-ai).

    Nicht `test_…` benannt: pytest sammelt so benannte Funktionen ein, sobald
    eine Testdatei sie importiert."""
    if not cfg.enabled:
        return ConnectionResult(ok=False, error="Kein Anbieter gewählt")

    models: Optional[List[str]] = None
    list_error = ""
    try:
        models = await fetch_models(cfg)
    except Exception as e:
        list_error = _describe(e)

    if not cfg.profile().model:
        if models is not None:
            return ConnectionResult(ok=True, models=models)
        return ConnectionResult(ok=False, error=list_error)

    timeout = TEST_TIMEOUT_LOCAL if CATALOG[cfg.provider].local else TEST_TIMEOUT_CLOUD
    started = time.monotonic()
    try:
        result = await _complete_raw(
            cfg, "Reply with the single word OK.", "OK?", max_tokens=200, timeout=timeout
        )
    except Exception as e:
        return ConnectionResult(ok=False, models=models, error=_describe(e))
    return ConnectionResult(
        ok=True,
        models=models,
        model=result.model,
        reply=(result.text or "").strip() or "(leer)",
        latency_ms=int((time.monotonic() - started) * 1000),
    )


def _describe(error: Exception) -> str:
    """Kurze, gefahrlose Fehlerbeschreibung fuer die Oberflaeche."""
    if isinstance(error, AiHttpError):
        return str(error)
    if isinstance(error, httpx.TimeoutException):
        return "Zeitüberschreitung"
    if isinstance(error, httpx.ConnectError):
        return "Keine Verbindung zum Endpunkt"
    return type(error).__name__


# ── Kontextfenster ────────────────────────────────────────────
#
# Wie viel Text pro Anfrage sinnvoll ist, haengt am Kontextfenster des Modells.
# Lokale Server melden es; fuer Cloud-Anbieter steht es im Katalog, soweit
# verlaesslich bekannt.

# Konservativ: deutscher Fliesstext mit Zahlen liegt eher bei 3-4 Zeichen/Token
CHARS_PER_TOKEN = 3.5
# Platz fuer System-Prompt samt Few-Shot-Beispielen
PROMPT_RESERVE_TOKENS = 2000
# Deckel pro Anfrage. Ein 262k-Modell koennte theoretisch ein ganzes Buch
# aufnehmen, aber die Antwortzeit waechst mit der Prompt-Laenge — und ein
# Fehlversuch kostet dann Minuten statt Sekunden.
MAX_CHUNK_CHARS = 120_000
MIN_CHUNK_CHARS = 4_000

# Kontextfenster bekannter Cloud-Anbieter (Tokens) — abgeleitet aus dem Katalog
CLOUD_CONTEXT_TOKENS: Dict[str, int] = {
    p.id: p.context_tokens for p in PROVIDER_CATALOG if p.context_tokens and not p.local
}


async def detect_context_tokens(cfg: AiConfig) -> Optional[int]:
    """Kontextfenster des aktuell gewaehlten Modells in Tokens.

    Lokale Server werden gefragt (LM Studio: /api/v0/models, Ollama:
    /api/show), Cloud-Anbieter kommen aus dem Katalog. None, wenn unbekannt.
    """
    if not cfg.enabled:
        return None
    prof = cfg.profile()

    if cfg.provider == "lm-studio":
        try:
            async with httpx.AsyncClient(timeout=LISTING_TIMEOUT) as client:
                res = await client.get(f"{_host_root(prof.endpoint)}/api/v0/models")
                res.raise_for_status()
                for entry in res.json().get("data", []):
                    if entry.get("id") != prof.model:
                        continue
                    value = entry.get("loaded_context_length") or entry.get(
                        "max_context_length"
                    )
                    return int(value) if value else None
        except Exception as e:
            logger.info("Kontextfenster von LM Studio nicht abrufbar: %s", e)
        return None

    if cfg.provider == "ollama":
        try:
            async with httpx.AsyncClient(timeout=LISTING_TIMEOUT) as client:
                res = await client.post(
                    f"{_host_root(prof.endpoint)}/api/show", json={"model": prof.model}
                )
                res.raise_for_status()
                info = res.json().get("model_info") or {}
                # Der Schluessel traegt den Architekturnamen: "gemma3.context_length"
                for key, value in info.items():
                    if key.endswith(".context_length") and value:
                        return int(value)
        except Exception as e:
            logger.info("Kontextfenster von Ollama nicht abrufbar: %s", e)
        return None

    return CATALOG[cfg.provider].context_tokens


async def resolve_chunk_chars(cfg: AiConfig, max_output_tokens: int) -> int:
    """Wie viele Zeichen Dokumenttext pro Anfrage mitgehen duerfen.

    Übersteuerung des Nutzers schlaegt alles. Sonst aus dem Kontextfenster
    abgeleitet, abzueglich Platz fuer System-Prompt und Antwort — beide teilen
    sich das Fenster mit der Eingabe.
    """
    if cfg.context_chars_override > 0:
        return max(MIN_CHUNK_CHARS, min(cfg.context_chars_override, MAX_CHUNK_CHARS))

    context_tokens = await detect_context_tokens(cfg)
    if not context_tokens:
        return DEFAULT_CHUNK_CHARS

    usable = context_tokens - max_output_tokens - PROMPT_RESERVE_TOKENS
    if usable <= 0:
        return MIN_CHUNK_CHARS
    return max(MIN_CHUNK_CHARS, min(int(usable * CHARS_PER_TOKEN), MAX_CHUNK_CHARS))
