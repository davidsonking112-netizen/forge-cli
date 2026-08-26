"""Bounded conversation state for long-horizon provider sessions."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class LongHorizonBuffer:
    """Keep provider history bounded without silently dropping task anchors."""

    max_chars: int = 60_000
    max_messages: int = 96
    recent_messages: int = 8
    messages: list[dict[str, Any]] = field(default_factory=list)
    summary: str = ""
    compactions: int = 0

    def append(self, message: dict[str, Any]) -> None:
        self.messages.append(message)
        if len(self.messages) > self.max_messages or self._size(self.messages) > self.max_chars:
            self._compact()

    def snapshot(self) -> list[dict[str, Any]]:
        if len(self.messages) > self.max_messages or self._size(self.messages) > self.max_chars:
            self._compact()
        return [*self.messages]

    def _compact(self) -> None:
        if len(self.messages) <= 3:
            self.messages = self._truncate_messages(self.messages[: self.max_messages])
            return
        anchors = self.messages[:2]
        recent = self.messages[-self.recent_messages :]
        omitted = self.messages[2 : -self.recent_messages]
        fragments = [self._message_summary(item) for item in omitted]
        prior = self.summary
        self.summary = "\n".join(
            part for part in [prior, "Earlier bounded conversation:", *fragments] if part
        )[-8_000:]
        summary_message = {
            "role": "system",
            "content": self.summary,
        }
        self.messages = anchors + [summary_message] + recent
        while self._size(self.messages) > self.max_chars and len(self.messages) > 3:
            self.messages.pop(3)
        if self._size(self.messages) > self.max_chars:
            fixed = self.messages[:2]
            low, high, best = 0, len(self.summary), ""
            while low <= high:
                midpoint = (low + high) // 2
                candidate = self.summary[-midpoint:] if midpoint else ""
                trial = fixed + [{"role": "system", "content": candidate}]
                if self._size(trial) <= self.max_chars:
                    best = candidate
                    low = midpoint + 1
                else:
                    high = midpoint - 1
            self.summary = best
            self.messages = fixed + [{"role": "system", "content": best}]
        self.messages = self._truncate_messages(self.messages)
        self.compactions += 1

    def _truncate_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result = [dict(message) for message in messages]
        while self._size(result) > self.max_chars:
            candidates = [
                index
                for index, message in enumerate(result)
                if isinstance(message.get("content"), str) and message["content"]
            ]
            if not candidates:
                break
            index = max(candidates, key=lambda item: len(str(result[item]["content"])))
            content = str(result[index]["content"])
            result[index]["content"] = content[: max(0, int(len(content) * 0.75))]
        return result

    @staticmethod
    def _message_summary(message: dict[str, Any]) -> str:
        role = str(message.get("role", "message"))[:30]
        content = message.get("content", "")
        if isinstance(content, str):
            compact = " ".join(content.split())[:600]
        else:
            compact = json.dumps(content, ensure_ascii=False, sort_keys=True)[:600]
        return f"- {role}: {compact}"

    @staticmethod
    def _size(messages: list[dict[str, Any]]) -> int:
        return len(json.dumps(messages, ensure_ascii=False, separators=(",", ":")))
