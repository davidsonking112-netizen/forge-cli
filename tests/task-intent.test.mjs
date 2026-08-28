import test from "node:test";
import assert from "node:assert/strict";
import { classifyTaskIntent } from "../dist/apps/forge-cli/src/task-intent.js";
import { ImplementationStateMachine } from "../dist/apps/forge-cli/src/execution-state.js";

const cases = [
  ["Inspect this repo and propose a safe patch, but wait for my approval.", "proposal", false],
  ["Suggest the changes and do not edit anything yet.", "proposal", false],
  ["Show me what you would change without making changes.", "proposal", false],
  ["Explain the architecture; don't modify files.", "inspect", false],
  ["Review the auth refactor but do not apply it.", "inspect", false],
  ["Plan how to refactor the auth module.", "plan", false],
  ["Design an approach for improving the caching layer.", "plan", false],
  ["Please fix the login bug and add a regression test.", "mutation", true],
  ["Go ahead and implement the settings page.", "mutation", true],
  ["Create the missing config file and run its tests.", "mutation", true],
  ["Run the tests and tell me what failed.", "inspect", false],
  ["Analyze why the build fails.", "inspect", false],
  ["Tell me what this code does.", "inspect", false],
  ["Refactor the code.", "mutation", true],
  ["Change the API only after I approve the patch.", "proposal", false],
  ["Don't change anything; just find the bug.", "inspect", false],
  ["What would you change to fix this?", "proposal", false],
  ["Show the diff before applying it.", "proposal", false],
  ["Explain how we should refactor it, then stop.", "plan", false],
  ["Audit the workspace and execute no commands.", "inspect", false],
];

test("canonical task intent follows explicit precedence across adversarial prompts", () => {
  for (const [prompt, mode, allowsMutation] of cases) {
    const intent = classifyTaskIntent(prompt);
    assert.equal(intent.mode, mode, prompt);
    assert.equal(intent.allowsMutation, allowsMutation, prompt);
    assert.ok(intent.signals.length > 0, prompt);
  }
});

test("explicit restrictions override incidental mutation vocabulary", () => {
  const prompts = [
    "Review the planned refactor without changing files.",
    "Explain how to modify the config but don't modify it.",
    "Find the fix for the bug without applying the fix.",
    "Show me the change you would make; do not edit anything.",
  ];
  for (const prompt of prompts) {
    const intent = classifyTaskIntent(prompt);
    assert.equal(intent.allowsMutation, false, prompt);
    assert.notEqual(intent.mode, "mutation", prompt);
  }
});

test("execution is not mutation authority", () => {
  const intent = classifyTaskIntent("Run the tests and explain the failures.");
  assert.equal(intent.mode, "inspect");
  assert.equal(intent.allowsMutation, false);
  assert.equal(intent.allowsLocalExecution, true);
});

test("supervisor blocks mutation proposals for proposal-only tasks", () => {
  const prompt = "Inspect this repository, suggest a safe patch, and wait for approval before applying it.";
  const intent = classifyTaskIntent(prompt);
  const machine = new ImplementationStateMachine(prompt);
  assert.equal(intent.mode, "proposal");
  assert.equal(machine.proposalGate("workspace.apply_patch").ok, false);
  assert.match(machine.proposalGate("workspace.apply_patch").reason, /proposal-only|proposal|non-mutating/i);
});
