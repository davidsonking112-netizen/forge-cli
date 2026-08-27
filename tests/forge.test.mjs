import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import {
  buildRepositoryContext,
  DEFAULT_CONTEXT_BUDGET,
} from "../dist/apps/forge-cli/src/context.js";
import {
  AcpBridge,
  AcpJsonlBridge,
  ExternalToolRegistry,
  validateExternalServerConfig,
} from "../dist/apps/forge-cli/src/integrations.js";
import { loadExtensionManifests } from "../dist/apps/forge-cli/src/extensions.js";
import { prepareGitHubAction } from "../dist/apps/forge-cli/src/github.js";
import { McpStdioClient } from "../dist/apps/forge-cli/src/mcp.js";
import { ForgeSupervisor } from "../dist/apps/forge-cli/src/supervisor.js";
import { SessionStore } from "../dist/apps/forge-cli/src/sessions.js";
import {
  boundedFlagInt,
  isDirectInvocation,
} from "../dist/apps/forge-cli/src/main.js";
import { DaytonaClient } from "../dist/apps/forge-cli/src/daytona.js";
import {
  createEnvelope,
  isForgeEvent,
  parseForgeEvent,
} from "../dist/packages/protocol/src/index.js";
import {
  PolicyEngine,
  WorkspaceTools,
} from "../dist/apps/forge-cli/src/tools.js";
import {
  parseUnifiedDiff,
  summarizeUnifiedDiff,
} from "../dist/apps/forge-cli/src/diff.js";
import { loadPolicyPack } from "../dist/apps/forge-cli/src/policy.js";
import {
  getAutonomyProfile,
  listAutonomyProfiles,
} from "../dist/apps/forge-cli/src/profiles.js";
import {
  buildRepositoryIndex,
  clearRepositoryIndex,
  readRepositoryIndex,
} from "../dist/apps/forge-cli/src/index.js";

async function tempWorkspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-test-"));
  await writeFile(
    path.join(directory, "README.md"),
    "# Fixture\nThis is a Forge fixture.\n",
  );
  await writeFile(path.join(directory, "app.txt"), "hello forge\n");
  return directory;
}

