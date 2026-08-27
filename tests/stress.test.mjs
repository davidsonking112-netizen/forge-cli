import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
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
import { DaytonaClient } from "../dist/apps/forge-cli/src/daytona.js";
import {
  WorkspaceLockError,
  acquireWorkspaceLock,
  workspaceLockPath,
} from "../dist/apps/forge-cli/src/locks.js";
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

test("workspace locks reject active contention and release cleanly", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "forge-lock-state-"));
  const previous = process.env.XDG_STATE_HOME;
  const root = await fixture();
  process.env.XDG_STATE_HOME = state;
  try {
    const first = await acquireWorkspaceLock(root);
    await assert.rejects(
      acquireWorkspaceLock(root),
      (error) =>
        error instanceof WorkspaceLockError &&
        error.code === "WORKSPACE_LOCKED",
    );
    await first.release();
    const second = await acquireWorkspaceLock(root);
    await second.release();
    await assert.rejects(readFile(workspaceLockPath(root), "utf8"));
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("workspace locks reclaim dead-process lock records", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "forge-stale-lock-"));
  const previous = process.env.XDG_STATE_HOME;
  const root = await fixture();
  process.env.XDG_STATE_HOME = state;
  try {
    const lockPath = workspaceLockPath(root);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 999999,
        startedAt: new Date().toISOString(),
        workspace: root,
        token: "dead-process-token",
      }),
    );
    const lock = await acquireWorkspaceLock(root);
    const record = JSON.parse(await readFile(lock.path, "utf8"));
    assert.equal(record.workspace, root);
    assert.notEqual(record.token, "dead-process-token");
    await lock.release();
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("approved subprocesses stop on caller cancellation", async () => {
  const root = await fixture();
  const marker = path.join(root, "cancelled-marker.txt");
  const controller = new AbortController();
  try {
    const pending = new WorkspaceTools(root).execute({
      tool: "process.run",
      arguments: {
        command: process.execPath,
        args: [
          "-e",
          "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'late'), 500)",
          marker,
        ],
        timeoutMs: 5_000,
      },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "TOOL_EXECUTION_ERROR");
    assert.match(result.error?.message ?? "", /cancelled/i);
    await new Promise((resolve) => setTimeout(resolve, 650));
    await assert.rejects(readFile(marker, "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approval cancellation stops a proposed mutation", async () => {
  const root = await fixture();
  const events = [];
  try {
    const result = await new ForgeSupervisor().run({
      prompt: "Create file cancelled.txt",
      workspace: root,
      onEvent: (event) => events.push(event),
      approve: async () => "cancel",
    });
    assert.equal(result.status, "cancelled");
    await assert.rejects(readFile(path.join(root, "cancelled.txt"), "utf8"));
    assert.ok(
      events.some(
        (event) =>
          event.type === "approval.result" && event.decision === "cancel",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Ctrl-C interrupts an in-flight provider call", async () => {
  const root = await fixture();
  const server = createServer(() => {
    // Hold the provider request open until Forge is interrupted.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const requestReceived = new Promise((resolve) =>
    server.once("request", resolve),
  );
  const cli = path.resolve("dist/apps/forge-cli/src/main.js");
  const child = spawn(
    process.execPath,
    [cli, "run", "--prompt", "inspect the repository", "--workspace", root],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FORGE_PROVIDER: "openai-compatible",
        FORGE_API_KEY: "fixture-provider-key",
        FORGE_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        FORGE_MODEL: "fixture-model",
        FORGE_PROVIDER_RETRIES: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    await Promise.race([
      requestReceived,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("provider fixture was not called")),
          5_000,
        ),
      ),
    ]);
    child.kill("SIGINT");
    const result = await new Promise((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    assert.equal(result.code, 130);
  } finally {
    if (!child.killed) child.kill("SIGTERM");
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("SIGINT-style abort resolves an in-flight approval", async () => {
  const root = await fixture();
  const controller = new AbortController();
  let approvalStarted = false;
  try {
    const pending = new ForgeSupervisor().run({
      prompt: "Create file approval-cancelled.txt",
      workspace: root,
      signal: controller.signal,
      approve: async () => {
        approvalStarted = true;
        return await new Promise(() => {});
      },
    });
    for (let attempt = 0; attempt < 50 && !approvalStarted; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(approvalStarted, true);
    controller.abort();
    const result = await pending;
    assert.equal(result.status, "cancelled");
    await assert.rejects(
      readFile(path.join(root, "approval-cancelled.txt"), "utf8"),
    );
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("Daytona requests stop on caller cancellation", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = async (_input, init) =>
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    const pending = new DaytonaClient({
      apiKey: "fixture-secret",
      apiUrl: "https://daytona.invalid/api",
    }).getSandbox("sandbox-1", controller.signal);
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.status, null);
    assert.equal(result.error, "Daytona request cancelled");
  } finally {
    globalThis.fetch = originalFetch;
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
    assert.equal(record.status, "running");
    assert.equal(record.resumeCount, 0);
    await store.append(record, {
      ...createEnvelope("agent.text", record.id),
      type: "agent.text",
      text: "hello",
    });
    await store.append(record, {
      ...createEnvelope("agent.plan", record.id),
      type: "agent.plan",
      goal: "Inspect fixture",
      steps: [{ id: "inspect", description: "Read files", status: "active" }],
      assumptions: [],
      verification: ["npm test"],
    });
    const restored = await store.read(record.id);
    assert.equal(restored.events.length, 2);
    assert.equal(restored.plan?.goal, "Inspect fixture");
    assert.equal(restored.status, "running");
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

test("MCP requests support explicit AbortSignal cancellation", async () => {
  const serverScript =
    "process.stdin.setEncoding('utf8'); let buffer=''; process.stdin.on('data', chunk => { buffer += chunk; for (const line of buffer.split('\\n').slice(0, -1)) { const request = JSON.parse(line); if (request.id && request.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-06-18',capabilities:{}}})+'\\n'); } buffer = buffer.slice(buffer.lastIndexOf('\\n') + 1); });";
  const client = new McpStdioClient(
    {
      id: "cancel-fixture",
      command: process.execPath,
      args: ["-e", serverScript],
      enabled: true,
      explicitConsent: true,
      trust: "untrusted",
      defaultRisk: "network",
    },
    3000,
  );
  const controller = new AbortController();
  try {
    await client.start();
    const pending = client.callTool("local.echo", {}, controller.signal);
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(pending, (error) => error?.category === "cancelled");
  } finally {
    client.close();
  }
});

test("MCP close rejects pending requests", async () => {
  const serverScript =
    "process.stdin.setEncoding('utf8'); let buffer=''; process.stdin.on('data', chunk => { buffer += chunk; for (const line of buffer.split('\\n').slice(0, -1)) { const request = JSON.parse(line); if (request.id && request.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-06-18',capabilities:{}}})+'\\n'); } buffer = buffer.slice(buffer.lastIndexOf('\\n') + 1); });";
  const client = new McpStdioClient(
    {
      id: "close-fixture",
      command: process.execPath,
      args: ["-e", serverScript],
      enabled: true,
      explicitConsent: true,
      trust: "untrusted",
      defaultRisk: "network",
    },
    3000,
  );
  await client.start();
  const pending = client.callTool("local.echo", {});
  client.close();
  await assert.rejects(pending, (error) => error?.category === "cancelled");
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

test("v0.9 CLI exposes recovery, change-set, verification, policy, extension, MCP, and PR workflows", async () => {
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
    const help = spawnSync(process.execPath, [cli, "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /github status/);
    assert.match(help.stdout, /connect/);
    assert.match(help.stdout, /create/);
    const githubCreate = spawnSync(
      process.execPath,
      [cli, "github", "create", "owner/project", "--workspace", root],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(githubCreate.status, 2);
    assert.match(githubCreate.stderr, /interactive YES confirmation/i);
    const profiles = spawnSync(process.execPath, [cli, "profiles"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(profiles.status, 0);
    assert.match(profiles.stdout, /research/);
    const providers = spawnSync(process.execPath, [cli, "providers"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, FORGE_API_KEY: "must-not-appear" },
    });
    assert.equal(providers.status, 0);
    assert.match(providers.stdout, /requesty/);
    assert.match(providers.stdout, /REQUESTY_API_KEY/);
    assert.match(providers.stdout, /openrouter/);
    assert.match(providers.stdout, /Set FORGE_PROVIDER=openai-compatible/);
    assert.doesNotMatch(providers.stdout, /must-not-appear/);
    const indexState = path.join(root, "index-state");
    const indexEnv = { ...process.env, XDG_STATE_HOME: indexState };
    const indexBuild = spawnSync(
      process.execPath,
      [cli, "index", "build", "--workspace", root],
      { cwd: process.cwd(), encoding: "utf8", env: indexEnv },
    );
    assert.equal(indexBuild.status, 0);
    const indexShow = spawnSync(
      process.execPath,
      [cli, "index", "show", "--workspace", root],
      { cwd: process.cwd(), encoding: "utf8", env: indexEnv },
    );
    assert.equal(indexShow.status, 0);
    assert.match(indexShow.stdout, /"files"/);
    const indexQuery = spawnSync(
      process.execPath,
      [cli, "index", "query", "fixture", "--workspace", root],
      { cwd: process.cwd(), encoding: "utf8", env: indexEnv },
    );
    assert.equal(indexQuery.status, 0);
    assert.match(indexQuery.stdout, /entries/);
    const indexClear = spawnSync(
      process.execPath,
      [cli, "index", "clear", "--workspace", root],
      { cwd: process.cwd(), encoding: "utf8", env: indexEnv },
    );
    assert.equal(indexClear.status, 0);
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
    const validated = spawnSync(
      process.execPath,
      [cli, "mcp", "validate", "--config", config],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(validated.status, 0);
    assert.match(validated.stdout, /\"valid\": true/);
    const malformedConfig = path.join(root, "malformed-integrations.json");
    await writeFile(malformedConfig, "{not-json");
    const malformed = spawnSync(
      process.execPath,
      [cli, "mcp", "validate", "--config", malformedConfig],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(malformed.status, 1);
    assert.match(malformed.stdout, /not valid JSON/);
    const duplicateConfig = path.join(root, "duplicate-integrations.json");
    await writeFile(
      duplicateConfig,
      JSON.stringify({
        servers: [
          { id: "duplicate", command: process.execPath, args: [] },
          { id: "duplicate", command: process.execPath, args: [] },
        ],
      }),
    );
    const duplicate = spawnSync(
      process.execPath,
      [cli, "mcp", "validate", "--config", duplicateConfig],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stdout, /duplicate MCP server id/);
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
    const preview = spawnSync(
      process.execPath,
      [cli, "preview-diff", diffFile, "--workspace", root],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(preview.status, 0);
    assert.match(preview.stdout, /\"safeToApply\": true/);
    assert.match(preview.stdout, /"action": "modify"/);
    const selectedPreview = spawnSync(
      process.execPath,
      [
        cli,
        "preview-diff",
        diffFile,
        "--workspace",
        root,
        "--only",
        "README.md",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(selectedPreview.status, 0);
    assert.match(selectedPreview.stdout, /"selected": true/);
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
    assert.match(acp.stdout, /"approvalRequired":true/);
    assert.match(acp.stdout, /"correlationId":1/);
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
    const explanation = spawnSync(
      process.execPath,
      [
        cli,
        "policy",
        "explain",
        "local-execution",
        "process.run",
        "--profile",
        "research",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(explanation.status, 0);
    assert.match(explanation.stdout, /\"allowed\": false/);
    assert.match(explanation.stdout, /profile/);
    assert.match(explanation.stdout, /"category"/);
    assert.match(explanation.stdout, /"nextAction"/);
    const context = spawnSync(
      process.execPath,
      [cli, "context", "find relevant tests", `--workspace=${root}`],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    assert.equal(context.status, 0);
    assert.match(context.stdout, /relevantFiles/);
    assert.match(context.stdout, /contextStats/);
    const daytona = spawnSync(process.execPath, [cli, "daytona", "status"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DAYTONA_API_KEY: "", DAYTONA_API_URL: "" },
    });
    assert.equal(daytona.status, 1);
    assert.match(daytona.stdout, /configured/);
    const extensionDir = path.join(root, "extensions");
    await mkdir(extensionDir);
    await writeFile(
      path.join(extensionDir, "sample.json"),
      JSON.stringify({
        id: "sample",
        version: "1.0.0",
        protocol: 1,
        capabilities: ["context"],
        recipes: {
          contextGlobs: ["src/**/*.ts"],
          verification: [["npm", "run", "test"]],
        },
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
    assert.match(extensions.stdout, /contextGlobs/);
    const extensionInspection = spawnSync(
      process.execPath,
      [cli, "extensions", "inspect", "sample", extensionDir],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(extensionInspection.status, 0);
    assert.match(extensionInspection.stdout, /inert-metadata-only/);
    assert.match(extensionInspection.stdout, /"executable": false/);
    const planState = await mkdtemp(
      path.join(os.tmpdir(), "forge-v07-cli-state-"),
    );
    const promptConfig = await mkdtemp(
      path.join(os.tmpdir(), "forge-v099-cli-config-"),
    );
    const cliEnv = {
      ...process.env,
      XDG_STATE_HOME: planState,
      XDG_CONFIG_HOME: promptConfig,
    };
    try {
      const promptSet = spawnSync(
        process.execPath,
        [cli, "prompt", "set", "Prefer concise evidence"],
        { cwd: process.cwd(), encoding: "utf8", env: cliEnv },
      );
      assert.equal(promptSet.status, 0);
      const promptShow = spawnSync(process.execPath, [cli, "prompt", "show"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: cliEnv,
      });
      assert.equal(promptShow.status, 0);
      assert.match(promptShow.stdout, /Prefer concise evidence/);
      const planned = spawnSync(
        process.execPath,
        [cli, "plan", "Explain the stress fixture", "--workspace", root],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: cliEnv,
        },
      );
      assert.equal(planned.status, 0);
      const listedSessions = spawnSync(
        process.execPath,
        [cli, "session", "list"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: cliEnv,
        },
      );
      assert.equal(listedSessions.status, 0);
      const sessionId = listedSessions.stdout.trim().split(/\s+/)[0];
      assert.match(sessionId, /^[a-f0-9-]{36}$/i);
      const inspection = spawnSync(
        process.execPath,
        [cli, "inspect", sessionId],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: cliEnv,
        },
      );
      assert.equal(inspection.status, 0);
      assert.match(inspection.stdout, /journal/);
      assert.match(inspection.stdout, /workspaceFingerprint/);
      assert.match(inspection.stdout, /scratchpad/);
      assert.match(inspection.stdout, /checklist/);
      assert.match(inspection.stdout, /delegationBudget/);
      const audit = spawnSync(process.execPath, [cli, "audit", sessionId], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: cliEnv,
      });
      assert.equal(audit.status, 0);
      assert.match(audit.stdout, /"redacted": true/);
      assert.match(audit.stdout, /agent.checklist/);
      const recovery = spawnSync(
        process.execPath,
        [cli, "session", "recovery", sessionId],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: cliEnv,
        },
      );
      assert.equal(recovery.status, 0);
      assert.match(recovery.stdout, /re-plan|continue/);
      const verification = spawnSync(
        process.execPath,
        [cli, "verify", sessionId],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: cliEnv,
        },
      );
      assert.equal(verification.status, 1);
      assert.match(verification.stdout, /"replayed": false/);
      assert.match(verification.stdout, /evidenceDigest/);
      assert.match(verification.stdout, /nextAction/);
    } finally {
      await rm(planState, { recursive: true, force: true });
      await rm(promptConfig, { recursive: true, force: true });
    }
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

test("forge status summarizes safe local state without secrets", async () => {
  const root = await fixture();
  const state = await mkdtemp(path.join(os.tmpdir(), "forge-status-state-"));
  try {
    const cli = path.resolve("dist/apps/forge-cli/src/main.js");
    const env = {
      ...process.env,
      FORGE_PROVIDER: "mock",
      OPENAI_API_KEY: "status-secret-must-not-appear",
      XDG_STATE_HOME: state,
    };
    const result = spawnSync(
      process.execPath,
      [cli, "status", `--workspace=${root}`, "--output=json"],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    assert.equal(result.status, 0);
    const status = JSON.parse(result.stdout);
    assert.equal(status.readOnly, true);
    assert.equal(status.workspace, root);
    assert.equal(status.provider.name, "mock");
    assert.equal(status.provider.credentialConfigured, true);
    assert.equal(status.policy.mode, "safe");
    assert.equal(status.policy.profile, "local-test");
    assert.equal(status.session, null);
    assert.equal(status.mcp.launched, false);
    assert.equal(status.verificationFreshness, "none");
    assert.doesNotMatch(result.stdout, /status-secret-must-not-appear/);
    const invalid = spawnSync(
      process.execPath,
      [cli, "status", `--workspace=${path.join(root, "missing")}`],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /WORKSPACE_INVALID/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("forge errors exposes the stable automation contract", async () => {
  const cli = path.resolve("dist/apps/forge-cli/src/main.js");
  const result = spawnSync(process.execPath, [cli, "errors"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  const reference = JSON.parse(result.stdout);
  assert.equal(reference.schemaVersion, 1);
  assert.deepEqual(
    reference.exitCodes.map((entry) => entry.code),
    [0, 1, 2, 130],
  );
  assert.ok(
    reference.structuredErrorCodes.some(
      (entry) => entry.code === "COMMAND_FAILED" && entry.retryable === true,
    ),
  );
  const misuse = spawnSync(process.execPath, [cli, "errors", "extra"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(misuse.status, 2);
  assert.match(misuse.stderr, /Usage: forge errors/);
});

test("forge init performs read-only onboarding checks", async () => {
  const root = await fixture();
  try {
    const cli = path.resolve("dist/apps/forge-cli/src/main.js");
    const env = {
      ...process.env,
      FORGE_PROVIDER: "mock",
      DAYTONA_API_KEY: "",
      OPENAI_API_KEY: "",
      FORGE_API_KEY: "",
    };
    const text = spawnSync(
      process.execPath,
      [cli, "init", "--workspace", root],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    assert.equal(text.status, 0);
    assert.match(text.stdout, /Forge CLI onboarding \(read-only\)/);
    assert.match(text.stdout, /Node\.js runtime/);
    assert.match(text.stdout, /Python runtime/);
    assert.match(text.stdout, /Approved workspace/);
    assert.match(text.stdout, /No packages installed/);
    assert.doesNotMatch(text.stdout, /sk-|OPENAI_API_KEY=.*\S+/);
    const machine = spawnSync(
      process.execPath,
      [cli, "init", `--workspace=${root}`, "--output=json"],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    assert.equal(machine.status, 0);
    const report = JSON.parse(machine.stdout);
    assert.equal(report.readOnly, true);
    assert.equal(report.workspace, root);
    assert.ok(
      report.checks.some(
        (check) => check.id === "provider" && check.status === "pass",
      ),
    );
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
    assert.equal(registry.list()[1].enabled, false);
    assert.equal(registry.list()[1].explicitConsent, false);
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

test("configuration writes do not follow symlinks", async () => {
  const root = await fixture();
  const configHome = await mkdtemp(
    path.join(os.tmpdir(), "forge-config-home-"),
  );
  const outside = path.join(root, "outside.txt");
  try {
    await writeFile(outside, "do-not-change\n");
    await mkdir(path.join(configHome, "forge"));
    await symlink(outside, path.join(configHome, "forge", "config.json"));
    const cli = path.resolve("dist/apps/forge-cli/src/main.js");
    const result = spawnSync(
      process.execPath,
      [cli, "config", "set", "mode", "safe"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, XDG_CONFIG_HOME: configHome },
      },
    );
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(outside, "utf8"), "do-not-change\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(configHome, { recursive: true, force: true });
  }
});

test("MCP tool-list bounds reject excessive tool counts", async () => {
  const serverScript =
    "process.stdin.setEncoding('utf8'); let buffer=''; process.stdin.on('data', chunk => { buffer += chunk; for (const line of buffer.split('\\n').slice(0, -1)) { const request = JSON.parse(line); if (request.id && request.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-06-18',capabilities:{}}})+'\\n'); if (request.id && request.method === 'tools/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{tools:Array.from({length:501}, (_, index) => ({name:'tool.'+index,inputSchema:{type:'object'}}))}})+'\\n'); } buffer = buffer.slice(buffer.lastIndexOf('\\n') + 1); });";
  const client = new McpStdioClient(
    {
      id: "tool-count",
      command: process.execPath,
      args: ["-e", serverScript],
      enabled: true,
      explicitConsent: true,
      trust: "untrusted",
      defaultRisk: "network",
    },
    3000,
  );
  try {
    await client.start();
    await assert.rejects(client.listTools(), /500-tool limit/);
  } finally {
    client.close();
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
