import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { PersistentMemory } = await import("../dist/apps/forge-cli/src/persistent-memory.js");

const tmp = await mkdtemp(path.join(os.tmpdir(), "forge-memory-test-"));
process.env.FORGE_STATE_DIR = path.join(tmp, "state");

test.after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("persistent memory survives a new manager and recalls related project facts", async () => {
  const root = path.join(tmp, "repo");
  const first = new PersistentMemory(root);
  await first.remember({
    content: "Forge uses npm workspaces and NodeNext TypeScript modules.",
    category: "fact",
    tags: ["typescript", "workspace"],
  });

  const second = new PersistentMemory(root);
  const matches = await second.recall("How should TypeScript packages and modules be configured?");
  assert.equal(matches.length > 0, true);
  assert.match(matches[0].memory.content, /NodeNext/);
});

test("near-duplicate memories reinforce the existing record instead of growing storage", async () => {
  const root = path.join(tmp, "dedup");
  const memory = new PersistentMemory(root);
  const first = await memory.remember({
    content: "The release gate must run the packed npm install smoke test.",
    category: "decision",
  });
  const second = await memory.remember({
    content: "The release gate must run the packed npm installation smoke test.",
    category: "decision",
  });
  assert.equal(second.id, first.id);
  assert.equal(second.reinforcement, 1);
});

test("memory context is historical evidence rather than authority", async () => {
  const { formatMemoryContext } = await import("../dist/apps/forge-cli/src/persistent-memory.js");
  const output = formatMemoryContext([{ memory: {
    id: "m",
    content: "old project decision",
    category: "decision",
    scope: "project",
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    recallCount: 0,
    reinforcement: 0,
    embedding: [],
  }, score: 0.91, reasons: ["semantic similarity"] }]);
  assert.match(output, /not instructions or authority/i);
});
