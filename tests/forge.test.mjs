import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ForgeSupervisor } from "../dist/apps/forge-cli/src/supervisor.js";
import {
  PolicyEngine,
  WorkspaceTools,
} from "../dist/apps/forge-cli/src/tools.js";

async function tempWorkspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-test-"));
  await writeFile(
    path.join(directory, "README.md"),
    "# Fixture\nThis is a Forge fixture.\n",
  );
  await writeFile(path.join(directory, "app.txt"), "hello forge\n");
  return directory;
}

test("safe policy requires approval for writes and execution", () => {
  const policy = new PolicyEngine("safe");
  assert.equal(policy.requiresApproval("read-only"), false);
  assert.equal(policy.requiresApproval("reversible-write"), true);
  assert.equal(policy.requiresApproval("local-execution"), true);
  assert.equal(policy.isAllowed("destructive"), false);
  assert.equal(policy.isAllowed("network"), false);
  assert.equal(policy.isAllowed("credential-sensitive"), false);
});

test("workspace tools contain paths, deny secrets, patch files, and run bounded commands", async () => {
  const directory = await tempWorkspace();
  try {
    const tools = new WorkspaceTools(directory);
    const listing = await tools.execute({
      tool: "workspace.list",
      arguments: { limit: 20 },
    });
    assert.equal(listing.ok, true);
    assert.match(JSON.stringify(listing.output), /README\.md/);
    const read = await tools.execute({
      tool: "workspace.read",
      arguments: { path: "README.md" },
    });
    assert.equal(read.ok, true);
    assert.match(JSON.stringify(read.output), /Fixture/);
    const traversal = await tools.execute({
      tool: "workspace.read",
      arguments: { path: "../outside.txt" },
    });
    assert.equal(traversal.ok, false);
    const secret = await tools.execute({
      tool: "workspace.read",
      arguments: { path: ".env" },
    });
    assert.equal(secret.ok, false);
    const search = await tools.execute({
      tool: "workspace.search",
      arguments: { query: "forge" },
    });
    assert.equal(search.ok, true);
    assert.match(JSON.stringify(search.output), /README\.md/);
    const patch = await tools.execute({
      tool: "workspace.apply_patch",
      arguments: { path: "app.txt", content: "updated forge\n" },
    });
    assert.equal(patch.ok, true);
    assert.equal(
      await readFile(path.join(directory, "app.txt"), "utf8"),
      "updated forge\n",
    );
    const command = await tools.execute({
      tool: "process.run",
      arguments: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('ok')"],
        timeoutMs: 5000,
      },
    });
    assert.equal(command.ok, true);
    assert.match(JSON.stringify(command.output), /ok/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("supervisor applies a proposed change only after approval", async () => {
  const directory = await tempWorkspace();
  try {
    const supervisor = new ForgeSupervisor();
    const result = await supervisor.run({
      prompt: "Create file generated.txt",
      workspace: directory,
      approve: async () => "approve-once",
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.changedFiles, ["generated.txt"]);
    assert.equal(
      await readFile(path.join(directory, "generated.txt"), "utf8"),
      "Created by Forge v0.1 mock agent.\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("supervisor completes a mock read-only plan flow", async () => {
  const directory = await tempWorkspace();
  try {
    const supervisor = new ForgeSupervisor();
    const events = [];
    const result = await supervisor.run({
      prompt: "Explain this fixture repository",
      workspace: directory,
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.status, "completed");
    assert.ok(events.some((event) => event.type === "agent.plan"));
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool.result" && event.tool === "workspace.list",
      ),
    );
    assert.equal(
      await readFile(path.join(directory, "README.md"), "utf8"),
      "# Fixture\nThis is a Forge fixture.\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
