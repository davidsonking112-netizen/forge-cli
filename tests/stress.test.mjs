import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
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
  ExternalToolRegistry,
  loadExternalServers,
} from "../dist/apps/forge-cli/src/integrations.js";
import { SessionStore } from "../dist/apps/forge-cli/src/sessions.js";
import { createEnvelope } from "../dist/packages/protocol/src/index.js";
import { WorkspaceTools } from "../dist/apps/forge-cli/src/tools.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-stress-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "README.md"), "# Stress fixture\n");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: {
        test: "node --version",
        lint: "node --version",
        build: "node --version",
      },
    }),
  );
  await writeFile(
    path.join(root, "src", "main.ts"),
    "export function main() { return true; }\n",
  );
  return root;
}

test("context discovers verification commands and symbols", async () => {
  const root = await fixture();
  try {
    const context = await buildRepositoryContext(root, "main");
    assert.deepEqual(context.verificationCommands, [
      ["npm", "run", "test"],
      ["npm", "run", "lint"],
      ["npm", "run", "build"],
    ]);
    assert.ok(
      context.relevantFiles.some((file) => file.symbols?.includes("main")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process failures and timeouts become bounded tool failures", async () => {
  const root = await fixture();
  try {
    const tools = new WorkspaceTools(root);
    const failure = await tools.execute({
      tool: "process.run",
      arguments: {
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        timeoutMs: 3000,
      },
    });
    assert.equal(failure.ok, false);
    assert.equal(failure.error?.code, "COMMAND_FAILED");
    const timeout = await tools.execute({
      tool: "process.run",
      arguments: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        timeoutMs: 100,
      },
    });
    assert.equal(timeout.ok, false);
    assert.match(timeout.error?.message ?? "", /timed out/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint restoration handles existing and newly-created files", async () => {
  const root = await fixture();
  const state = await mkdtemp(path.join(os.tmpdir(), "forge-stress-state-"));
  try {
    const tools = new WorkspaceTools(root, state);
    const result = await tools.execute({
      tool: "workspace.apply_patch",
      arguments: {
        files: [
          { path: "README.md", content: "changed\n" },
          { path: "created.txt", content: "created\n" },
        ],
      },
    });
    assert.equal(result.ok, true);
    assert.equal(
      await readFile(path.join(root, "README.md"), "utf8"),
      "changed\n",
    );
    await tools.restoreCheckpoint(result.output.checkpoint);
    assert.equal(
      await readFile(path.join(root, "README.md"), "utf8"),
      "# Stress fixture\n",
    );
    await assert.rejects(readFile(path.join(root, "created.txt"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("session persistence retains bounded events and rejects invalid IDs", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "forge-session-state-"));
  try {
    const store = new SessionStore(state);
    const record = await store.create("/tmp/fixture");
    await store.append(record, {
      ...createEnvelope("agent.text", record.id),
      type: "agent.text",
      text: "hello",
    });
    const restored = await store.read(record.id);
    assert.equal(restored.events.length, 1);
    assert.equal((await store.list()).length, 1);
    await assert.rejects(store.read("not-a-session"), /Invalid session ID/);
    await store.remove(record.id);
    assert.equal((await store.list()).length, 0);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("external server config stays disabled and rejects unsafe IDs", async () => {
  const root = await fixture();
  try {
    const config = path.join(root, "integrations.json");
    await writeFile(
      config,
      JSON.stringify({
        servers: [
          { id: "helper", command: "helper", args: ["--stdio"], enabled: true },
        ],
      }),
    );
    const registry = await loadExternalServers(config);
    assert.equal(registry.list()[0].enabled, false);
    assert.throws(
      () =>
        new ExternalToolRegistry().register({
          id: "../bad",
          command: "helper",
          args: [],
          enabled: false,
          trust: "untrusted",
          defaultRisk: "network",
        }),
      /IDs/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace traversal and symlink escapes stay blocked under stress", async () => {
  const root = await fixture();
  const outside = await mkdtemp(
    path.join(os.tmpdir(), "forge-outside-stress-"),
  );
  try {
    await writeFile(path.join(outside, "secret.txt"), "secret\n");
    await symlink(outside, path.join(root, "external"));
    const tools = new WorkspaceTools(root);
    for (const relativePath of [
      "../secret.txt",
      "/etc/passwd",
      "external/secret.txt",
    ]) {
      const result = await tools.execute({
        tool: "workspace.read",
        arguments: { path: relativePath },
      });
      assert.equal(result.ok, false, relativePath);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
