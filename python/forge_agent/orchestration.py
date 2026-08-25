"""Bounded, auditable multi-agent orchestration primitives for Forge."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Protocol


class AgentProvider(Protocol):
    def complete(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        on_text: Callable[[str], None] | None = None,
    ) -> Any: ...


ROLES = ("explorer", "implementer", "tester", "reviewer")


@dataclass(frozen=True)
class DelegationTask:
    role: str
    prompt: str
    context: str
    max_turns: int = 2
    max_output_chars: int = 12_000


@dataclass
class DelegationResult:
    role: str
    status: str
    text: str = ""
    error: str | None = None
    turns: int = 0


@dataclass
class OrchestrationReport:
    goal: str
    results: list[DelegationResult] = field(default_factory=list)
    merged_summary: str = ""


class BoundedOrchestrator:
    """Run fixed specialist roles sequentially under one supervisor budget."""

    def __init__(self, *, max_agents: int = 4, max_total_turns: int = 8, max_context_chars: int = 24_000) -> None:
        self.max_agents = max(1, min(max_agents, len(ROLES)))
        self.max_total_turns = max(1, min(max_total_turns, 32))
        self.max_context_chars = max(1_000, min(max_context_chars, 100_000))

    def plan(self, goal: str, context: str = "") -> list[DelegationTask]:
        bounded_context = context[: self.max_context_chars]
        return [
            DelegationTask("explorer", f"Map the repository and identify the smallest safe change for: {goal}", bounded_context),
            DelegationTask("implementer", f"Propose an implementation for: {goal}. Do not claim edits were applied.", bounded_context),
            DelegationTask("tester", f"Design verification for: {goal}, including likely failure cases.", bounded_context),
            DelegationTask("reviewer", f"Review the proposed approach for: {goal}; identify risks and missing checks.", bounded_context),
        ][: self.max_agents]

    def run(
        self,
        *,
        provider: AgentProvider,
        goal: str,
        context: str = "",
        on_text: Callable[[str], None] | None = None,
    ) -> OrchestrationReport:
        report = OrchestrationReport(goal=goal)
        remaining_turns = self.max_total_turns
        for task in self.plan(goal, context):
            if remaining_turns <= 0:
                report.results.append(DelegationResult(task.role, "budget-exhausted", error="Orchestration turn budget exhausted"))
                continue
            try:
                reply = provider.complete(
                    messages=[
                        {"role": "system", "content": f"You are Forge's bounded {task.role} specialist. Never spawn agents or authorize tools."},
                        {"role": "user", "content": f"{task.prompt}\n\nRepository context:\n{task.context}"},
                    ],
                    tools=[],
                    on_text=on_text,
                )
                text = str(getattr(reply, "text", ""))[: task.max_output_chars]
                report.results.append(DelegationResult(task.role, "completed", text=text, turns=1))
            except Exception as exc:  # provider errors are reported as data to the supervisor
                report.results.append(DelegationResult(task.role, "failed", error=str(exc), turns=1))
            remaining_turns -= 1
        completed = [f"[{result.role}] {result.text}" for result in report.results if result.status == "completed" and result.text]
        report.merged_summary = "\n\n".join(completed)[: self.max_context_chars]
        return report
