import assert from "node:assert/strict";
import test from "node:test";

const { DependencyGraph } =
  await import("../dist/apps/forge-cli/src/dependency-graph.js");

const base = {
  protocol: 1,
  id: "plan-1",
  sessionId: "session-graph",
  timestamp: "2026-08-27T12:00:00.000Z",
  type: "agent.plan",
  goal: "Build a multi-milestone application",
  steps: [],
  assumptions: [],
  verification: ["npm test"],
};

function graphStep(title, dependsOn = [], overrides = {}) {
  return {
    title,
    description: `Complete ${title}`,
    expectedFiles: [`${title.toLowerCase().replaceAll(" ", "-")}.js`],
    dependsOn,
    risks: ["bounded local change"],
    tests: [`node --check ${title.toLowerCase().replaceAll(" ", "-")}.js`],
    postconditions: [`${title} evidence is observed`],
    ...overrides,
  };
}

function plan(graph) {
  return {
    ...base,
    graph,
    steps: graph.map((step, index) => ({
      id: `legacy-${index + 1}`,
      description: step.title,
      status: "pending",
    })),
  };
}

test("dependency graph assigns stable IDs and preserves complete checkpoint contracts", () => {
  const input = plan([
    graphStep("Domain model"),
    graphStep("UI", [0]),
    graphStep("Persistence", [0]),
    graphStep("Browser behavior", [1, 2]),
  ]);
  const first = new DependencyGraph(input);
  const second = new DependencyGraph(input);
  const firstSteps = first.snapshot();
  assert.deepEqual(
    firstSteps.map((step) => step.id),
    second.snapshot().map((step) => step.id),
  );
  assert.equal(first.isValid(), true);
  assert.equal(first.event("validated", "validated").status, "validated");
  assert.equal(firstSteps[0].status, "ready");
  assert.equal(firstSteps[3].status, "pending");
  assert.equal(firstSteps[3].dependencies.length, 2);
  assert.ok(firstSteps[0].expectedFiles.length > 0);
  assert.ok(firstSteps[0].tests.length > 0);
  assert.ok(firstSteps[0].postconditions.length > 0);
});

test("a downstream step cannot run while a prerequisite contract is invalid", () => {
  const input = plan([
    graphStep("Domain model"),
    graphStep("UI", [0]),
    graphStep("Persistence", [1], { tests: [] }),
    graphStep("Browser behavior", [2]),
    graphStep("Accessibility", [3]),
    graphStep("Release", [2, 4]),
  ]);
  const graph = new DependencyGraph(input);
  assert.equal(graph.isValid(), false);
  const step3 = graph.snapshot()[2];
  const step6 = graph.snapshot()[5];
  assert.equal(step3.contractValid, false);
  assert.equal(step6.status, "pending");
  assert.equal(graph.gateForStep(step6.id).ok, false);
  assert.match(
    graph.actionGate("workspace.apply_patch").reason,
    /invalid|blocked/i,
  );
});

test("graph advancement makes only dependency-ready steps active", () => {
  const graph = new DependencyGraph(
    plan([
      graphStep("Domain model"),
      graphStep("UI", [0]),
      graphStep("Persistence", [0]),
    ]),
  );
  const domainGate = graph.actionGate("workspace.apply_patch");
  assert.equal(domainGate.ok, true);
  const domainDone = graph.markStepCompleted(domainGate.stepId);
  assert.equal(domainDone?.status, "in-progress");
  const ready = graph.snapshot().filter((step) => step.status === "ready");
  assert.equal(ready.length, 2);
  const uiGate = graph.actionGate("process.run");
  assert.equal(uiGate.ok, true);
  assert.equal(uiGate.stepId, ready[0].id);
  assert.equal(graph.gateForStep(graph.snapshot()[2].id).ok, true);
});

test("cyclic dependencies are rejected as an invalid graph", () => {
  const graph = new DependencyGraph(
    plan([graphStep("A", [1]), graphStep("B", [0])]),
  );
  assert.equal(graph.isValid(), false);
  assert.ok(
    graph
      .snapshot()
      .every((step) =>
        step.contractErrors.some((error) => /cycle/i.test(error)),
      ),
  );
  assert.equal(graph.completionGate().ok, false);
});

test("legacy plan steps receive sequential dependencies for safe fallback behavior", () => {
  const graph = new DependencyGraph({
    ...base,
    steps: [
      { id: "one", description: "First", status: "pending" },
      { id: "two", description: "Second", status: "pending" },
    ],
  });
  const steps = graph.snapshot();
  assert.equal(graph.proposedByModel(), false);
  assert.deepEqual(steps[0].dependencies, []);
  assert.deepEqual(steps[1].dependencies, [steps[0].id]);
});
