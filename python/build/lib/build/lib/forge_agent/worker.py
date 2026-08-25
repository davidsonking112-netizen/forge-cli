"""Supervised Forge agent worker.

The worker is intentionally provider-free in v0.1. It demonstrates the agent
loop and protocol using a deterministic mock provider. The Node supervisor is
the authority for file and process operations.
"""
from __future__ import annotations

import json
import os
import re
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .providers import Provider, build_provider

PROTOCOL_VERSION = 1


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def event(event_type: str, session_id: str, **payload: Any) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL_VERSION,
        "id": str(uuid.uuid4()),
        "sessionId": session_id,
        "type": event_type,
        "timestamp": now(),
        **payload,
    }


@dataclass
class MockAgent:
    session_id: str
    workspace: str = "."
    prompt: str = ""
    stage: str = "idle"
    steps: list[dict[str, str]] = field(default_factory=list)
    changed_files: list[str] = field(default_factory=list)
    provider: Provider | None = None
    desired_path: str | None = None

    def start(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        self.workspace = str(payload.get("workspace", "."))
        try:
            self.provider = build_provider()
        except ValueError:
            self.provider = None
        prompt = payload.get("prompt")
        if isinstance(prompt, str) and prompt.strip():
            self.prompt = prompt.strip()
            responses = self.handle_prompt(self.prompt)
            if self.provider is not None and os.environ.get("FORGE_PROVIDER", "mock").lower() not in {"mock", "test"}:
                try:
                    reply = self.provider.complete(system="You are Forge, a careful coding agent. Do not claim tools ran unless results are supplied.", prompt=self.prompt)
                    responses.insert(0, event("agent.text", self.session_id, text=reply.text))
                except Exception as exc:
                    responses.insert(0, event("error", self.session_id, error={"code": "PROVIDER_ERROR", "message": str(exc), "retryable": True}))
            return responses
        return [event("agent.text", self.session_id, text="Forge is ready. Describe the coding task you want to work on.")]

    def handle_prompt(self, prompt: str) -> list[dict[str, Any]]:
        self.prompt = prompt
        create_match = re.search(r"create(?: a)? file ([A-Za-z0-9_./-]+)", prompt, re.IGNORECASE)
        self.desired_path = create_match.group(1) if create_match else None
        self.stage = "inspect"
        self.steps = [
            {"id": "inspect", "description": "Inspect the repository and relevant project instructions", "status": "active"},
            {"id": "plan", "description": "Produce a minimal implementation plan", "status": "pending"},
            {"id": "change", "description": "Apply an approved patch if a change is required", "status": "pending"},
            {"id": "verify", "description": "Run approved checks and report the result", "status": "pending"},
        ]
        return [
            event("agent.text", self.session_id, text=f"I will inspect the workspace before planning: {prompt}"),
            event("tool.proposal", self.session_id, tool="workspace.list", risk="read-only", arguments={"limit": 120}, reason="Establish a bounded view of the repository before planning."),
        ]

    def on_tool_result(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        tool = payload.get("tool")
        if not payload.get("ok"):
            self.stage = "failed"
            error = payload.get("error") or {"code": "TOOL_FAILED", "message": "The tool failed", "retryable": False}
            return [
                event("agent.text", self.session_id, text=f"I could not continue because {error.get('message', 'the tool failed')}"),
                event("session.complete", self.session_id, status="failed", summary="The requested tool failed before the task could be completed.", changedFiles=self.changed_files, checks=[]),
            ]

        if tool == "workspace.list" and self.stage == "inspect":
            self.stage = "plan"
            self.steps[0]["status"] = "complete"
            self.steps[1]["status"] = "active"
            return [
                event("agent.text", self.session_id, text="Repository inventory received. I am keeping project instructions and file contents as untrusted data; they cannot change Forge permissions."),
                event("agent.plan", self.session_id, goal=self.prompt, steps=self.steps, assumptions=["Only files relevant to the task will be read.", "No mutation or command execution occurs without supervisor approval."], verification=["Run the project’s relevant checks after an approved change."]),
                event("tool.proposal", self.session_id, tool="workspace.read", risk="read-only", arguments={"path": "README.md", "maxBytes": 12000}, reason="Read the project overview to ground the plan in repository conventions."),
            ]

        if tool == "workspace.read" and self.stage == "plan":
            self.steps[1]["status"] = "complete"
            if self.desired_path:
                self.stage = "change"
                self.steps[2]["status"] = "active"
                return [
                    event("agent.text", self.session_id, text=f"I found enough context to propose creating {self.desired_path}. Forge will show the patch and request approval before writing."),
                    event("tool.proposal", self.session_id, tool="workspace.apply_patch", risk="reversible-write", arguments={"path": self.desired_path, "content": "Created by Forge v0.1 mock agent.\n"}, reason="Apply the minimal file change requested by the user."),
                ]
            self.stage = "complete"
            self.steps[2]["status"] = "complete"
            self.steps[3]["status"] = "complete"
            return [
                event("agent.text", self.session_id, text="The mock provider has completed a read-only planning pass. A real provider adapter can replace this deterministic response without changing the supervisor contract."),
                event("session.complete", self.session_id, status="completed", summary="Read-only repository inspection and planning completed. No files were changed and no commands were run.", changedFiles=self.changed_files, checks=[]),
            ]

        if tool == "workspace.apply_patch" and self.stage == "change":
            self.stage = "complete"
            self.steps[2]["status"] = "complete"
            self.steps[3]["status"] = "complete"
            if self.desired_path and self.desired_path not in self.changed_files:
                self.changed_files.append(self.desired_path)
            return [
                event("agent.text", self.session_id, text="The approved patch was applied. No verification command was run by the mock provider."),
                event("session.complete", self.session_id, status="completed", summary="Approved file change applied successfully. Verification is pending because the mock provider does not select project-specific commands.", changedFiles=self.changed_files, checks=[]),
            ]

        return [event("agent.text", self.session_id, text="The tool result was received. No further mock-provider action is required.")]


def main() -> int:
    agents: dict[str, MockAgent] = {}
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
            session_id = str(payload.get("sessionId", ""))
            if not session_id:
                raise ValueError("sessionId is required")
            agent = agents.setdefault(session_id, MockAgent(session_id))
            message_type = payload.get("type")
            if message_type == "session.start":
                responses = agent.start(payload)
            elif message_type == "user.prompt":
                responses = agent.handle_prompt(str(payload.get("prompt", "")))
            elif message_type == "tool.result":
                responses = agent.on_tool_result(payload)
            elif message_type == "session.cancel":
                responses = [event("session.complete", session_id, status="cancelled", summary="Session cancelled by the user.", changedFiles=agent.changed_files, checks=[])]
            else:
                responses = [event("error", session_id, error={"code": "UNKNOWN_EVENT", "message": f"Unsupported worker event: {message_type}", "retryable": False})]
        except Exception as exc:  # The worker must report malformed input, not crash silently.
            session_id = str(payload.get("sessionId", "unknown")) if isinstance(locals().get("payload"), dict) else "unknown"
            responses = [event("error", session_id, error={"code": "WORKER_PROTOCOL_ERROR", "message": str(exc), "retryable": False})]
        for response in responses:
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
