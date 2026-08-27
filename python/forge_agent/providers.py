"""Provider boundary for Forge v0.2.

The default provider remains deterministic and offline. The optional
OpenAI-compatible adapter supports chat-completion tool calls and streaming
text without persisting credentials.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Protocol


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ProviderReply:
    text: str = ""
    tool_calls: tuple[ToolCall, ...] = ()
    usage: dict[str, Any] = field(default_factory=dict)
    raw_message: dict[str, Any] = field(default_factory=dict)


class Provider(Protocol):
    def complete(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        on_text: Callable[[str], None] | None = None,
    ) -> ProviderReply:
        """Return a normalized response for the current conversation."""


PROVIDER_PRESETS: dict[str, dict[str, Any]] = {
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "key_envs": ("OPENROUTER_API_KEY",),
        "model": "openai/gpt-4o-mini",
    },
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "key_envs": ("GROQ_API_KEY",),
        "model": "llama-3.3-70b-versatile",
    },
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "key_envs": ("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_AI_STUDIO_API_KEY"),
        "model": "gemini-2.0-flash",
    },
    "google": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "key_envs": ("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_AI_STUDIO_API_KEY"),
        "model": "gemini-2.0-flash",
    },
    "google-ai-studio": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "key_envs": ("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_AI_STUDIO_API_KEY"),
        "model": "gemini-2.0-flash",
    },
    "xai": {
        "base_url": "https://api.x.ai/v1",
        "key_envs": ("XAI_API_KEY",),
        "model": "grok-3-mini",
    },
}


class MockProvider:
    def complete(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        on_text: Callable[[str], None] | None = None,
    ) -> ProviderReply:
        del tools
        system_text = str(messages[0].get("content", "")).lower() if messages else ""
        custom_match = re.search(r"roleid=(custom-[a-z0-9-]+)", system_text)
        role = next((candidate for candidate in ("explorer", "architect", "implementer", "tester", "reviewer") if candidate in system_text), None)
        if custom_match:
            role_id = custom_match.group(1)
            artifact = {"version": 1, "kind": "custom", "roleId": role_id, "mission": "Review the bounded task using supplied context.", "findings": ["Deterministic offline specialist evidence is advisory."], "evidence": [{"source": "mock-provider", "detail": "bounded supplied context"}], "risks": ["live provider behavior is unverified"], "recommendedChecks": ["run the supervisor-selected verification"], "unknowns": ["deployment state"]}
        elif role == "explorer":
            artifact = {"version": 1, "kind": role, "files": [{"path": "README.md", "relevance": "project guidance", "evidence": "supplied context"}], "symbols": [], "conventions": ["follow supplied project scripts"], "risks": ["provider output remains advisory"], "unknowns": ["runtime state"], "evidence": [{"source": "context", "detail": "bounded repository context"}]}
        elif role == "architect":
            artifact = {"version": 1, "kind": role, "milestoneGraph": [{"localId": "m1", "title": "Bounded implementation", "description": "Implement the requested change", "expectedFiles": [], "dependsOn": [], "risks": ["scope drift"], "tests": ["project verification"], "postconditions": ["supervisor evidence is recorded"]}], "acceptanceMapping": [{"requirement": "requested goal is addressed", "files": [], "tests": ["project verification"]}], "assumptions": ["context is current"], "unknowns": ["provider-specific details"]}
        elif role == "implementer":
            artifact = {"version": 1, "kind": role, "proposedDiff": "No executable diff proposed by deterministic fixture.", "affectedFiles": ["README.md"], "preconditions": ["supervisor review is complete"], "rollbackNotes": ["restore the supervisor checkpoint"], "postconditions": ["targeted verification passes"]}
        elif role == "tester":
            artifact = {"version": 1, "kind": role, "testMatrix": [{"area": "bounded regression", "command": "project verification", "expectedEvidence": "structured passing result"}], "unverifiedChecks": ["live provider behavior"], "coverageGaps": ["deployment environment"]}
        elif role == "reviewer":
            artifact = {"version": 1, "kind": role, "blockers": [], "contradictions": [], "nonBlockingImprovements": ["replace fixture evidence with live repository evidence"], "goNoGo": "go", "rationale": "The deterministic artifact is bounded and advisory."}
        else:
            artifact = None
        text = json.dumps(artifact, ensure_ascii=False) if artifact is not None else f"Mock provider response for: {messages[-1].get('content', '')}"
        if on_text:
            on_text(text)
        return ProviderReply(text=text)


def bounded_env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.isdigit():
        return default
    return max(minimum, min(maximum, int(raw)))


def optional_bounded_env_int(name: str, minimum: int, maximum: int) -> int | None:
    raw = os.environ.get(name)
    if raw is None or not raw.isdigit():
        return None
    return max(minimum, min(maximum, int(raw)))


def redact(text: str) -> str:
    text = re.sub(r"sk-[A-Za-z0-9_-]{4}[A-Za-z0-9_-]+", "sk-****[REDACTED]", text)
    return re.sub(r"(?i)(api[_-]?key|token|password|secret)\s*[:=]\s*[^,\s}]+", r"\1=[REDACTED]", text)


class OpenAICompatibleProvider:
    def __init__(self, *, api_key: str, base_url: str, model: str, timeout: float = 90.0, max_tokens: int | None = None, reasoning_effort: str | None = None, max_retries: int = 2, headers: dict[str, str] | None = None, token_parameter: Literal["auto", "max_tokens", "max_completion_tokens"] = "auto") -> None:
        if not api_key:
            raise ValueError("FORGE_API_KEY or OPENAI_API_KEY is required for the OpenAI-compatible provider")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.max_tokens = max_tokens
        self.reasoning_effort = reasoning_effort
        self.max_retries = max(0, min(max_retries, 5))
        self.token_parameter = token_parameter
        self.headers = {key: value[:500] for key, value in (headers or {}).items() if value and "\n" not in value and "\r" not in value}

    def complete(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        on_text: Callable[[str], None] | None = None,
    ) -> ProviderReply:
        tool_name_map = self._tool_name_map(tools)
        request_messages = self._encode_messages(messages, tool_name_map)
        request_tools = self._encode_tools(tools, tool_name_map)
        stream_enabled = bool(on_text)
        if os.environ.get("FORGE_STREAM", "auto").strip().lower() in {"0", "false", "no", "off"}:
            stream_enabled = False
        body: dict[str, Any] = {
            "model": self.model,
            "messages": request_messages,
            "temperature": 0,
            "stream": stream_enabled,
        }
        if self.max_tokens is not None:
            parameter = self.token_parameter
            if parameter == "auto":
                parameter = "max_completion_tokens" if self.model.lower().startswith("gpt-5") else "max_tokens"
            body[parameter] = self.max_tokens
        if self.reasoning_effort:
            body["reasoning_effort"] = self.reasoning_effort
        if request_tools:
            body["tools"] = request_tools
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                **self.headers,
            },
            method="POST",
        )
        for attempt in range(self.max_retries + 1):
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    if stream_enabled and on_text:
                        return self._read_stream(response, on_text, tool_name_map)
                    payload = json.loads(response.read().decode("utf-8"))
                return self._parse_payload(payload, tool_name_map)
            except urllib.error.HTTPError as exc:
                detail = redact(exc.read().decode("utf-8", errors="replace")[:1000])
                if exc.code in {408, 409, 429, 500, 502, 503, 504} and attempt < self.max_retries:
                    time.sleep(min(2 ** attempt, 8))
                    continue
                raise RuntimeError(f"Provider HTTP {exc.code}: {detail}") from exc
            except (urllib.error.URLError, TimeoutError) as exc:
                if attempt < self.max_retries:
                    time.sleep(min(2 ** attempt, 8))
                    continue
                raise RuntimeError(f"Provider request failed: {redact(str(exc))}") from exc
        raise RuntimeError("Provider request exhausted its retry budget")

    @staticmethod
    def _tool_name_map(tools: list[dict[str, Any]]) -> dict[str, str]:
        result: dict[str, str] = {}
        used: set[str] = set()
        for tool in tools:
            function = tool.get("function")
            if not isinstance(function, dict) or not isinstance(function.get("name"), str):
                continue
            original = function["name"]
            encoded = original
            if not re.fullmatch(r"[A-Za-z0-9_-]+", encoded):
                encoded = "forge_" + "".join(
                    character if re.fullmatch(r"[A-Za-z0-9_-]", character) else f"_u{ord(character):x}_"
                    for character in original
                )
            if encoded in used and result.get(original) != encoded:
                encoded = f"{encoded}_{len(used)}"
            result[original] = encoded
            used.add(encoded)
        return result

    @staticmethod
    def _encode_tools(tools: list[dict[str, Any]], tool_name_map: dict[str, str]) -> list[dict[str, Any]]:
        encoded_tools: list[dict[str, Any]] = []
        reverse = {original: encoded for original, encoded in tool_name_map.items()}
        for tool in tools:
            encoded = dict(tool)
            function = tool.get("function")
            if isinstance(function, dict):
                encoded_function = dict(function)
                name = encoded_function.get("name")
                if isinstance(name, str):
                    encoded_function["name"] = reverse.get(name, name)
                encoded["function"] = encoded_function
            encoded_tools.append(encoded)
        return encoded_tools

    @staticmethod
    def _encode_messages(messages: list[dict[str, Any]], tool_name_map: dict[str, str]) -> list[dict[str, Any]]:
        encoded_messages: list[dict[str, Any]] = []
        for message in messages:
            encoded = dict(message)
            calls = message.get("tool_calls")
            if isinstance(calls, list):
                encoded_calls: list[dict[str, Any]] = []
                for call in calls:
                    encoded_call = dict(call)
                    function = call.get("function")
                    if isinstance(function, dict):
                        encoded_function = dict(function)
                        name = encoded_function.get("name")
                        if isinstance(name, str):
                            encoded_function["name"] = tool_name_map.get(name, name)
                        encoded_call["function"] = encoded_function
                    encoded_calls.append(encoded_call)
                encoded["tool_calls"] = encoded_calls
            encoded_messages.append(encoded)
        return encoded_messages

    @staticmethod
    def _restore_message_tool_names(message: dict[str, Any], tool_name_map: dict[str, str]) -> dict[str, Any]:
        restored = dict(message)
        reverse = {encoded: original for original, encoded in tool_name_map.items()}
        calls = message.get("tool_calls")
        if isinstance(calls, list):
            restored_calls: list[dict[str, Any]] = []
            for call in calls:
                restored_call = dict(call)
                function = call.get("function")
                if isinstance(function, dict):
                    restored_function = dict(function)
                    name = restored_function.get("name")
                    if isinstance(name, str):
                        restored_function["name"] = reverse.get(name, name)
                    restored_call["function"] = restored_function
                restored_calls.append(restored_call)
            restored["tool_calls"] = restored_calls
        return restored

    def _read_stream(self, response: Any, on_text: Callable[[str], None], tool_name_map: dict[str, str] | None = None) -> ProviderReply:
        text_parts: list[str] = []
        tool_fragments: dict[str, dict[str, Any]] = {}
        usage: dict[str, Any] = {}
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                payload = json.loads(data)
            except json.JSONDecodeError:
                continue
            usage.update(payload.get("usage") or {})
            choices = payload.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            fragment = delta.get("content")
            if isinstance(fragment, str) and fragment:
                text_parts.append(fragment)
                on_text(fragment)
            for call in delta.get("tool_calls") or []:
                index = str(call.get("index", 0))
                state = tool_fragments.setdefault(
                    index,
                    {"id": "", "name": "", "arguments": "", "metadata": {}},
                )
                state["id"] += str(call.get("id") or "")
                function = call.get("function") or {}
                state["name"] += str(function.get("name") or "")
                state["arguments"] += str(function.get("arguments") or "")
                for key in ("extra_content", "thought_signature", "thoughtSignature"):
                    if key in call:
                        state["metadata"][key] = call[key]
        calls = self._parse_tool_fragments(tool_fragments, tool_name_map or {})
        raw_calls: list[dict[str, Any]] = []
        for state in tool_fragments.values():
            raw_call: dict[str, Any] = {
                "id": state["id"],
                "type": "function",
                "function": {
                    "name": self._restore_tool_name(state["name"], tool_name_map or {}),
                    "arguments": state["arguments"] or "{}",
                },
            }
            raw_call.update(state["metadata"])
            raw_calls.append(raw_call)
        raw_message: dict[str, Any] = {"role": "assistant", "content": "".join(text_parts)}
        if raw_calls:
            raw_message["tool_calls"] = raw_calls
        return ProviderReply(
            text="".join(text_parts),
            tool_calls=calls,
            usage=usage,
            raw_message=raw_message if raw_calls else {},
        )

    @staticmethod
    def _restore_tool_name(name: str, tool_name_map: dict[str, str]) -> str:
        reverse = {encoded: original for original, encoded in tool_name_map.items()}
        return reverse.get(name, name)

    def _parse_payload(self, payload: dict[str, Any], tool_name_map: dict[str, str] | None = None) -> ProviderReply:
        choice = (payload.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        calls: list[ToolCall] = []
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            raw_arguments = function.get("arguments", "{}")
            try:
                arguments = json.loads(raw_arguments) if isinstance(raw_arguments, str) else raw_arguments
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"Provider returned invalid tool arguments: {exc}") from exc
            if not isinstance(arguments, dict):
                raise RuntimeError("Provider tool arguments must be a JSON object")
            name = str(function.get("name", ""))
            calls.append(ToolCall(id=str(call.get("id", "")), name=self._restore_tool_name(name, tool_name_map or {}), arguments=arguments))
        return ProviderReply(
            text=str(message.get("content") or ""),
            tool_calls=tuple(calls),
            usage=payload.get("usage") or {},
            raw_message=self._restore_message_tool_names(message, tool_name_map or {}),
        )

    @staticmethod
    def _parse_tool_fragments(fragments: dict[str, dict[str, Any]], tool_name_map: dict[str, str] | None = None) -> tuple[ToolCall, ...]:
        calls: list[ToolCall] = []
        for state in fragments.values():
            try:
                arguments = json.loads(state["arguments"] or "{}")
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"Provider returned invalid streamed tool arguments: {exc}") from exc
            if isinstance(arguments, dict):
                calls.append(ToolCall(id=state["id"], name=OpenAICompatibleProvider._restore_tool_name(state["name"], tool_name_map or {}), arguments=arguments))
        return tuple(calls)


def build_provider() -> Provider:
    provider_name = os.environ.get("FORGE_PROVIDER", "mock").lower()
    if provider_name in {"mock", "test"}:
        return MockProvider()
    preset = PROVIDER_PRESETS.get(provider_name)
    if provider_name in {"openai", "openai-compatible", "compatible"} or preset:
        max_tokens = optional_bounded_env_int("FORGE_MAX_TOKENS", 256, 100_000)
        if preset:
            api_key = next((os.environ.get(name, "") for name in preset["key_envs"] if os.environ.get(name)), "")
            base_url = os.environ.get("FORGE_BASE_URL", preset["base_url"])
            model = os.environ.get("FORGE_MODEL", preset["model"])
            if not api_key:
                raise ValueError(f"{provider_name} requires one of: {', '.join(preset['key_envs'])}")
        else:
            api_key = os.environ.get("FORGE_API_KEY") or os.environ.get("OPENAI_API_KEY", "")
            base_url = os.environ.get("FORGE_BASE_URL", "https://api.openai.com/v1")
            model = os.environ.get("FORGE_MODEL", "gpt-4.1-mini")
        token_parameter = os.environ.get("FORGE_TOKEN_PARAMETER", "auto")
        if token_parameter not in {"auto", "max_tokens", "max_completion_tokens"}:
            token_parameter = "auto"
        return OpenAICompatibleProvider(
            api_key=api_key,
            base_url=base_url,
            model=model,
            max_tokens=max_tokens,
            reasoning_effort=os.environ.get("FORGE_REASONING_EFFORT"),
            max_retries=bounded_env_int("FORGE_PROVIDER_RETRIES", 2, 0, 5),
            token_parameter=token_parameter,
            headers={
                "HTTP-Referer": os.environ.get("FORGE_HTTP_REFERER", "") ,
                "X-OpenRouter-Title": os.environ.get("FORGE_APP_NAME", "Forge CLI"),
            },
        )
    raise ValueError(f"Unsupported FORGE_PROVIDER: {provider_name}")
