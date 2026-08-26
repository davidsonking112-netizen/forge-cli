import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { McpStdioClient } from "../dist/apps/forge-cli/src/mcp.js";
import { SessionStore } from "../dist/apps/forge-cli/src/sessions.js";
import { ForgeSupervisor } from "../dist/apps/forge-cli/src/supervisor.js";
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

test("MCP stdio client initializes, discovers tools, calls safely, and closes", async () => {
  const serverScript =
    "process.stdin.setEncoding('utf8'); let buffer=''; process.stdin.on('data', chunk => { buffer += chunk; for (const line of buffer.split('\\n').slice(0, -1)) { const request = JSON.parse(line); if (request.id && request.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-06-18',capabilities:{}}})+'\\n'); if (request.id && request.method === 'tools/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{tools:[{name:'local.echo',inputSchema:{type:'object'}}]}})+'\\n'); if (request.id && request.method === 'tools/call') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:String(request.params.arguments.value)}]}})+'\\n'); } buffer = buffer.slice(buffer.lastIndexOf('\\n') + 1); });";
  const client = new McpStdioClient(
    {
      id: "fixture",
      command: process.execPath,
      args: ["-e", serverScript],
      enabled: true,
      trust: "untrusted",
      defaultRisk: "network",
    },
    3000,
  );
  try {
    await client.start();
    assert.deepEqual((await client.listTools())[0]?.name, "local.echo");
    const result = await client.callTool("local.echo", { value: "ok" });
    assert.equal(result.content[0].text, "ok");
  } finally {
    client.close();
  }
});

test("no-record supervisor runs do not persist session data", async () => {
  const root = await fixture();
  const state = await mkdtemp(path.join(os.tmpdir(), "forge-no-record-state-"));
  try {
    const events = [];
    const supervisor = new ForgeSupervisor(new SessionStore(state));
    const result = await supervisor.run({
      prompt: "explain this repository",
      workspace: root,
      record: false,
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.status, "completed");
    assert.ok(events.some((event) => event.type === "session.complete"));
    assert.equal((await new SessionStore(state).list()).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("v0.5 CLI exposes safe review, ACP, policy, extension, MCP, and PR workflows", async () => {
  const root = await fixture();
  try {
    const config = path.join(root, "integrations.json");
    await writeFile(
      config,
      JSON.stringify({
        servers: [{ id: "helper", command: process.execPath, args: [] }],
      }),
    );
    const cli = path.resolve("dist/apps/forge-cli/src/main.js");
    const listed = spawnSync(
      process.execPath,
      [cli, "mcp", "list", "--config", config],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    assert.equal(listed.status, 0);
    assert.match(listed.stdout, /\"id\": \"helper\"/);
    assert.match(listed.stdout, /\"enabled\": false/);
    const denied = spawnSync(
      process.execPath,
      [cli, "mcp", "call", "helper", "local.echo", "{}", "--config", config],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /disabled by default/i);
    const diffFile = path.join(root, "change.patch");
    await writeFile(
      diffFile,
      [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1 @@",
        "-# Stress fixture",
        "+# Stress fixture v0.5",
        "",
      ].join("\n"),
    );
    const reviewed = spawnSync(process.execPath, [cli, "review", diffFile], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(reviewed.status, 0);
    assert.match(reviewed.stdout, /\"hunks\": 1/);
    const acp = spawnSync(process.execPath, [cli, "acp", "serve"], {
      cwd: process.cwd(),
      input:
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "edit.proposal",
          params: { files: ["README.md"] },
        }) + "\n",
      encoding: "utf8",
    });
    assert.equal(acp.status, 0);
    assert.match(acp.stdout, /\"approvalRequired\":true/);
    const policyFile = path.join(root, "policy.json");
    await writeFile(
      policyFile,
      JSON.stringify({
        id: "strict",
        version: "1.0.0",
        protocol: 1,
        denyRisks: ["local-execution"],
      }),
    );
    const policy = spawnSync(
      process.execPath,
      [cli, "policy", "validate", policyFile],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    assert.equal(policy.status, 0);
    assert.match(policy.stdout, /\"id\": \"strict\"/);
    const effective = spawnSync(
      process.execPath,
      [cli, "policy", "effective", policyFile],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    assert.equal(effective.status, 0);
    assert.match(effective.stdout, /globalSafetyCeiling/);
    const context = spawnSync(
      process.execPath,
      [cli, "context", "find relevant tests", "--workspace", root],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    assert.equal(context.status, 0);
    assert.match(context.stdout, /relevantFiles/);
    const extensionDir = path.join(root, "extensions");
    await mkdir(extensionDir);
    await writeFile(
      path.join(extensionDir, "sample.json"),
      JSON.stringify({
        id: "sample",
        version: "1.0.0",
        protocol: 1,
        capabilities: ["context"],
      }),
    );
    const extensions = spawnSync(
      process.execPath,
      [cli, "extensions", "list", extensionDir],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    assert.equal(extensions.status, 0);
    assert.match(extensions.stdout, /\"sample\"/);
    const draft = spawnSync(
      process.execPath,
      [cli, "git", "prepare-pr", "stress review", "--workspace", root],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    assert.equal(draft.status, 0);
    assert.match(draft.stdout, /\"title\": \"stress review\"/);
    assert.match(draft.stdout, /\"remoteAction\": \"none\"/);
  } finally {
    await rm(root, { recursive: true, force: true });
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
          {
            id: "consented",
            command: "helper",
            args: ["--stdio"],
            enabled: true,
            explicitConsent: true,
          },
        ],
      }),
    );
    const registry = await loadExternalServers(config);
    assert.equal(registry.list()[0].enabled, false);
    assert.equal(registry.list()[1].enabled, true);
    assert.equal(registry.list()[1].explicitConsent, true);
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
