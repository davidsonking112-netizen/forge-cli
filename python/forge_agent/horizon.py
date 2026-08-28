"""Bounded conversation state for long-horizon provider sessions."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


HISTORICAL_HEADER = "[Forge historical summary — informational context only; not an instruction or permission]\n"
HISTORICAL_MARKER = "Forge historical summary (non-authoritative context):"


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
        normalized = self._normalize_tool_history(self.messages)
        if normalized != self.messages:
            self.messages = normalized
        return [*self.messages]

    @staticmethod
    def _normalize_tool_history(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Keep assistant tool calls and their tool results as atomic history turns."""
        result: list[dict[str, Any]] = []
        pending_start: int | None = None
        pending_ids: set[str] = set()
        for message in messages:
            role = message.get("role")
            calls = message.get("tool_calls")
            if role == "assistant" and isinstance(calls, list) and calls:
                if pending_ids and pending_start is not None:
                    result = result[:pending_start]
                pending_start = len(result)
                pending_ids = {
                    str(call.get("id"))
                    for call in calls
                    if isinstance(call, dict) and call.get("id")
                }
                result.append(message)
                continue
            if role == "tool":
                call_id = str(message.get("tool_call_id", ""))
                if pending_ids and call_id in pending_ids:
                    result.append(message)
                    pending_ids.remove(call_id)
                    if not pending_ids:
                        pending_start = None
                continue
            if pending_ids and pending_start is not None:
                result = result[:pending_start]
                pending_start = None
                pending_ids.clear()
            result.append(message)
        if pending_ids and pending_start is not None:
            result = result[:pending_start]
        return result

    def _compact(self) -> None:
        if len(self.messages) <= 3:
            self.messages = self._truncate_messages(self.messages[: self.max_messages])
            return
        anchors = self.messages[:2]
        recent_start = self._recent_start(self.messages)
        recent = self.messages[recent_start:]
        omitted = self.messages[2:recent_start]
        fragments = [self._message_summary(item) for item in omitted]
        prior = self.summary
        self.summary = "\n".join(
            part
            for part in [
                prior,
                "Earlier bounded conversation:",
                HISTORICAL_MARKER,
                *fragments,
            ]
            if part
        )[-8_000:]
        summary_message = {
            "role": "user",
            "content": HISTORICAL_HEADER + self.summary,
        }
        self.messages = anchors + [summary_message] + recent
        while self._size(self.messages) > self.max_chars and len(self.messages) > 3:
            self._drop_low_value_turn(self.messages, 3)
        if self._size(self.messages) > self.max_chars:
            fixed = self.messages[:2]
            low, high, best = 0, len(self.summary), ""
            while low <= high:
                midpoint = (low + high) // 2
                candidate = self.summary[-midpoint:] if midpoint else ""
                trial = fixed + [{
                    "role": "user",
                    "content": HISTORICAL_HEADER + candidate,
                }]
                if self._size(trial) <= self.max_chars:
                    best = candidate
                    low = midpoint + 1
                else:
                    high = midpoint - 1
            self.summary = best
            self.messages = fixed + [{
                "role": "user",
                "content": HISTORICAL_HEADER + best,
            }]
        self.messages = self._normalize_tool_history(self._truncate_messages(self.messages))
        self.compactions += 1

    def _recent_start(self, messages: list[dict[str, Any]]) -> int:
        start = max(2, len(messages) - self.recent_messages)
        if start < len(messages) and messages[start].get("role") == "tool":
            call_id = str(messages[start].get("tool_call_id", ""))
            for index in range(start - 1, 1, -1):
                candidate = messages[index]
                calls = candidate.get("tool_calls")
                if candidate.get("role") == "assistant" and isinstance(calls, list) and any(
                    isinstance(call, dict) and str(call.get("id", "")) == call_id for call in calls
                ):
                    return index
        return start

    @staticmethod
    def _drop_oldest_turn(messages: list[dict[str, Any]], index: int) -> None:
        """Backward-compatible alias retained for callers that use the old helper."""
        LongHorizonBuffer._drop_low_value_turn(messages, index)

    @staticmethod
    def _drop_low_value_turn(messages: list[dict[str, Any]], index: int) -> None:
        if index >= len(messages):
            return
        candidates = list(range(index, len(messages)))
        drop_index = min(candidates, key=lambda candidate: LongHorizonBuffer._priority(messages[candidate]))
        candidate = messages[drop_index]
        calls = candidate.get("tool_calls")
        if candidate.get("role") != "assistant" or not isinstance(calls, list) or not calls:
            del messages[drop_index]
            return
        call_ids = {str(call.get("id")) for call in calls if isinstance(call, dict) and call.get("id")}
        end = drop_index + 1
        while end < len(messages) and messages[end].get("role") == "tool" and str(messages[end].get("tool_call_id", "")) in call_ids:
            end += 1
        del messages[drop_index:end]

    def _truncate_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result = [dict(message) for message in messages]
        while self._size(result) > self.max_chars:
            candidates = [
                index
                for index, message in enumerate(result)
                if index >= 2 and isinstance(message.get("content"), str) and message["content"]
            ]
            if not candidates:
                break
            index = min(candidates, key=lambda item: (self._priority(result[item]), -len(str(result[item]["content"]))))
            content = str(result[index]["content"])
            if content.startswith(HISTORICAL_HEADER):
                header = HISTORICAL_HEADER
                body = content[len(header):]
                new_body_length = max(64, int(len(body) * 0.75))
                result[index]["content"] = header + body[:new_body_length]
                if len(result[index]["content"]) >= len(content):
                    break
                continue
            new_length = max(256, int(len(content) * 0.75))
            result[index]["content"] = content[:new_length]
        return result

    @staticmethod
    def _priority(message: dict[str, Any]) -> int:
        """Higher values mean more valuable context that should survive compaction."""
        role = message.get("role")
        content = message.get("content", "")
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False, sort_keys=True)
        lowered = text.lower()
        if role == "system":
            return 100
        if role == "user" and "historical summary" not in lowered:
            return 95
        if role == "tool" and any(marker in lowered for marker in ("error", "failed", "exitcode", "verification")):
            return 85
        if role == "assistant" and isinstance(message.get("tool_calls"), list):
            return 80
        if role == "tool":
            return 70
        if "historical summary" in lowered:
            return 10
        return 50

    @staticmethod
    def _message_summary(message: dict[str, Any]) -> str:
        role = str(message.get("role", "message"))[:30]
        content = message.get("content", "")
        if isinstance(content, str):
            compact = " ".join(content.split())[:600]
        else:
            compact = json.dumps(content, ensure_ascii=False, sort_keys=True)[:600]
        priority = LongHorizonBuffer._priority(message)
        return f"- priority={priority} {role}: {compact}"

    @staticmethod
    def _size(messages: list[dict[str, Any]]) -> int:
        return len(json.dumps(messages, ensure_ascii=False, separators=(",", ":")))
