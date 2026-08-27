import assert from "node:assert/strict";
import test from "node:test";
import { ImplementationStateMachine } from "../dist/apps/forge-cli/src/execution-state.js";
import { createEnvelope } from "../dist/packages/protocol/src/index.js";

const sessionId = "state-test-session";

function planEvent() {
  return {
    ...createEnvelope("agent.plan", sessionId),
    type: "agent.plan",
    goal: "Create app.js",
    steps: [
      { id: "domain", description: "Create the domain file", status: "active" },
      { id: "verify", description: "Verify the change", status: "pending" },
    ],
    assumptions: [],
    verification: ["node --check app.js", "npm test"],
  };
}

function toolResult(tool, output, ok = true) {
  return {
    ...createEnvelope("tool.result", sessionId),
    type: "tool.result",
    tool,
    ok,
    output,
    approved: true,
    durationMs: 1,
  };
}

function completion(checks, changedFiles = ["app.js"]) {
  return {
    ...createEnvelope("session.complete", sessionId),
    type: "session.complete",
    status: "completed",
    summary: "done",
    changedFiles,
    checks,
  };
}

function check(command, ok = true, exitCode = ok ? 0 : 1) {
  return {
    command,
    ok,
    exitCode,
    output: ok ? "ok" : "failed",
    status: ok ? "passed" : "failed",
  };
}

test("state machine exposes every phase contract from intake through summarize", () => {
  const machine = new ImplementationStateMachine("Explain this repository");
  const [intake, inspect] = machine.initialSnapshots();
  assert.equal(intake.phase, "intake");
  assert.equal(inspect.phase, "inspect");
  for (const snapshot of [intake, inspect]) {
    assert.ok(snapshot.entryConditions.length > 0);
    assert.ok(snapshot.requiredArtifact);
    assert.ok(snapshot.exitCondition);
    assert.ok(snapshot.failureTransition);
    assert.ok(snapshot.budget.maxToolCalls > 0);
  }
});

test("mutation proposals are blocked until an execution plan artifact exists", () => {
  const machine = new ImplementationStateMachine("Create app.js");
  machine.initialSnapshots();
  const blocked = machine.proposalGate("workspace.apply_patch");
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /execution-plan/i);
});

test("mutation completion requires a patch plus distinct targeted and broad checks", () => {
  const machine = new ImplementationStateMachine("Create app.js");
  machine.initialSnapshots();
  machine.observe(planEvent());
  machine.observe(toolResult("workspace.apply_patch", { files: ["app.js"] }));
  machine.observe(
    toolResult("process.run", {
      command: "node --check app.js",
      exitCode: 0,
      output: "",
    }),
  );
  machine.observe(
    toolResult("process.run", {
      command: "npm test",
      exitCode: 0,
      output: "ok",
    }),
  );
  const gate = machine.completionGate(
    completion([check("node --check app.js"), check("npm test")]),
  );
  assert.equal(gate.ok, true);
  assert.equal(machine.current().phase, "full-verify");
});

test("supervisor-required milestone verification blocks completion until a typed check passes", () => {
  const machine = new ImplementationStateMachine("Create app.js");
  machine.initialSnapshots();
  machine.observe(planEvent());
  machine.observe(toolResult("workspace.apply_patch", { files: ["app.js"] }));
  machine.requireMilestoneVerification();
  const blocked = machine.completionGate(completion([check("npm test")]));
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /milestone verification/i);
  const verification = {
    ...toolResult("process.run", {
      command: "node --check app.js",
      exitCode: 0,
      output: "",
    }),
    milestoneId: "step-01-app",
    verificationKind: "syntax",
  };
  machine.recordMilestoneVerification(verification);
  machine.observe(
    toolResult("process.run", {
      command: "npm test",
      exitCode: 0,
      output: "ok",
    }),
  );
  const gate = machine.completionGate(
    completion([check("node --check app.js"), check("npm test")]),
  );
  assert.equal(gate.ok, true);
});

test("model text or a completion claim cannot satisfy mutation evidence gates", () => {
  const machine = new ImplementationStateMachine("Create app.js");
  machine.initialSnapshots();
  machine.observe(planEvent());
  const gate = machine.completionGate(completion([]));
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /successful approved change|verification/i);
});

test("failed verification explicitly routes the machine to repair", () => {
  const machine = new ImplementationStateMachine("Create app.js");
  machine.initialSnapshots();
  machine.observe(planEvent());
  machine.observe(toolResult("workspace.apply_patch", { files: ["app.js"] }));
  const snapshot = machine.observe(
    toolResult(
      "process.run",
      { command: "node --check app.js", exitCode: 1, output: "syntax error" },
      false,
    ),
  );
  assert.equal(snapshot?.phase, "repair");
  assert.equal(snapshot?.status, "active");
  assert.equal(
    machine.completionGate(completion([check("node --check app.js", false)]))
      .ok,
    false,
  );
});

test("read-only completion can pass with inspection evidence and no mutation", () => {
  const machine = new ImplementationStateMachine(
    "Explain this repository without modifying files",
  );
  machine.initialSnapshots();
  machine.observe(toolResult("workspace.list", { files: ["README.md"] }));
  machine.observe(planEvent());
  const gate = machine.completionGate(completion([], []));
  assert.equal(gate.ok, true);
});

test("bounded provider turn budget is represented in state telemetry", () => {
  const machine = new ImplementationStateMachine("Explain this repository", {
    maxProviderTurns: 2,
  });
  machine.recordProviderTurn();
  machine.recordProviderTurn();
  assert.equal(machine.current().budget.providerTurns, 2);
  assert.equal(machine.current().budget.maxProviderTurns, 2);
});
