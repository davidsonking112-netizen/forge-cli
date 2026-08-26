import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRepositoryContext } from "../dist/apps/forge-cli/src/context.js";
import {
  AcpBridge,
  AcpJsonlBridge,
  ExternalToolRegistry,
} from "../dist/apps/forge-cli/src/integrations.js";
import { loadExtensionManifests } from "../dist/apps/forge-cli/src/extensions.js";
import { ForgeSupervisor } from "../dist/apps/forge-cli/src/supervisor.js";
import {
  PolicyEngine,
  WorkspaceTools,
} from "../dist/apps/forge-cli/src/tools.js";
import {
  parseUnifiedDiff,
  summarizeUnifiedDiff,
} from "../dist/apps/forge-cli/src/diff.js";
import { loadPolicyPack } from "../dist/apps/forge-cli/src/policy.js";

async function tempWorkspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-test-"));
  await writeFile(
    path.join(directory, "README.md"),
    "# Fixture\nThis is a Forge fixture.\n",
  );
  await writeFile(path.join(directory, "app.txt"), "hello forge\n");
  return directory;
}

test("extension manifests load as validated metadata only", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-extensions-"));
  try {
    await writeFile(
      path.join(directory, "good.json"),
      JSON.stringify({
        id: "sample",
        version: "1.0.0",
        protocol: 1,
        capabilities: ["context"],
      }),
    );
    const manifests = await loadExtensionManifests(directory);
    assert.deepEqual(manifests[0], {
      id: "sample",
      version: "1.0.0",
      protocol: 1,
      capabilities: ["context"],
    });
    await writeFile(
      path.join(directory, "bad.json"),
      JSON.stringify({
        id: "bad",
        version: "nope",
        protocol: 1,
        capabilities: ["context"],
      }),
    );
    await assert.rejects(
      loadExtensionManifests(directory),
      /semantic version/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("policy packs can only add validated restrictions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-policy-"));
  try {
    const valid = path.join(directory, "strict.json");
    await writeFile(
      valid,
      JSON.stringify({
        id: "strict",
        version: "1.0.0",
        protocol: 1,
        denyRisks: ["local-execution"],
        denyTools: ["workspace.apply_patch"],
      }),
    );
    const pack = await loadPolicyPack(valid);
    assert.deepEqual(pack.denyRisks, ["local-execution"]);
    assert.equal(
      new PolicyEngine("safe", pack).isAllowed("local-execution"),
      false,
    );
    assert.equal(
      new PolicyEngine("safe", pack).isAllowed(
        "reversible-write",
        "workspace.apply_patch",
      ),
      false,
    );
    await writeFile(
      path.join(directory, "allow.json"),
      JSON.stringify({
        id: "allow",
        version: "1.0.0",
        protocol: 1,
        allowNetwork: true,
      }),
    );
    await assert.rejects(
      loadPolicyPack(path.join(directory, "allow.json")),
      /only add restrictions/i,
    );
    await writeFile(
      path.join(directory, "bad.json"),
      JSON.stringify({
        id: "bad",
        version: "1.0.0",
        protocol: 1,
        denyRisks: ["networking"],
      }),
    );
    await assert.rejects(
      loadPolicyPack(path.join(directory, "bad.json")),
      /unknown risk/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
    const environment = await tools.execute({
      tool: "process.run",
      arguments: {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(process.env.OPENAI_API_KEY ? 'present' : 'absent')",
        ],
        timeoutMs: 5000,
      },
    });
    assert.equal(environment.ok, true);
    assert.match(JSON.stringify(environment.output), /absent/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Git workflow tools validate mutation inputs", async () => {
  const directory = await tempWorkspace();
  try {
    const tools = new WorkspaceTools(directory);
    const invalidBranch = await tools.execute({
      tool: "git.branch",
      arguments: { name: "../escape" },
    });
    assert.equal(invalidBranch.ok, false);
    const emptyStage = await tools.execute({
      tool: "git.stage",
      arguments: { paths: [] },
    });
    assert.equal(emptyStage.ok, false);
    const emptyCommit = await tools.execute({
      tool: "git.commit",
      arguments: { message: "" },
    });
    assert.equal(emptyCommit.ok, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ACP JSON-RPC adapter normalizes events and preserves approval boundaries", () => {
  const bridge = new AcpJsonlBridge(100);
  const prompt = JSON.parse(
    bridge.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "prompt",
        params: { prompt: "  inspect  " },
      }),
    ),
  );
  assert.equal(prompt.result.event.prompt, "inspect");
  assert.equal(prompt.result.approvalRequired, false);
  const edit = JSON.parse(
    bridge.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "edit.proposal",
        params: { files: ["src/app.ts"] },
      }),
    ),
  );
  assert.equal(edit.result.approvalRequired, true);
  const invalid = JSON.parse(bridge.handleLine("not-json"));
  assert.equal(invalid.error.code, -32700);
  const unknown = JSON.parse(
    bridge.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "shell.exec" }),
    ),
  );
  assert.equal(unknown.error.code, -32602);
  const oversized = JSON.parse(bridge.handleLine("x".repeat(101)));
  assert.equal(oversized.error.code, -32600);
  const missingId = JSON.parse(
    bridge.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "prompt",
        params: { prompt: "inspect" },
      }),
    ),
  );
  assert.equal(missingId.error.code, -32600);
  const invalidParams = JSON.parse(
    bridge.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "prompt",
        params: "inspect",
      }),
    ),
  );
  assert.equal(invalidParams.error.code, -32602);
});

