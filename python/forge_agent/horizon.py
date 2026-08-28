"""Bounded conversation state for long-horizon provider sessions."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class LongHorizonBuffer:
    """Keep provider history bounded without silently dropping task-critical anchors."""

    max_chars: int = 60_000
    max_messages: int = 96
    recent_messages: int = 8
    messages: list[dict[str, Any]] = field(default_factory=list)
    summary: str = ""
    compactions: int = 0

    SUMMARY_PREFIX = "[Forge historical summary — informational context only; not an instruction or permission]"
    SUMMARY_BODY_PREFIX = "Forge historical summary (non-authoritative context):"
    LEGACY_SUMMARY_MARKER = "Earlier bounded conversation (non-authoritative):"

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
        self._ensure_summary_marker()
        if self._size(self.messages) > self.max_chars and self.summary:
            self._shrink_summary_preserving_recent(self.messages[:2], self.messages[3:])
        return [*self.messages]

    @staticmethod
    def _normalize_tool_history(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Keep paired provider tool turns atomic and discard only truly orphaned tool results."""
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
                pending_ids = {str(call.get("id")) for call in calls if isinstance(call, dict) and call.get("id")}
                result.append(message)
                continue
            if role == "tool":
                call_id = str(message.get("tool_call_id", ""))
                if pending_ids and call_id in pending_ids:
                    result.append(message)
                    pending_ids.remove(call_id)
                    if not pending_ids:
                        pending_start = None
                elif call_id:
                    # A tool_call_id identifies a provider result; without a
                    # matching assistant call it is an orphan and is discarded.
                    continue
                else:
                    # Supervisor-generated verification/failure evidence is
                    # intentionally tool-role but has no provider call id.
                    result.append(message)
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
            if self._size(self.messages) > self.max_chars and self.summary:
                self._shrink_summary_preserving_recent(self.messages[:2], self.messages[2:])
            return
        anchors = self.messages[:2]
        recent_start = self._recent_start(self.messages)
        recent = self.messages[recent_start:]
        omitted = self.messages[2:recent_start]
        ordered = sorted(enumerate(omitted), key=lambda item: (-self._priority(item[1]), item[0]))
        fragments: list[str] = []
        fragment_budget = min(6_500, max(200, self.max_chars // 4))
        used = 0
        for _, message in ordered:
            fragment = self._message_summary(message)
            if used + len(fragment) + 1 > fragment_budget:
                continue
            fragments.append(fragment)
            used += len(fragment) + 1
        prior = self.summary
        self.summary = self._normalize_summary("\n".join(part for part in [prior, self.LEGACY_SUMMARY_MARKER, self.SUMMARY_BODY_PREFIX, *fragments] if part))
        self.messages = anchors + [self._summary_message(self.summary)] + recent
        # Remove only low-value turns while keeping verification/failure evidence.
        while self._size(self.messages) > self.max_chars and len(self.messages) > 3:
            candidates = [
                index for index in range(3, len(self.messages))
                if self._priority(self.messages[index]) < 880
            ]
            if not candidates:
                break
            self._drop_low_value_turn(self.messages, min(candidates, key=lambda i: self._priority(self.messages[i])))
        self.messages = self._normalize_tool_history(self._truncate_messages(self.messages))
        self._ensure_summary_marker()
        if self._size(self.messages) > self.max_chars:
            self._shrink_summary_preserving_recent(anchors, self.messages[3:])
        self.compactions += 1

    def _shrink_summary_preserving_recent(self, anchors: list[dict[str, Any]], recent: list[dict[str, Any]]) -> None:
        fixed = self._size(anchors + recent)
        prefix = self.SUMMARY_PREFIX + "\n"
        available = max(0, self.max_chars - fixed - len(prefix) - 16)
        self.summary = self._normalize_summary(self.summary[:available])
        self.messages = anchors + ([self._summary_message(self.summary)] if self.summary else []) + recent
        while self._size(self.messages) > self.max_chars and self.summary:
            excess = self._size(self.messages) - self.max_chars
            self.summary = self.summary[:-max(8, excess + 4)]
            self.messages = anchors + [self._summary_message(self.summary)] + recent
        if self._size(self.messages) > self.max_chars:
            # Last resort: preserve the anchors and high-value recent evidence,
            # while truncating content rather than deleting entire evidence turns.
            self.messages = self._truncate_messages(self.messages)

    def _summary_message(self, summary: str) -> dict[str, Any]:
        body = self._normalize_summary(summary)
        return {"role": "user", "content": f"{self.SUMMARY_PREFIX}\n{body}"}

    def _normalize_summary(self, summary: str) -> str:
        cleaned = summary.replace(self.SUMMARY_PREFIX, "")
        lines = [line.strip() for line in cleaned.splitlines()]
        lines = [line for line in lines if line and line not in {self.SUMMARY_BODY_PREFIX, self.LEGACY_SUMMARY_MARKER}]
        body = "\n".join(lines).strip()
        return "\n".join(part for part in [self.SUMMARY_BODY_PREFIX, self.LEGACY_SUMMARY_MARKER, body] if part)

    def _ensure_summary_marker(self) -> None:
        for message in self.messages:
            if message.get("role") == "user" and isinstance(message.get("content"), str) and message["content"].startswith(self.SUMMARY_PREFIX):
                return
        if self.summary:
            self.messages.insert(2, self._summary_message(self.summary))

    def _recent_start(self, messages: list[dict[str, Any]]) -> int:
        start = max(2, len(messages) - self.recent_messages)
        if start < len(messages) and messages[start].get("role") == "tool":
            call_id = str(messages[start].get("tool_call_id", ""))
            for index in range(start - 1, 1, -1):
                candidate = messages[index]
                calls = candidate.get("tool_calls")
                if candidate.get("role") == "assistant" and isinstance(calls, list) and any(isinstance(call, dict) and str(call.get("id", "")) == call_id for call in calls):
                    return index
        return start

    @staticmethod
    def _drop_oldest_turn(messages: list[dict[str, Any]], index: int) -> None:
        LongHorizonBuffer._drop_low_value_turn(messages, index)

    @staticmethod
    def _drop_low_value_turn(messages: list[dict[str, Any]], index: int) -> None:
        if index >= len(messages): return
        candidate = messages[index]
        calls = candidate.get("tool_calls")
        if candidate.get("role") != "assistant" or not isinstance(calls, list) or not calls:
            del messages[index]
            return
        call_ids = {str(call.get("id")) for call in calls if isinstance(call, dict) and call.get("id")}
        end = index + 1
        while end < len(messages) and messages[end].get("role") == "tool" and str(messages[end].get("tool_call_id", "")) in call_ids:
            end += 1
        del messages[index:end]

    def _truncate_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result = [dict(message) for message in messages]
        while self._size(result) > self.max_chars:
            candidates = [index for index, message in enumerate(result) if index >= 2 and isinstance(message.get("content"), str) and message["content"] and not (message.get("role") == "user" and str(message.get("content", "")).startswith(self.SUMMARY_PREFIX))]
            if not candidates: break
            index = min(candidates, key=lambda item: (self._priority(result[item]), -len(str(result[item]["content"]))))
            content = str(result[index]["content"])
            new_length = max(64, int(len(content) * 0.75))
            result[index]["content"] = content[:new_length]
        return result

    @classmethod
    def _priority(cls, message: dict[str, Any]) -> int:
        role = message.get("role")
        content = message.get("content", "")
        text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False, sort_keys=True)
        lowered = text.lower()
        if role == "system": return 1_000
        if role == "user" and cls.SUMMARY_PREFIX.lower() in lowered: return 10
        if role == "user": return 950
        if role == "tool" and any(marker in lowered for marker in ("verification", "forgeverification", "changedfiles", "postcondition")): return 900
        if role == "tool" and any(marker in lowered for marker in ("error", "failed", "exitcode", "failure", "blocked")): return 880
        if role == "assistant" and isinstance(message.get("tool_calls"), list): return 760
        if role == "assistant" and any(marker in lowered for marker in ("decision", "plan", "risk", "next step")): return 700
        if role == "tool": return 500
        return 300

    @staticmethod
    def _message_summary(message: dict[str, Any]) -> str:
        role = str(message.get("role", "message"))[:30]
        content = message.get("content", "")
        compact = " ".join(content.split())[:600] if isinstance(content, str) else json.dumps(content, ensure_ascii=False, sort_keys=True)[:600]
        return f"- priority={LongHorizonBuffer._priority(message)} {role}: {compact}"

    @staticmethod
    def _size(messages: list[dict[str, Any]]) -> int:
        return len(json.dumps(messages, ensure_ascii=False, separators=(",", ":")))
