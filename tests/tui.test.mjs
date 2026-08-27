import assert from "node:assert/strict";
import test from "node:test";

const { FullScreenTui } = await import("../dist/apps/forge-cli/src/tui.js");

class FakeInput {
  isTTY = true;
  rawModes = [];
  listeners = new Set();

  setRawMode(value) {
    this.rawModes.push(value);
  }

  resume() {}

  on(event, listener) {
    if (event === "data") this.listeners.add(listener);
  }

  off(event, listener) {
    if (event === "data") this.listeners.delete(listener);
  }

  emit(value) {
    for (const listener of this.listeners) listener(Buffer.from(value));
  }
}

class FakeOutput {
  columns = 100;
  rows = 32;
  writes = [];
  listeners = new Set();

  write(value) {
    this.writes.push(value);
  }

  on(event, listener) {
    if (event === "resize") this.listeners.add(listener);
  }

  off(event, listener) {
    if (event === "resize") this.listeners.delete(listener);
  }

  text() {
    return this.writes.join("");
  }
}

const base = {
  protocol: 1,
  sessionId: "session-tui-123456789",
  timestamp: "2026-08-27T12:00:00.000Z",
};

function event(type, fields = {}) {
  return { ...base, id: `${type}-1`, type, ...fields };
}

test("full-screen TUI renders live session state across tabs", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const tui = new FullScreenTui({ input, output });
  tui.start();
  tui.handle(
    event("session.start", {
      workspace: "/tmp/forge-workspace",
      policy: "safe",
      provider: "openai-compatible",
      profile: "balanced",
      capabilities: ["workspace.read"],
    }),
  );
  tui.handle(
    event("agent.checklist", {
      items: [
        {
          id: "inspect",
          label: "Inspect workspace",
          expectation: "Relevant files are understood",
          status: "complete",
        },
        {
          id: "verify",
          label: "Verify changes",
          expectation: "Tests pass",
          status: "active",
        },
      ],
    }),
  );
  tui.handle(
    event("agent.plan", {
      goal: "Improve the application safely",
      steps: [
        { id: "inspect", description: "Inspect files", status: "complete" },
        { id: "verify", description: "Run tests", status: "active" },
      ],
      assumptions: ["Local workspace only"],
      verification: ["npm test"],
    }),
  );
  tui.handle(
    event("agent.state", {
      phase: "targeted-verify",
      status: "active",
      stepIndex: 1,
      totalSteps: 2,
      artifact: "targeted-verification",
      artifactId: "targeted-verify-1",
      entryConditions: ["A mutation result succeeded."],
      requiredArtifact: "A targeted check with exit code 0",
      exitCondition: "The targeted check passes",
      failureTransition: "Enter repair",
      note: "Awaiting targeted verification",
      budget: {
        providerTurns: 2,
        maxProviderTurns: 64,
        toolCalls: 3,
        maxToolCalls: 128,
        repairAttempts: 0,
        maxRepairAttempts: 4,
      },
    }),
  );
  tui.handle(
    event("agent.graph", {
      version: 1,
      status: "in-progress",
      planArtifactId: "plan-1234567890abcdef",
      activeStepId: "step-01-domain-a1b2c3d4",
      steps: [
        {
          id: "step-01-domain-a1b2c3d4",
          sourceId: "proposal-1",
          index: 0,
          title: "Domain model",
          description: "Build the domain model",
          expectedFiles: ["domain.js"],
          dependencies: [],
          risks: ["schema drift"],
          tests: ["node --check domain.js"],
          postconditions: ["domain loads"],
          status: "active",
          contractValid: true,
          contractErrors: [],
        },
      ],
      note: "Domain step is active",
    }),
  );
  tui.handle(
    event("tool.proposal", {
      tool: "workspace.read",
      risk: "read-only",
      arguments: { path: "src/main.ts" },
      reason: "Inspect the entrypoint",
    }),
  );
  tui.handle(
    event("tool.result", {
      tool: "workspace.read",
      ok: true,
      approved: true,
      durationMs: 4,
    }),
  );
  tui.handle(
    event("session.complete", {
      status: "completed",
      summary: "Verification passed",
      changedFiles: [],
      checks: [
        {
          command: "npm test",
          ok: true,
          exitCode: 0,
          output: "ok",
        },
      ],
    }),
  );

  const overview = output.text();
  assert.match(overview, /FORGE CLI/);
  assert.match(overview, /CHECKLIST 1\/2/);
  assert.match(overview, /Verification passed/);
  assert.match(overview, /workspace\.read/);
  assert.match(overview, /Execution phase targeted-verify/);
  assert.match(overview, /Dependency graph 0\/1/);
  assert.match(overview, /Context retrieval/);

  input.emit("2");
  assert.match(output.text(), /Improve the application safely/);
  assert.match(output.text(), /npm test/);
  input.emit("4");
  assert.match(output.text(), /Verification/);
  assert.match(output.text(), /PASS/);
  assert.match(output.text(), /Enforced execution state/);
  assert.match(output.text(), /A targeted check with exit code 0/);
  assert.match(output.text(), /step-01-domain-a1b2c3d4/);
  assert.match(output.text(), /domain\.js/);
  tui.stop();
  assert.deepEqual(input.rawModes, [true, false]);
  assert.match(output.text(), /\x1b\[\?1049l/);
});

test("TUI suspends navigation during readline approval and cancels otherwise", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const commands = [];
  const tui = new FullScreenTui({
    input,
    output,
    onCommand: (command) => commands.push(command),
  });
  tui.start();
  tui.setInputSuspended(true);
  input.emit("q");
  assert.deepEqual(commands, []);
  tui.setInputSuspended(false);
  input.emit("q");
  assert.deepEqual(commands, ["cancel"]);
  tui.stop();
});

test("TUI exposes approval details and specialist evidence", () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const tui = new FullScreenTui({ input, output });
  tui.start();
  tui.handle(
    event("agent.delegation", {
      role: "reviewer",
      status: "completed",
      turns: 1,
      text: "Review complete",
      budget: {
        profile: "quality",
        plannedRoles: 6,
        usedRoles: 1,
        plannedTurns: 8,
        usedTurns: 1,
        contextChars: 100,
        outputChars: 90,
        skippedRoles: [],
      },
    }),
  );
  tui.handle(
    event("agent.delegation", {
      role: "custom-security-auditor",
      status: "completed",
      turns: 1,
      artifact: {
        version: 1,
        kind: "custom",
        roleId: "custom-security-auditor",
        mission: "Review security boundaries",
        findings: [],
        evidence: [{ source: "context", detail: "bounded" }],
        risks: [],
        recommendedChecks: [],
        unknowns: [],
      },
      budget: {
        profile: "quality",
        plannedRoles: 6,
        usedRoles: 2,
        plannedTurns: 8,
        usedTurns: 2,
        contextChars: 200,
        outputChars: 180,
        skippedRoles: [],
      },
    }),
  );
  tui.showApproval(
    event("tool.proposal", {
      tool: "process.run",
      risk: "local-execution",
      arguments: { command: "npm", args: ["test"] },
      reason: "Run the project verification suite",
    }),
  );
  assert.match(output.text(), /APPROVAL REQUIRED/);
  assert.match(output.text(), /process\.run/);
  tui.setApprovalActive(false);
  input.emit("4");
  assert.match(output.text(), /reviewer:completed\/1t/);
  assert.match(output.text(), /process\.run/);
  input.emit("5");
  assert.match(output.text(), /Supervisor-created specialists/);
  assert.match(output.text(), /custom-security-auditor/);
  assert.match(output.text(), /Budget: 2\/6 roles/);
  tui.stop();
});