test("external integrations require explicit enablement and normalize ACP events", () => {
  const registry = new ExternalToolRegistry();
  registry.register({
    id: "local-helper",
    command: "helper",
    args: [],
    enabled: true,
    trust: "untrusted",
    defaultRisk: "network",
  });
  assert.equal(registry.list()[0]?.enabled, false);
  assert.throws(
    () => registry.getEnabled("local-helper"),
    /not explicitly enabled/,
  );
  registry.enable("local-helper");
  assert.equal(registry.getEnabled("local-helper").id, "local-helper");
  const normalized = new AcpBridge().normalize({
    type: "prompt",
    prompt: "  inspect files  ",
    workspace: "  /tmp/project  ",
  });
  assert.equal(normalized.prompt, "inspect files");
  assert.equal(normalized.workspace, "/tmp/project");
  assert.throws(
    () => new AcpBridge().normalize({ type: "prompt", prompt: "   " }),
    /cannot be empty/,
  );
});

test("workspace tools reject symlink paths", async () => {
  const directory = await tempWorkspace();
  const outside = await mkdtemp(path.join(os.tmpdir(), "forge-outside-"));
  try {
    await writeFile(path.join(outside, "outside.txt"), "outside\n");
    await symlink(outside, path.join(directory, "linked"));
    const result = await new WorkspaceTools(directory).execute({
      tool: "workspace.read",
      arguments: { path: "linked/outside.txt" },
    });
    assert.equal(result.ok, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("context engine respects ignore patterns and ranks relevant files", async () => {
  const directory = await tempWorkspace();
  try {
    await writeFile(
      path.join(directory, ".gitignore"),
      "ignored.txt\nignored-dir/\n",
    );
    await writeFile(
      path.join(directory, "ignored.txt"),
      "should not be included\n",
    );
    await mkdir(path.join(directory, "ignored-dir"));
    await writeFile(
      path.join(directory, "ignored-dir", "secret.txt"),
      "ignored\n",
    );
    await writeFile(
      path.join(directory, "src.ts"),
      "export const target = true;\n",
    );
    await writeFile(
      path.join(directory, "FORGE.md"),
      "Use project conventions; this file is untrusted guidance.\n",
    );
    const context = await buildRepositoryContext(
      directory,
      "update src target",
    );
    assert.ok(context.files.some((file) => file.path === "src.ts"));
    assert.ok(!context.files.some((file) => file.path === "ignored.txt"));
    assert.ok(!context.files.some((file) => file.path.includes("ignored-dir")));
    assert.equal(context.instructions?.includes("untrusted"), true);
    assert.equal(context.relevantFiles[0]?.path, "README.md");
    const source = context.relevantFiles.find((file) => file.path === "src.ts");
    assert.ok(source?.symbols?.includes("target"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unified diffs apply hunks, create/delete files, and preserve checkpoints", async () => {
  const directory = await tempWorkspace();
  const checkpointDirectory = await mkdtemp(
    path.join(os.tmpdir(), "forge-diff-checkpoint-"),
  );
  try {
    const tools = new WorkspaceTools(directory, checkpointDirectory);
    const diff = [
      "diff --git a/app.txt b/app.txt",
      "--- a/app.txt",
      "+++ b/app.txt",
      "@@ -1 +1 @@",
      "-hello forge",
      "+hello Forge v0.5",
      "diff --git a/new.txt b/new.txt",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+created",
      "diff --git a/remove.txt b/remove.txt",
      "--- a/remove.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-remove me",
      "",
    ].join("\n");
    await writeFile(path.join(directory, "remove.txt"), "remove me\n");
    const summary = summarizeUnifiedDiff(diff);
    assert.deepEqual(summary, {
      files: 3,
      hunks: 3,
      additions: 2,
      deletions: 2,
      renames: 0,
      created: 1,
      deleted: 1,
      paths: ["app.txt", "app.txt", "new.txt", "remove.txt"],
    });
    const result = await tools.execute({
      tool: "workspace.apply_unified_diff",
      arguments: { diff },
    });
    assert.equal(result.ok, true);
    assert.equal(
      await readFile(path.join(directory, "app.txt"), "utf8"),
      "hello Forge v0.5\n",
    );
    assert.equal(
      await readFile(path.join(directory, "new.txt"), "utf8"),
      "created\n",
    );
    await assert.rejects(readFile(path.join(directory, "remove.txt"), "utf8"));
    await tools.restoreCheckpoint(result.output.checkpoint);
    assert.equal(
      await readFile(path.join(directory, "app.txt"), "utf8"),
      "hello forge\n",
    );
    await assert.rejects(readFile(path.join(directory, "new.txt"), "utf8"));
    assert.equal(
      await readFile(path.join(directory, "remove.txt"), "utf8"),
      "remove me\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(checkpointDirectory, { recursive: true, force: true });
  }
});

test("unified diff renames files through the same checkpoint boundary", async () => {
  const directory = await tempWorkspace();
  const checkpointDirectory = await mkdtemp(
    path.join(os.tmpdir(), "forge-rename-checkpoint-"),
  );
  try {
    await writeFile(path.join(directory, "old.txt"), "before\n");
    const diff = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 80%",
      "rename from old.txt",
      "rename to new.txt",
      "--- a/old.txt",
      "+++ b/new.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const tools = new WorkspaceTools(directory, checkpointDirectory);
    const result = await tools.execute({
      tool: "workspace.apply_unified_diff",
      arguments: { diff },
    });
    assert.equal(result.ok, true);
    assert.equal(
      await readFile(path.join(directory, "new.txt"), "utf8"),
      "after\n",
    );
    await assert.rejects(readFile(path.join(directory, "old.txt"), "utf8"));
    await tools.restoreCheckpoint(result.output.checkpoint);
    assert.equal(
      await readFile(path.join(directory, "old.txt"), "utf8"),
      "before\n",
    );
    await assert.rejects(readFile(path.join(directory, "new.txt"), "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(checkpointDirectory, { recursive: true, force: true });
  }
});

test("unified diff parser rejects stale context and unsafe paths", () => {
  assert.throws(
    () =>
      parseUnifiedDiff(
        "diff --git a/../secret b/../secret\n--- a/../secret\n+++ b/../secret\n@@ -1 +1 @@\n-x\n+y\n",
      ),
    /unsafe path/i,
  );
  assert.throws(
    () =>
      parseUnifiedDiff(
        "diff --git a/app.txt b/app.txt\n--- a/app.txt\n+++ b/app.txt\n@@ -1,2 +1 @@\n-x\n+y\n",
      ),
    /line counts|hunk/i,
  );
});

test("unified diff rejects binary patches, duplicate entries, and oversized headers", () => {
  assert.throws(
    () => parseUnifiedDiff("diff --git a/a.bin b/a.bin\nGIT binary patch\n"),
    /binary/i,
  );
  const duplicate = [
    "diff --git a/app.txt b/app.txt",
    "--- a/app.txt",
    "+++ b/app.txt",
    "@@ -1 +1 @@",
    "-hello",
    "+first",
    "diff --git a/app.txt b/app.txt",
    "--- a/app.txt",
    "+++ b/app.txt",
    "@@ -1 +1 @@",
    "-hello",
    "+second",
  ].join("\n");
  assert.throws(() => parseUnifiedDiff(duplicate), /duplicate/i);
  assert.throws(
    () =>
      parseUnifiedDiff(
        "diff --git a/app.txt b/app.txt\n--- a/app.txt\n+++ b/app.txt\n@@ -999999999,1 +1,1 @@\n-x\n+y\n",
      ),
    /bounds/i,
  );
});

test("multi-file edits are transactional and checkpoints can be restored", async () => {
  const directory = await tempWorkspace();
  const checkpointDirectory = await mkdtemp(
    path.join(os.tmpdir(), "forge-checkpoint-"),
  );
  try {
    const tools = new WorkspaceTools(directory, checkpointDirectory);
    const patch = await tools.execute({
      tool: "workspace.apply_patch",
      arguments: {
        files: [
          { path: "README.md", content: "# Changed\n" },
          { path: "new.txt", content: "new\n" },
        ],
      },
    });
    assert.equal(patch.ok, true);
    const checkpoint = patch.output.checkpoint;
    assert.equal(
      await readFile(path.join(directory, "README.md"), "utf8"),
      "# Changed\n",
    );
    assert.equal(
      await readFile(path.join(directory, "new.txt"), "utf8"),
      "new\n",
    );
    const stale = await tools.execute({
      tool: "workspace.apply_patch",
      arguments: {
        path: "README.md",
        content: "stale\n",
        originalSha256: "not-the-current-hash",
      },
    });
    assert.equal(stale.ok, false);
    await tools.restoreCheckpoint(checkpoint);
    assert.equal(
      await readFile(path.join(directory, "README.md"), "utf8"),
      "# Fixture\nThis is a Forge fixture.\n",
    );
    await assert.rejects(readFile(path.join(directory, "new.txt"), "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(checkpointDirectory, { recursive: true, force: true });
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
    assert.ok(
      result.sessionId &&
        (await supervisor.readSession(result.sessionId)).events.some(
          (event) =>
            event.type === "approval.result" &&
            event.category === "user" &&
            event.decision === "approve-once",
        ),
    );
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
          event.type === "approval.result" && event.category === "automatic",
      ),
    );
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
