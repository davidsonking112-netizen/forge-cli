"""Provider boundary for Forge v0.2.

The default provider remains deterministic and offline. The optional
OpenAI-compatible adapter supports chat-completion tool calls and streaming
text without persisting credentials.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol


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


class MockProvider:
    def complete(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        on_text: Callable[[str], None] | None = None,
    ) -> ProviderReply:
        del tools
        text = f"Mock provider response for: {messages[-1].get('content', '')}"
        if on_text:
            on_text(text)
        return ProviderReply(text=text)


def redact(text: str) -> str:
    text = re.sub(r"sk-[A-Za-z0-9_-]{4}[A-Za-z0-9_-]+", "sk-****[REDACTED]", text)
    return re.sub(r"(?i)(api[_-]?key|token|password|secret)\s*[:=]\s*[^,\s}]+", r"\1=[REDACTED]", text)


class OpenAICompatibleProvider:
    def __init__(self, *, api_key: str, base_url: str, model: str, timeout: float = 90.0) -> None:
        if not api_key:
            raise ValueError("FORGE_API_KEY or OPENAI_API_KEY is required for the OpenAI-compatible provider")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    def complete(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        on_text: Callable[[str], None] | None = None,
    ) -> ProviderReply:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": 0,
            "stream": bool(on_text),
        }
        if tools:
            body["tools"] = tools
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                if on_text:
                    return self._read_stream(response, on_text)
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = redact(exc.read().decode("utf-8", errors="replace")[:1000])
            raise RuntimeError(f"Provider HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise RuntimeError(f"Provider request failed: {exc}") from exc
        return self._parse_payload(payload)

    def _read_stream(self, response: Any, on_text: Callable[[str], None]) -> ProviderReply:
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
                state = tool_fragments.setdefault(index, {"id": "", "name": "", "arguments": ""})
                state["id"] += str(call.get("id") or "")
                function = call.get("function") or {}
                state["name"] += str(function.get("name") or "")
                state["arguments"] += str(function.get("arguments") or "")
        return ProviderReply(text="".join(text_parts), tool_calls=self._parse_tool_fragments(tool_fragments), usage=usage)

    def _parse_payload(self, payload: dict[str, Any]) -> ProviderReply:
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
            calls.append(ToolCall(id=str(call.get("id", "")), name=str(function.get("name", "")), arguments=arguments))
        return ProviderReply(
            text=str(message.get("content") or ""),
            tool_calls=tuple(calls),
            usage=payload.get("usage") or {},
            raw_message=message,
        )

    @staticmethod
    def _parse_tool_fragments(fragments: dict[str, dict[str, Any]]) -> tuple[ToolCall, ...]:
        calls: list[ToolCall] = []
        for state in fragments.values():
            try:
                arguments = json.loads(state["arguments"] or "{}")
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"Provider returned invalid streamed tool arguments: {exc}") from exc
            if isinstance(arguments, dict):
                calls.append(ToolCall(id=state["id"], name=state["name"], arguments=arguments))
        return tuple(calls)


def build_provider() -> Provider:
    provider_name = os.environ.get("FORGE_PROVIDER", "mock").lower()
    if provider_name in {"mock", "test"}:
        return MockProvider()
    if provider_name in {"openai", "openai-compatible", "compatible", "xai"}:
        return OpenAICompatibleProvider(
            api_key=os.environ.get("FORGE_API_KEY") or os.environ.get("OPENAI_API_KEY", ""),
            base_url=os.environ.get("FORGE_BASE_URL", "https://api.openai.com/v1"),
            model=os.environ.get("FORGE_MODEL", "gpt-4.1-mini"),
        )
    raise ValueError(f"Unsupported FORGE_PROVIDER: {provider_name}")
