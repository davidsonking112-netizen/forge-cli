"""Provider boundary for Forge.

The mock provider is the default for deterministic development. The optional
OpenAI-compatible adapter is deliberately small and does not persist keys.
"""
from __future__ import annotations

import json
import os
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class ProviderReply:
    text: str
    raw: dict[str, Any] | None = None


class Provider(Protocol):
    def complete(self, *, system: str, prompt: str) -> ProviderReply:
        """Return a provider response for a text-only turn."""


class MockProvider:
    def complete(self, *, system: str, prompt: str) -> ProviderReply:
        del system
        return ProviderReply(text=f"Mock provider response for: {prompt}")


class OpenAICompatibleProvider:
    def __init__(self, *, api_key: str, base_url: str, model: str, timeout: float = 60.0) -> None:
        if not api_key:
            raise ValueError("FORGE_API_KEY or OPENAI_API_KEY is required for the OpenAI-compatible provider")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    def complete(self, *, system: str, prompt: str) -> ProviderReply:
        body = json.dumps(
            {
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0,
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=body,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            raise RuntimeError(f"Provider request failed: {exc}") from exc
        try:
            content = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError("Provider response did not contain assistant content") from exc
        return ProviderReply(text=str(content or ""), raw=payload)


def build_provider() -> Provider:
    provider_name = os.environ.get("FORGE_PROVIDER", "mock").lower()
    if provider_name in {"mock", "test"}:
        return MockProvider()
    if provider_name in {"openai", "openai-compatible", "compatible"}:
        return OpenAICompatibleProvider(
            api_key=os.environ.get("FORGE_API_KEY") or os.environ.get("OPENAI_API_KEY", ""),
            base_url=os.environ.get("FORGE_BASE_URL", "https://api.openai.com/v1"),
            model=os.environ.get("FORGE_MODEL", "gpt-4.1-mini"),
        )
    raise ValueError(f"Unsupported FORGE_PROVIDER: {provider_name}")