test("Daytona support is optional, bounded, and uses explicit lifecycle endpoints", async () => {
  const unconfigured = new DaytonaClient({ apiKey: undefined });
  assert.equal(unconfigured.configuration().configured, false);
  const unavailable = await unconfigured.getSandbox();
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.error ?? "", /not configured/i);

  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const body = JSON.stringify({ id: "sb-123", token: "secret-value" });
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  };
  try {
    const client = new DaytonaClient({ apiKey: "test-secret" });
    assert.equal((await client.getSandbox("sb-123")).ok, true);
    assert.equal((await client.stopSandbox("sb-123")).ok, true);
    assert.equal((await client.deleteSandbox("sb-123")).ok, true);
    const create = await client.createSandbox({
      snapshot: "daytona-small",
      language: "typescript",
      autoDeleteInterval: 60,
    });
    assert.equal(create.ok, true);
    assert.deepEqual(
      requests.map((request) => [request.url, request.init.method]),
      [
        ["https://app.daytona.io/api/sandbox/sb-123", "GET"],
        ["https://app.daytona.io/api/sandbox/sb-123/stop", "POST"],
        ["https://app.daytona.io/api/sandbox/sb-123", "DELETE"],
        ["https://app.daytona.io/api/sandbox", "POST"],
      ],
    );
    assert.match(JSON.stringify(create.data), /REDACTED/);
    await assert.rejects(() => client.getSandbox("../escape"), /invalid/i);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("v0.95 GitHub actions are explicit, private by default, and path bounded", async () => {
  const workspace = await tempWorkspace();
  try {
    const create = await prepareGitHubAction("create", workspace, {
      repository: "owner/forge-sandbox",
    });
    assert.deepEqual(create.command, [
      "gh",
      "repo",
      "create",
      "owner/forge-sandbox",
      "--private",
      "--source",
      workspace,
      "--remote",
      "origin",
    ]);
    const clone = await prepareGitHubAction("clone", workspace, {
      repository: "owner/project",
      destination: "clones/project",
    });
    assert.equal(clone.command[0], "gh");
    assert.equal(path.basename(clone.command.at(-1)), "project");
    assert.equal(path.basename(path.dirname(clone.command.at(-1))), "clones");
    await assert.rejects(
      prepareGitHubAction("clone", workspace, {
        repository: "owner/project",
        destination: "../outside",
      }),
      /inside the approved workspace/i,
    );
    const push = await prepareGitHubAction("push", workspace);
    assert.deepEqual(push.command, ["git", "push", "origin", "HEAD"]);
    await assert.rejects(
      prepareGitHubAction("push", workspace, {
        branch: "bad branch",
      }),
      /branch is invalid/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("v0.9 protocol validation rejects malformed and unbounded event data", () => {
  const valid = {
    ...createEnvelope("agent.text", "session-1"),
    type: "agent.text",
    text: "bounded",
  };
  assert.equal(isForgeEvent(valid), true);
  assert.deepEqual(parseForgeEvent(JSON.stringify(valid)), valid);
  const scratchpad = {
    ...createEnvelope("agent.scratchpad", "session-1"),
    type: "agent.scratchpad",
    items: [{ key: "current-step", value: "Inspect", status: "active" }],
  };
  assert.equal(isForgeEvent(scratchpad), true);
  assert.throws(
    () =>
      parseForgeEvent(
        JSON.stringify({
          ...scratchpad,
          items: [{ key: "bad", value: "bad", status: "unknown" }],
        }),
      ),
    /invalid/i,
  );
  assert.throws(
    () => parseForgeEvent(JSON.stringify({ ...valid, type: "unknown" })),
    /invalid/i,
  );
  assert.throws(
    () =>
      parseForgeEvent(JSON.stringify({ ...valid, text: "x".repeat(100_001) })),
    /invalid|bound/i,
  );
  assert.throws(
    () =>
      parseForgeEvent(
        JSON.stringify({
          ...valid,
          text: "bad" + String.fromCharCode(0) + "value",
        }),
      ),
    /invalid|bound/i,
  );
  const checklist = {
    ...createEnvelope("agent.checklist", "session-1"),
    type: "agent.checklist",
    items: [
      {
        id: "inspect",
        label: "Inspect repository",
        expectation: "Relevant files are reviewed before mutation.",
        status: "active",
      },
    ],
  };
  assert.equal(isForgeEvent(checklist), true);
  assert.deepEqual(parseForgeEvent(JSON.stringify(checklist)), checklist);
  assert.throws(
    () =>
      parseForgeEvent(
        JSON.stringify({
          ...checklist,
          items: [
            {
              ...checklist.items[0],
              expectation: "x".repeat(501),
            },
          ],
        }),
      ),
    /invalid|bound/i,
  );
  const delegation = {
    ...createEnvelope("agent.delegation", "session-1"),
    type: "agent.delegation",
    role: "reviewer",
    status: "completed",
    turns: 1,
    text: "bounded review",
    budget: {
      profile: "balanced",
      plannedRoles: 4,
      usedRoles: 4,
      plannedTurns: 8,
      usedTurns: 4,
      contextChars: 1200,
      outputChars: 800,
      skippedRoles: [],
    },
  };
  assert.equal(isForgeEvent(delegation), true);
  const repair = {
    ...createEnvelope("agent.repair", "session-1"),
    type: "agent.repair",
    attempt: 4,
    maxAttempts: 4,
    strategy: "deep-thinking",
    status: "started",
    reason: "Alternate attempts did not resolve the bounded failure.",
  };
  assert.equal(isForgeEvent(repair), true);
  assert.throws(
    () => parseForgeEvent(JSON.stringify({ ...repair, attempt: 5 })),
    /invalid|bound/i,
  );
  assert.throws(
    () => parseForgeEvent(JSON.stringify({ ...repair, maxAttempts: 5 })),
    /invalid|bound/i,
  );
  assert.throws(
    () =>
      parseForgeEvent(
        JSON.stringify({
          ...delegation,
          budget: { ...delegation.budget, outputChars: 100_001 },
        }),
      ),
    /invalid|bound/i,
  );
  const state = {
    ...createEnvelope("agent.state", "session-1"),
    type: "agent.state",
    phase: "targeted-verify",
    status: "active",
    stepIndex: 1,
    totalSteps: 4,
    artifact: "targeted-verification",
    artifactId: "targeted-verify-1",
    entryConditions: ["A mutation result succeeded."],
    requiredArtifact: "A targeted syntax or focused behavior check.",
    exitCondition: "The check returns exit code 0.",
    failureTransition: "Enter repair with bounded failure evidence.",
    note: "Awaiting targeted verification.",
    budget: {
      providerTurns: 2,
      maxProviderTurns: 64,
      toolCalls: 5,
      maxToolCalls: 128,
      repairAttempts: 0,
      maxRepairAttempts: 4,
    },
  };
  assert.equal(isForgeEvent(state), true);
  assert.deepEqual(parseForgeEvent(JSON.stringify(state)), state);
  assert.throws(
    () => parseForgeEvent(JSON.stringify({ ...state, phase: "unknown" })),
    /invalid/i,
  );
  assert.throws(
    () =>
      parseForgeEvent(
        JSON.stringify({
          ...state,
          budget: { ...state.budget, maxToolCalls: 999 },
        }),
      ),
    /invalid|bound/i,
  );
});

test("v0.9 sessions persist journals and classify safe recovery decisions", async () => {
  const workspace = await tempWorkspace();
  const stateHome = await mkdtemp(path.join(os.tmpdir(), "forge-v07-state-"));
  const sessionDirectory = path.join(stateHome, "forge", "sessions");
  try {
    const supervisor = new ForgeSupervisor(new SessionStore(sessionDirectory));
    const result = await supervisor.run({
      prompt: "Explain this repository",
      workspace,
      record: true,
    });
    const record = await new SessionStore(sessionDirectory).read(
      result.sessionId,
    );
    assert.equal(record.status, "completed");
    assert.match(record.workspaceFingerprint ?? "", /^[a-f0-9]{64}$/);
    assert.ok(record.journal.length >= 4);
    assert.ok(record.journal.some((entry) => entry.status === "complete"));
    assert.ok(record.journal.some((entry) => entry.status === "pending"));
    assert.ok(record.scratchpad.some((item) => item.key === "current-step"));
    assert.equal(record.executionState?.phase, "summarize");
    assert.equal(record.executionState?.status, "completed");
    assert.equal(record.executionState?.artifact, "completion-summary");
    assert.ok((record.executionState?.budget.maxToolCalls ?? 0) > 0);
    assert.ok(record.checklist.some((item) => item.id === "inspect"));
    assert.ok(record.checklist.some((item) => item.expectation.length > 0));
    const start = record.events.find((event) => event.type === "session.start");
    assert.equal(start?.type, "session.start");
    assert.equal(start?.workspaceFingerprint, record.workspaceFingerprint);
    record.status = "interrupted";
    await new SessionStore(sessionDirectory).save(record);
    const cli = path.resolve("dist/apps/forge-cli/src/main.js");
    const unchanged = spawnSync(
      process.execPath,
      [cli, "session", "recovery", record.id],
      {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, XDG_STATE_HOME: stateHome },
      },
    );
    assert.equal(unchanged.status, 0);
    const unchangedAssessment = JSON.parse(unchanged.stdout);
    assert.equal(unchangedAssessment.decision, "continue");
    assert.equal(unchangedAssessment.reasonCode, "unchanged-active-step");
    assert.equal(unchangedAssessment.nextAction, "resume");
    record.workspaceFingerprint = undefined;
    await new SessionStore(sessionDirectory).save(record);
    const legacy = spawnSync(
      process.execPath,
      [cli, "session", "recovery", record.id],
      {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, XDG_STATE_HOME: stateHome },
      },
    );
    assert.equal(legacy.status, 0);
    const legacyAssessment = JSON.parse(legacy.stdout);
    assert.equal(legacyAssessment.decision, "re-plan");
    assert.equal(legacyAssessment.reasonCode, "legacy-session");
    assert.equal(legacyAssessment.workspaceChanged, false);
    record.workspaceFingerprint = start?.workspaceFingerprint;
    await new SessionStore(sessionDirectory).save(record);
    await writeFile(path.join(workspace, "README.md"), "changed after plan\n");
    const resumed = spawnSync(
      process.execPath,
      [cli, "session", "resume", record.id],
      {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, XDG_STATE_HOME: stateHome },
      },
    );
    assert.equal(resumed.status, 2);
    assert.match(resumed.stderr, /Workspace state changed/i);
    const assessed = await new SessionStore(sessionDirectory).read(record.id);
    assert.equal(assessed.recovery?.decision, "manual-intervention");
    assert.equal(assessed.recovery?.reasonCode, "workspace-drift");
    assert.equal(assessed.recovery?.nextAction, "inspect-workspace");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
});

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
        recipes: {
          contextGlobs: ["src/**/*.ts"],
          verification: [["npm", "run", "test"]],
        },
      }),
    );
    const manifests = await loadExtensionManifests(directory);
    assert.deepEqual(manifests[0], {
      id: "sample",
      version: "1.0.0",
      protocol: 1,
      capabilities: ["context"],
      recipes: {
        contextGlobs: ["src/**/*.ts"],
        verification: [["npm", "run", "test"]],
      },
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
    await rm(path.join(directory, "bad.json"));
    await writeFile(
      path.join(directory, "unsafe.json"),
      JSON.stringify({
        id: "unsafe",
        version: "1.0.0",
        protocol: 1,
        capabilities: ["context"],
        recipes: {
          contextGlobs: ["src" + String.fromCharCode(0) + "/*.ts"],
          verification: [["npm", "run", "test"]],
        },
      }),
    );
    await assert.rejects(
      loadExtensionManifests(directory),
      /invalid context recipes/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("autonomy profiles are bounded and default to approval-gated local testing", () => {
  assert.deepEqual(getAutonomyProfile().allowedRisks, [
    "read-only",
    "reversible-write",
    "local-execution",
  ]);
  assert.deepEqual(getAutonomyProfile("research").allowedRisks, ["read-only"]);
  assert.equal(listAutonomyProfiles().length, 4);
  assert.throws(
    () => getAutonomyProfile("unrestricted"),
    /Unknown autonomy profile/,
  );
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
    const shellDenied = await tools.execute({
      tool: "process.run",
      arguments: {
        command: process.execPath,
        args: ["-e", "process.stdout.write('unexpected')"],
        shell: true,
      },
    });
    assert.equal(shellDenied.ok, false);
    assert.match(shellDenied.error?.message ?? "", /allowShell=true/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP client bounds untrusted child output and drains stderr", async () => {
  const script =
    "process.stderr.write('x'.repeat(2000000)); process.stdout.write('x'.repeat(1000001));";
  const client = new McpStdioClient(
    {
      id: "output-limit",
      command: process.execPath,
      args: ["-e", script],
      enabled: true,
      explicitConsent: true,
      trust: "untrusted",
      defaultRisk: "network",
    },
    3000,
  );
  try {
    await assert.rejects(client.start(), /response exceeds|exited|timed out/i);
  } finally {
    client.close();
  }
});

test("worker imports remain isolated from the workspace Python tree", async () => {
  const directory = await tempWorkspace();
  const state = await mkdtemp(path.join(os.tmpdir(), "forge-worker-state-"));
  try {
    await mkdir(path.join(directory, "python", "forge_agent"), {
      recursive: true,
    });
    await writeFile(
      path.join(directory, "python", "forge_agent", "worker.py"),
      'from pathlib import Path; Path("hijack-marker").write_text("unexpected", encoding="utf-8")\n',
    );
    const cli = path.resolve("dist/apps/forge-cli/src/main.js");
    const result = spawnSync(process.execPath, [cli, "doctor"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, XDG_STATE_HOME: state },
    });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(readFile(path.join(directory, "hijack-marker")));
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("CLI startup failures are bounded for invalid workspaces and interpreters", async () => {
  const directory = await tempWorkspace();
  const state = await mkdtemp(path.join(os.tmpdir(), "forge-startup-state-"));
  try {
    const cli = path.resolve("dist/apps/forge-cli/src/main.js");
    const missing = spawnSync(
      process.execPath,
      [cli, "plan", "inspect", "--workspace", path.join(directory, "missing")],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /workspace does not exist/i);
    assert.doesNotMatch(missing.stderr, /Unhandled 'error' event/);
    const interpreter = spawnSync(
      process.execPath,
      [cli, "plan", "inspect", "--workspace", directory],
      {
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          XDG_STATE_HOME: state,
          FORGE_PYTHON: "forge-python-does-not-exist",
        },
      },
    );
    assert.equal(interpreter.status, 1);
    assert.match(
      interpreter.stderr,
      /spawn forge-python-does-not-exist ENOENT/,
    );
    assert.doesNotMatch(interpreter.stderr, /Unhandled 'error' event/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("session records reject traversal and redact process argument secrets", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "forge-session-audit-"));
  try {
    const store = new SessionStore(state);
    const record = await store.create("/tmp/fixture");
    await store.append(record, {
      ...createEnvelope("tool.proposal", record.id),
      type: "tool.proposal",
      tool: "process.run",
      risk: "local-execution",
      arguments: {
        command: "curl",
        args: ["-H", "Authorization: Bearer sk-secret-token", "apiKey=abc123"],
      },
      reason: "audit",
    });
    const saved = JSON.stringify(await store.read(record.id));
    assert.doesNotMatch(saved, /sk-secret-token|abc123/);
    assert.match(saved, /REDACTED/);
    await store.append(record, {
      ...createEnvelope("agent.text", record.id),
      type: "agent.text",
      text: "secret=should-be-redacted",
    });
    for (let index = 0; index < 510; index += 1) {
      await store.append(record, {
        ...createEnvelope("agent.text", record.id),
        type: "agent.text",
        text: `event-${index}`,
      });
    }
    assert.equal(record.events.length, 500);
    const capped = JSON.stringify(await store.read(record.id));
    assert.doesNotMatch(capped, /should-be-redacted/);
    assert.match(capped, /event-509/);
    await assert.rejects(store.remove("../../outside"), /Invalid session ID/);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("MCP validator rejects actual NUL characters without launching servers", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "forge-mcp-audit-"));
  try {
    const config = path.join(state, "integrations.json");
    await writeFile(
      config,
      JSON.stringify({
        servers: [
          {
            id: "unsafe",
            command: "node" + String.fromCharCode(0) + "bad",
            args: [],
          },
        ],
      }),
    );
    const result = await validateExternalServerConfig(config);
    assert.equal(result.valid, false);
    assert.match(result.errors.join(" "), /command is invalid/);
    await writeFile(
      config,
      JSON.stringify({
        servers: [
          {
            id: "many",
            command: "node",
            args: Array.from({ length: 65 }, () => "x"),
          },
          { id: "large", command: "node", args: ["x".repeat(4_097)] },
          { id: "nul", command: "node", args: ["bad\0arg"] },
        ],
      }),
    );
    const unsafeArgs = await validateExternalServerConfig(config);
    assert.equal(unsafeArgs.valid, false);
    assert.equal(
      unsafeArgs.errors.filter((error) => /args/.test(error)).length,
      3,
    );
    await writeFile(config, "[]");
    const arrayRoot = await validateExternalServerConfig(config);
    assert.equal(arrayRoot.valid, false);
    assert.match(arrayRoot.errors.join(" "), /root must be an object/);
    await writeFile(config, JSON.stringify({ servers: {} }));
    const objectServers = await validateExternalServerConfig(config);
    assert.equal(objectServers.valid, false);
    assert.match(objectServers.errors.join(" "), /servers must be an array/);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("unified diffs honor trailing-newline markers", async () => {
  const directory = await tempWorkspace();
  try {
    const tools = new WorkspaceTools(directory);
    const addNewline = [
      "diff --git a/no-newline.txt b/no-newline.txt",
      "--- a/no-newline.txt",
      "+++ b/no-newline.txt",
      "@@ -1 +1 @@",
      "-hello",
      "\\ No newline at end of file",
      "+hello",
      "",
    ].join("\n");
    await writeFile(path.join(directory, "no-newline.txt"), "hello");
    const first = await tools.execute({
      tool: "workspace.apply_unified_diff",
      arguments: { diff: addNewline },
    });
    assert.equal(first.ok, true);
    assert.equal(
      await readFile(path.join(directory, "no-newline.txt"), "utf8"),
      "hello\n",
    );
    const removeNewline = [
      "diff --git a/no-newline.txt b/no-newline.txt",
      "--- a/no-newline.txt",
      "+++ b/no-newline.txt",
      "@@ -1 +1 @@",
      "-hello",
      "+hello",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const second = await tools.execute({
      tool: "workspace.apply_unified_diff",
      arguments: { diff: removeNewline },
    });
    assert.equal(second.ok, true);
    assert.equal(
      await readFile(path.join(directory, "no-newline.txt"), "utf8"),
      "hello",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unified diff preview is read-only and reports stale conflicts", async () => {
  const directory = await tempWorkspace();
  try {
    const diff = [
      "diff --git a/app.txt b/app.txt",
      "--- a/app.txt",
      "+++ b/app.txt",
      "@@ -1 +1 @@",
      "-hello forge",
      "+hello v07",
      "",
    ].join("\n");
    const tools = new WorkspaceTools(directory);
    const preview = await tools.previewUnifiedDiff(diff);
    assert.equal(preview.safeToApply, true);
    assert.equal(preview.files[0].action, "modify");
    assert.equal(preview.files[0].conflict, null);
    assert.equal(
      await readFile(path.join(directory, "app.txt"), "utf8"),
      "hello forge\n",
    );
    await writeFile(path.join(directory, "app.txt"), "changed\n");
    const stale = await tools.previewUnifiedDiff(diff);
    assert.equal(stale.safeToApply, false);
    assert.match(stale.conflicts.join(" "), /current file|context|stale/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("selected change sets preview and apply only explicitly reviewed files", async () => {
  const directory = await tempWorkspace();
  try {
    const diff = [
      "diff --git a/app.txt b/app.txt",
      "--- a/app.txt",
      "+++ b/app.txt",
      "@@ -1 +1 @@",
      "-hello forge",
      "+hello selected",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,2 +1,2 @@",
      " # Fixture",
      "-This is a Forge fixture.",
      "+This is an unselected change.",
      "",
    ].join("\n");
    const tools = new WorkspaceTools(directory);
    const preview = await tools.previewUnifiedDiff(diff, ["app.txt"]);
    assert.equal(preview.safeToApply, true);
    assert.equal(preview.summary.files, 2);
    assert.equal(preview.summary.selectedFiles, 1);
    assert.equal(preview.files.filter((file) => file.selected).length, 1);
    assert.match(preview.changeSetDigest, /^[a-f0-9]{64}$/);
    const result = await tools.execute({
      tool: "workspace.apply_unified_diff",
      arguments: { diff, paths: ["app.txt"] },
    });
    assert.equal(result.ok, true);
    assert.equal(result.output.changeSetDigest, preview.changeSetDigest);
    assert.deepEqual(result.output.files, ["app.txt"]);
    assert.equal(
      await readFile(path.join(directory, "app.txt"), "utf8"),
      "hello selected\n",
    );
    assert.match(
      await readFile(path.join(directory, "README.md"), "utf8"),
      /This is a Forge fixture/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("policy explanations identify global and profile restrictions", () => {
  const policy = new PolicyEngine("safe", {
    denyRisks: ["reversible-write"],
  });
  const denied = policy.explain("reversible-write", "workspace.apply_patch");
  assert.equal(denied.allowed, false);
  assert.equal(denied.category, "denied");
  assert.equal(denied.nextAction, "review-policy");
  assert.match(denied.reasons.join(" "), /policy restriction/i);
  const approval = new PolicyEngine("safe").explain(
    "local-execution",
    "process.run",
  );
  assert.equal(approval.allowed, true);
  assert.equal(approval.approvalRequired, true);
  assert.equal(approval.category, "approval-required");
  assert.equal(approval.nextAction, "request-approval");
  const global = new PolicyEngine("unsafe").explain("network");
  assert.equal(global.allowed, false);
  assert.match(global.reasons.join(" "), /global safety ceiling/i);
});

test("workspace listing retains bounds for malformed numeric arguments", async () => {
  const directory = await tempWorkspace();
  try {
    await mkdir(path.join(directory, "many"));
    await Promise.all(
      Array.from({ length: 150 }, (_, index) =>
        writeFile(path.join(directory, "many", `${index}.txt`), "x"),
      ),
    );
    const result = await new WorkspaceTools(directory).execute({
      tool: "workspace.list",
      arguments: { limit: "not-a-number" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.output.length, 120);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("direct CLI entrypoint detection handles Windows paths", () => {
  assert.equal(
    isDirectInvocation(
      "file:///C:/Users/Keji/Downloads/forge-cli-main/dist/main.js",
      "C:\\Users\\Keji\\Downloads\\forge-cli-main\\dist\\main.js",
    ),
    true,
  );
  assert.equal(
    isDirectInvocation(
      "file:///C:/Users/Keji/Downloads/forge-cli-main/dist/main.js",
      "C:\\Users\\Keji\\Downloads\\forge-cli-main\\dist\\other.js",
    ),
    false,
  );
  assert.equal(
    isDirectInvocation("file:///tmp/forge/main.js", undefined),
    false,
  );
});

test("CLI numeric bounds parse, clamp, and reject malformed values", () => {
  const flags = { "max-agents": "2", "max-total-turns": "99" };
  assert.equal(boundedFlagInt(flags, "max-agents", 4, 1, 4), 2);
  assert.equal(boundedFlagInt(flags, "max-total-turns", 8, 1, 16), 16);
  assert.equal(boundedFlagInt({ value: "\\\\d" }, "value", 7, 1, 10), 7);
  assert.equal(boundedFlagInt({ value: "oops" }, "value", 7, 1, 10), 7);
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

test("ACP CLI stream rejects oversized input with a bounded exit", () => {
  const cli = path.resolve("dist/apps/forge-cli/src/main.js");
  const result = spawnSync(process.execPath, [cli, "acp", "serve"], {
    input: `${"x".repeat(1_000_001)}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /exceeds the 1000000-byte limit/);
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

test("repository index stores bounded metadata and can be cleared explicitly", async () => {
  const directory = await tempWorkspace();
  const state = await mkdtemp(path.join(os.tmpdir(), "forge-index-state-"));
  await writeFile(
    path.join(directory, "src.ts"),
    "export const answer = 42;\n",
  );
  await writeFile(
    path.join(directory, "src.test.ts"),
    "import { answer } from './src';\n",
  );
  await writeFile(
    path.join(directory, "consumer.ts"),
    "import { answer } from './src';\n",
  );
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = state;
  try {
    const index = await buildRepositoryIndex(directory);
    assert.equal(index.root, directory);
    assert.ok(index.files.length > 0);
    assert.ok(index.files.every((file) => !("content" in file)));
    assert.ok(index.scan.refreshed > 0);
    assert.ok(
      index.relationships.some(
        (relationship) => relationship.kind === "dependency",
      ),
    );
    assert.ok(
      index.relationships.some((relationship) => relationship.kind === "test"),
    );
    const second = await buildRepositoryIndex(directory);
    assert.ok(second.scan.reused > 0);
    await writeFile(path.join(directory, "app.txt"), "changed index\n");
    const third = await buildRepositoryIndex(directory);
    assert.ok(third.scan.refreshed > 0);
    const restored = await readRepositoryIndex(directory);
    assert.equal(restored.files.length, third.files.length);
    assert.equal(restored.version, 3);
    const query = (
      await import("../dist/apps/forge-cli/src/index.js")
    ).queryRepositoryIndex(restored, "answer");
    assert.ok(query.entries.some((entry) => entry.path === "src.ts"));
    assert.ok(query.relationships.length > 0);
    await clearRepositoryIndex(directory);
    await assert.rejects(readRepositoryIndex(directory));
  } finally {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    await rm(directory, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
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
    await writeFile(
      path.join(directory, "large.txt"),
      "large context ".repeat(5_000),
    );
    const compact = await buildRepositoryContext(directory, "large", {
      ...DEFAULT_CONTEXT_BUDGET,
      maxRelevantFiles: 4,
      maxFileChars: 3_000,
      maxTotalChars: 8_000,
    });
    assert.ok(compact.stats.includedChars <= 8_000);
    assert.ok(compact.stats.truncatedFiles >= 1);
    assert.ok(compact.stats.prunedFiles >= 0);
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

test("session approvals are scoped to the exact tool arguments", async () => {
  const directory = await tempWorkspace();
  try {
    const events = [];
    let approvals = 0;
    let revoke = false;
    const supervisor = new ForgeSupervisor();
    const result = await supervisor.run({
      prompt: "Create file scoped.txt",
      workspace: directory,
      onEvent: (event) => events.push(event),
      revokeApprovalScope: () => {
        const current = revoke;
        revoke = false;
        return current;
      },
      approve: async () => {
        approvals += 1;
        if (approvals === 1) {
          revoke = true;
          return "approve-session";
        }
        return "approve-once";
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(approvals, 3);
    const approvalEvents = events.filter(
      (event) => event.type === "approval.result" && event.category === "user",
    );
    assert.equal(approvalEvents[0].decision, "approve-session");
    assert.match(
      approvalEvents[0].scope?.argumentDigest ?? "",
      /^[a-f0-9]{64}$/,
    );
    assert.match(approvalEvents[0].scope?.expiresAt ?? "", /^20/);
    assert.ok(approvalEvents[0].scope?.paths?.includes("scoped.txt"));
    assert.equal(approvalEvents[1].decision, "approve-once");
    assert.equal(approvalEvents[1].scope, undefined);
    assert.equal(approvalEvents[2].decision, "approve-once");
    assert.equal(approvalEvents[2].scope, undefined);
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
    const scratchpad = events.find(
      (event) => event.type === "agent.scratchpad",
    );
    assert.ok(scratchpad);
    assert.ok(scratchpad.items.some((item) => item.key === "current-step"));
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

test("supervisor rejects premature mutation completion and continues to verified completion", async () => {
  const directory = await tempWorkspace();
  try {
    const events = [];
    const supervisor = new ForgeSupervisor();
    const result = await supervisor.run({
      prompt:
        "Create file gate.txt and make a premature completion claim before verification",
      workspace: directory,
      approveAll: true,
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.changedFiles, ["gate.txt"]);
    const graphEvents = events.filter((event) => event.type === "agent.graph");
    assert.ok(graphEvents.length >= 3);
    assert.match(graphEvents[0].steps[0].id, /^step-01-/);
    assert.equal(graphEvents[0].steps[0].contractValid, true);
    assert.equal(graphEvents.at(-1)?.status, "completed");
    assert.equal(graphEvents.at(-1)?.steps[0].status, "completed");
    assert.ok(
      events.some(
        (event) => event.type === "agent.state" && event.status === "blocked",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "agent.state" && event.phase === "targeted-verify",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "agent.state" && event.phase === "full-verify",
      ),
    );
    const completion = events.at(-1);
    assert.equal(completion?.type, "session.complete");
    assert.equal(completion?.status, "completed");
    assert.equal(completion?.checks.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("supervisor fails closed after bounded completion-gate rejection attempts", async () => {
  const directory = await tempWorkspace();
  try {
    const events = [];
    const result = await new ForgeSupervisor().run({
      prompt:
        "Create file loop.txt and make a premature completion claim in a gate loop",
      workspace: directory,
      approveAll: true,
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.status, "failed");
    assert.match(result.summary, /evidence-gate failures/i);
    const completions = events.filter(
      (event) => event.type === "session.complete",
    );
    assert.equal(completions.at(-1)?.status, "failed");
    assert.ok(
      events.filter(
        (event) => event.type === "agent.state" && event.status === "blocked",
      ).length >= 3,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("protocol validates dependency graph checkpoints and rejects malformed contracts", () => {
  const step = {
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
    status: "ready",
    contractValid: true,
    contractErrors: [],
  };
  const graph = {
    ...createEnvelope("agent.graph", "session-graph"),
    type: "agent.graph",
    version: 1,
    status: "validated",
    planArtifactId: "plan-1234567890abcdef",
    steps: [step],
    note: "Graph validated",
  };
  assert.equal(isForgeEvent(graph), true);
  assert.deepEqual(parseForgeEvent(JSON.stringify(graph)), graph);
  assert.throws(
    () =>
      parseForgeEvent(
        JSON.stringify({ ...graph, steps: [{ ...step, tests: [] }] }),
      ),
    /invalid/i,
  );
  assert.throws(
    () => parseForgeEvent(JSON.stringify({ ...graph, status: "running" })),
    /invalid/i,
  );
});

test("dependency graph persists and is exposed by forge inspect", async () => {
  const workspace = await tempWorkspace();
  const stateHome = await mkdtemp(path.join(os.tmpdir(), "forge-graph-state-"));
  const sessionDirectory = path.join(stateHome, "forge", "sessions");
  try {
    const result = await new ForgeSupervisor(
      new SessionStore(sessionDirectory),
    ).run({
      prompt: "Create file graph-persist.txt",
      workspace,
      approveAll: true,
      record: true,
    });
    assert.equal(result.status, "completed");
    const record = await new SessionStore(sessionDirectory).read(
      result.sessionId,
    );
    assert.equal(record.executionGraph?.status, "completed");
    assert.match(record.executionGraph?.steps[0]?.id ?? "", /^step-01-/);
    const inspect = spawnSync(
      process.execPath,
      [
        path.resolve("dist/apps/forge-cli/src/main.js"),
        "inspect",
        result.sessionId,
        "--output",
        "json",
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, XDG_STATE_HOME: stateHome },
      },
    );
    assert.equal(inspect.status, 0);
    const inspected = JSON.parse(inspect.stdout);
    assert.equal(inspected.executionGraph.status, "completed");
    assert.equal(
      inspected.executionGraph.steps[0].id,
      record.executionGraph.steps[0].id,
    );
    assert.equal(
      typeof inspected.contextPack.projectContract.language,
      "string",
    );
    assert.ok(Array.isArray(inspected.contextPack.acceptanceMap));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(stateHome, { recursive: true, force: true });
  }
});

test("context engine builds a hierarchical relevance pack instead of only larger file context", async () => {
  const directory = await tempWorkspace();
  try {
    await mkdir(path.join(directory, "src"));
    await mkdir(path.join(directory, "tests"));
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        scripts: { test: "node --test", build: "tsc -p tsconfig.json" },
        dependencies: { react: "18.0.0" },
      }),
    );
    await writeFile(
      path.join(directory, "src", "profile.ts"),
      "import { saveProfile } from './persistence';\nexport function updateProfile(name: string) { return saveProfile(name); }\n",
    );
    await writeFile(
      path.join(directory, "src", "persistence.ts"),
      "export function saveProfile(name: string) { localStorage.setItem('profile', name); }\n",
    );
    await writeFile(
      path.join(directory, "src", "routes.js"),
      "const app = {}; app.get('/profile', () => {});\n",
    );
    await writeFile(
      path.join(directory, "tests", "profile.test.ts"),
      "export function profileTest() { return true; }\n",
    );
    const context = await buildRepositoryContext(
      directory,
      "Implement profile persistence and verify profile behavior",
      { ...DEFAULT_CONTEXT_BUDGET, maxRelevantFiles: 12, maxSymbolSlices: 8 },
      {
        failureContext: [
          {
            tool: "process.run",
            command: "npm test",
            exitCode: 1,
            output: "profile assertion failed",
            changedFiles: ["src/profile.ts"],
          },
        ],
        attemptHistory: [
          {
            strategy: "alternate",
            reason: "Focused test failed",
            outcome: "failed",
          },
        ],
      },
    );
    assert.equal(context.contextPack.projectContract.framework, "react");
    assert.ok(
      context.contextPack.projectContract.testCommands.some(
        (command) => command.join(" ") === "npm run test",
      ),
    );
    assert.ok(context.contextPack.architectureMap.directories.includes("src"));
    assert.ok(
      context.contextPack.architectureMap.modules.some(
        (module) => module.path === "src/profile.ts",
      ),
    );
    assert.ok(
      context.contextPack.architectureMap.modules.some((module) =>
        module.routes.includes("GET /profile"),
      ),
    );
    assert.ok(
      context.contextPack.acceptanceMap[0].files.includes("src/profile.ts"),
    );
    assert.ok(
      context.contextPack.symbolSlices.some(
        (slice) => slice.symbol === "updateProfile",
      ),
    );
    assert.equal(context.contextPack.failureContext[0].exitCode, 1);
    assert.equal(context.contextPack.attemptHistory[0].strategy, "alternate");
    assert.ok(
      JSON.stringify(context.contextPack).length <
        DEFAULT_CONTEXT_BUDGET.maxTotalChars,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("supervisor carries bounded failure context and attempt history into provider context", async () => {
  const directory = await tempWorkspace();
  try {
    const events = [];
    const result = await new ForgeSupervisor().run({
      prompt: "Create file history.txt",
      workspace: directory,
      approveAll: true,
      failureContext: [
        {
          tool: "process.run",
          command: "npm test",
          exitCode: 1,
          output: "assertion failed token=should-not-leak",
          changedFiles: ["src/history.ts"],
        },
      ],
      attemptHistory: [
        {
          strategy: "focused-check",
          reason: "The focused check failed",
          outcome: "failed",
        },
      ],
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.status, "completed");
    const start = events.find((event) => event.type === "session.start");
    assert.equal(start?.context?.contextPack?.failureContext?.[0]?.exitCode, 1);
    assert.equal(
      start?.context?.contextPack?.attemptHistory?.[0]?.strategy,
      "focused-check",
    );
    assert.doesNotMatch(JSON.stringify(start?.context), /should-not-leak/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
