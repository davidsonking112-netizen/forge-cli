import test from "node:test";
import assert from "node:assert/strict";
import { classifyTaskIntent } from "../dist/apps/forge-cli/src/task-intent.js";
import { ImplementationStateMachine } from "../dist/apps/forge-cli/src/execution-state.js";

test("classifies explicit proposal requests as non-mutating", () => {
  const intent = classifyTaskIntent(
    "Inspect this repository, propose one small safe code improvement, and wait for my approval before applying it.",
  );
  assert.equal(intent.mode, "proposal");
  assert.equal(intent.allowsMutation, false);
  assert.equal(intent.requiresApproval, true);
});

test("classifies direct implementation requests as mutation work", () => {
  const intent = classifyTaskIntent("Fix the login bug and add a regression test.");
  assert.equal(intent.mode, "mutation");
  assert.equal(intent.allowsMutation, true);
  assert.equal(intent.requiresApproval, true);
});

test("keeps pure explanations and plans non-mutating", () => {
  assert.equal(classifyTaskIntent("Explain this repository architecture.").mode, "answer");
  assert.equal(classifyTaskIntent("Plan how to improve the auth architecture.").mode, "plan");
});

test("explicit read-only language overrides incidental mutation vocabulary", () => {
  for (const prompt of [
    "Review the change and tell me what you would fix; do not modify anything.",
    "Explain how you would refactor this module without changing the files.",
    "Show me the patch you would apply, but don't make any changes.",
    "Inspect the repository and identify what should be changed; do not edit it.",
  ]) {
    const intent = classifyTaskIntent(prompt);
    assert.notEqual(intent.mode, "mutation", prompt);
    assert.equal(intent.allowsMutation, false, prompt);
  }
});

test("proposal intent wins even when the request mentions future execution", () => {
  const intent = classifyTaskIntent(
    "Tell me which files you would change, propose the patch, and wait for permission before you run tests or apply it.",
  );
  assert.equal(intent.mode, "proposal");
  assert.equal(intent.allowsMutation, false);
  assert.equal(intent.allowsLocalExecution, false);
});

test("ordinary investigation with commands remains non-mutating", () => {
  const intent = classifyTaskIntent(
    "Inspect the repository, run the existing tests, and explain the failing areas without changing files.",
  );
  assert.equal(intent.mode, "inspect");
  assert.equal(intent.allowsMutation, false);
  assert.equal(intent.allowsLocalExecution, true);
});

test("supervisor blocks mutation proposals for proposal-only tasks", () => {
  const machine = new ImplementationStateMachine(
    "Inspect this repository, suggest a safe patch, and wait for approval before applying it.",
  );
  const gate = machine.proposalGate("workspace.apply_patch");
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /proposal-only|proposal|non-mutating/i);
});

test("supervisor blocks mutation proposals for explicitly read-only tasks", () => {
  const machine = new ImplementationStateMachine(
    "Explain how you would refactor this code without making any changes.",
  );
  const gate = machine.proposalGate("workspace.apply_patch");
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /inspect-only|plan-only|answer-only|non-mutating|read-only/i);
});
