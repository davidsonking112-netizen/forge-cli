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
  assert.equal(classifyTaskIntent("Plan how to refactor the auth module.").mode, "plan");
});

test("supervisor blocks mutation proposals for proposal-only tasks", () => {
  const machine = new ImplementationStateMachine(
    "Inspect this repository, suggest a safe patch, and wait for approval before applying it.",
  );
  const gate = machine.proposalGate("workspace.apply_patch");
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /proposal-only|proposal|non-mutating/i);
});
