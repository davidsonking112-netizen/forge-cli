import assert from "node:assert/strict";
import test from "node:test";

const { TaskGraph } = await import("../dist/apps/forge-cli/src/task-graph.js");

const evidence = {
  findings: ["implemented change"],
  evidence: ["targeted test passed"],
  validation: ["npm test"],
  edgeCasesConsidered: ["missing dependency"],
  openQuestions: [],
  confidence: 0.95,
  whatWasNotChecked: ["live provider integration"],
};

test("DAG only exposes tasks whose dependencies completed", () => {
  const graph = new TaskGraph();
  graph.addTask({ id: "inspect", title: "Inspect", prompt: "inspect" });
  graph.addTask({ id: "implement", title: "Implement", prompt: "implement", dependsOn: ["inspect"] });
  assert.deepEqual(graph.runnable().map((node) => node.id), ["inspect"]);
  graph.start("inspect", "explorer");
  graph.complete("inspect", evidence);
  assert.deepEqual(graph.runnable().map((node) => node.id), ["implement"]);
});

test("DAG rejects cycles before they can enter scheduler state", () => {
  const graph = new TaskGraph();
  graph.addTask({ id: "a", title: "A", prompt: "a" });
  graph.addTask({ id: "b", title: "B", prompt: "b", dependsOn: ["a"] });
  assert.throws(() => graph.addTask({ id: "a2", title: "A2", prompt: "a2", dependsOn: ["b", "a2"] }), /cycle/i);
});

test("completion requires actual evidence or validation", () => {
  const graph = new TaskGraph();
  graph.addTask({ id: "task", title: "Task", prompt: "do it" });
  graph.start("task", "worker");
  assert.throws(() => graph.complete("task", { ...evidence, evidence: [], validation: [] }), /evidence or validation/i);
  graph.complete("task", evidence);
  assert.equal(graph.snapshot().nodes[0].status, "completed");
});

test("failed dependencies block downstream work", () => {
  const graph = new TaskGraph();
  graph.addTask({ id: "a", title: "A", prompt: "a" });
  graph.addTask({ id: "b", title: "B", prompt: "b", dependsOn: ["a"] });
  graph.start("a");
  graph.fail("a", { ...evidence, evidence: ["failure captured"] });
  assert.deepEqual(graph.blocked().map((node) => node.id), ["b"]);
  assert.equal(graph.snapshot().nodes.find((node) => node.id === "b")?.status, "blocked");
});
