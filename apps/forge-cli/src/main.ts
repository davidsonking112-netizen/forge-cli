import { execFileSync } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type {
  ForgeEvent,
  RecoveryAssessment,
  ToolProposalEvent,
} from "../../../packages/protocol/src/index.js";
import { ForgeSupervisor } from "./supervisor.js";
import type { SessionRecord } from "./sessions.js";
import {
  buildRepositoryContext,
  fingerprintRepositoryContext,
} from "./context.js";
import { FullScreenTui } from "./tui.js";
import {
  AcpJsonlBridge,
  loadExternalServers,
  validateExternalServerConfig,
} from "./integrations.js";
import { PolicyEngine, TOOL_METADATA, WorkspaceTools } from "./tools.js";
import { McpStdioClient } from "./mcp.js";
import { summarizeUnifiedDiff } from "./diff.js";
import { loadPolicyPack } from "./policy.js";
import { loadExtensionManifests } from "./extensions.js";
import { prepareGitHubAction, runGitHubCommand } from "./github.js";
import { DaytonaClient } from "./daytona.js";
import { redactValue } from "./redaction.js";
import { errorReference } from "./error-codes.js";
import {
  getAutonomyProfile,
  listAutonomyProfiles,
  type AutonomyProfileName,
} from "./profiles.js";
import {
  buildRepositoryIndex,
  clearRepositoryIndex,
  queryRepositoryIndex,
  readRepositoryIndex,
} from "./index.js";

const VERSION = "0.9.9";

function usage(): string {
  return `Forge CLI v${VERSION}

Usage:
  forge [prompt]                         Start an interactive coding session
  forge plan <prompt>                    Explore and produce a read-only plan
  forge run --prompt <prompt>            Run a task with machine-readable output support
  forge init [--workspace <path>]         Run safe first-run onboarding checks
  forge doctor [--repair]                Check runtime; print safe repair guidance
  forge providers                         List supported provider configuration paths
  forge errors                            Print stable exit and error-code reference
  forge config show|path|set <key> <v>   Inspect or update local configuration
  forge prompt show|set|clear            Manage an optional user system prompt
  forge session list|recovery|resume|export|delete Manage local sessions
  forge verify <session-id>                 Inspect structured verification evidence
  forge audit <session-id>                   Review a redacted safety event log
  forge undo <checkpoint-id>              Restore a Forge-managed checkpoint
  forge git status|branch|stage|commit    Use approval-gated local Git workflows
  forge github status|connect|create|clone|push  Use explicit GitHub workflows
  forge daytona status|create|cleanup       Use optional Daytona sandboxes
  forge git prepare-pr [title]            Prepare a local review-ready PR draft
  forge mcp validate                       Validate MCP config without launching servers
  forge mcp list|enable|disable|tools|call Use explicitly enabled MCP stdio servers
  forge review <diff-file>                Inspect a unified diff without applying it
  forge preview-diff <diff-file>          Preview changes and report conflicts
  forge apply-diff <diff-file>            Apply a reviewed diff after approval
                                        (use --only path[,path] for file-level review)
  forge acp serve                          Adapt local ACP JSON-RPC lines safely
  forge policy validate <file>             Validate a stricter local policy pack
  forge policy effective [file]            Show the effective safety restrictions
  forge policy explain <risk> [tool]       Explain an allow/approval/deny decision
  forge context <prompt>                   Inspect selected context and checks
  forge profiles                           List bounded autonomy profiles
  forge index build|show|query|clear        Manage the opt-in local metadata index
  forge extensions list|inspect [id] [dir] Validate local extension manifests

Options:
  --output text|json     Select rendering mode (default: text)
  --workspace <path>     Set the approved workspace root
  --policy safe           Use the default approval policy (default)
  --simple               Disable the full-screen terminal workspace
  --multi-agent          Enable bounded explorer/implementer/tester/reviewer delegation
  --max-agents <n>       Limit delegated specialist roles (default: 4)
  --max-total-turns <n>  Limit total delegated provider turns (default: 8)
  --cost-profile <name>  Select economy|balanced|quality specialist budgets
  --no-record            Do not persist this session locally
  --policy-pack <file>   Load a deny-only policy pack for this run
  --profile <name>       Select a bounded autonomy profile
  --daytona-sandbox <id> Associate an existing Daytona sandbox with this run
  --daytona-cleanup stop|delete  Explicitly clean the associated sandbox after the run
  --help                 Show this help
  --version              Show the version
`;
}

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [first, ...rest] = argv;
  const knownCommands = new Set([
    "plan",
    "run",
    "init",
    "doctor",
    "providers",
    "errors",
    "config",
    "prompt",
    "session",
    "inspect",
    "audit",
    "verify",
    "undo",
    "integrations",
    "mcp",
    "review",
    "preview-diff",
    "apply-diff",
    "acp",
    "policy",
    "context",
    "profiles",
    "index",
    "extensions",
    "git",
    "github",
    "daytona",
    "help",
  ]);
  const command = first && knownCommands.has(first) ? first : "interactive";
  const args = command === "interactive" ? argv : rest;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    if (token.startsWith("--")) {
      const raw = token.slice(2);
      const equals = raw.indexOf("=");
      if (equals >= 0) {
        const key = raw.slice(0, equals);
        const value = raw.slice(equals + 1);
        if (key) flags[key] = value;
        continue;
      }
      const key = raw;
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function flagString(
  flags: Record<string, string | boolean>,
  key: string,
  fallback = "",
): string {
  const value = flags[key];
  return typeof value === "string" ? value : fallback;
}

function selectedDiffPaths(
  flags: Record<string, string | boolean>,
): string[] | undefined {
  const raw = flagString(flags, "only");
  if (!raw) return undefined;
  const paths = [
    ...new Set(
      raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.replaceAll("\\\\", "/")),
    ),
  ];
  if (
    !paths.length ||
    paths.length > 100 ||
    paths.some(
      (item) =>
        item.length > 1_024 ||
        path.posix.isAbsolute(item) ||
        item.includes("\0") ||
        path.posix
          .normalize(item)
          .split("/")
          .some((part) => part === ".."),
    )
  )
    throw new Error("--only requires 1 to 100 comma-separated relative paths");
  return paths.map((item) => path.posix.normalize(item));
}

export function boundedFlagInt(
  flags: Record<string, string | boolean>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = flags[key];
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function renderEvent(event: ForgeEvent, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  switch (event.type) {
    case "agent.text":
      console.log(`\n${event.text}`);
      break;
    case "agent.checklist":
      console.log("\nChecklist:");
      event.items.forEach((item) =>
        console.log(
          `  ${item.status === "complete" ? "✓" : item.status === "active" ? "→" : item.status === "blocked" ? "!" : "-"} ${item.label} — ${item.expectation}${item.note ? ` (${item.note})` : ""}`,
        ),
      );
      break;
    case "agent.repair":
      console.log(
        `\n[repair ${event.status}] attempt ${event.attempt}/${event.maxAttempts} (${event.strategy})`,
      );
      console.log(`Reason: ${event.reason}`);
      break;
    case "agent.plan":
      console.log("\nPlan:");
      console.log(`Goal: ${event.goal}`);
      event.steps.forEach((step) =>
        console.log(
          `  ${step.status === "active" ? "→" : "-"} ${step.description}`,
        ),
      );
      if (event.verification.length)
        console.log(`Verify: ${event.verification.join("; ")}`);
      break;
    case "tool.proposal":
      console.log(`\n[tool proposal] ${event.tool} (${event.risk})`);
      console.log(`Reason: ${event.reason}`);
      console.log(`Arguments: ${JSON.stringify(event.arguments)}`);
      break;
    case "tool.result":
      console.log(
        `[tool ${event.ok ? "ok" : "failed"}] ${event.tool} (${event.durationMs}ms)`,
      );
      if (!event.ok && event.error)
        console.log(`  ${event.error.code}: ${event.error.message}`);
      break;
    case "session.complete":
      console.log(
        `\n${event.status === "completed" ? "Completed" : event.status}: ${event.summary}`,
      );
      if (event.changedFiles.length)
        console.log(`Changed files: ${event.changedFiles.join(", ")}`);
      break;
    case "error":
      console.error(`[${event.error.code}] ${event.error.message}`);
      break;
    default:
      break;
  }
}

async function errorsCommand(args: ParsedArgs): Promise<number> {
  if (args.positional.length) {
    console.error("Usage: forge errors");
    return 2;
  }
  console.log(JSON.stringify(errorReference(), null, 2));
  return 0;
}

async function providersCommand(): Promise<number> {
  console.log(
    JSON.stringify(
      {
        offline: { provider: "mock", credentials: false },
        presets: [
          {
            name: "openai-compatible",
            key: "FORGE_API_KEY|OPENAI_API_KEY",
            baseUrl: "https://api.openai.com/v1",
          },
          {
            name: "openrouter",
            key: "OPENROUTER_API_KEY",
            baseUrl: "https://openrouter.ai/api/v1",
          },
          {
            name: "groq",
            key: "GROQ_API_KEY",
            baseUrl: "https://api.groq.com/openai/v1",
          },
          {
            name: "google-ai-studio",
            key: "GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_AI_STUDIO_API_KEY",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          },
          { name: "xai", key: "XAI_API_KEY", baseUrl: "https://api.x.ai/v1" },
        ],
        generic:
          "Set FORGE_PROVIDER=openai-compatible with FORGE_BASE_URL and FORGE_MODEL for another OpenAI-compatible service.",
        credentials:
          "Keys are read from the environment and never printed, persisted, or forwarded to the supervisor as protocol data.",
      },
      null,
      2,
    ),
  );
  return 0;
}

type InitCheckStatus = "pass" | "warn" | "fail";

interface InitCheck {
  id: string;
  label: string;
  status: InitCheckStatus;
  detail: string;
  next?: string;
}

function configFilePath(name: string): string {
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "forge",
    name,
  );
}

function providerInitCheck(): InitCheck {
  const provider = (process.env.FORGE_PROVIDER ?? "mock").toLowerCase();
  if (provider === "mock" || provider === "test")
    return {
      id: "provider",
      label: "Provider configuration",
      status: "pass",
      detail: `Using offline ${provider} provider; no credential is required.`,
    };
  const keyNames: Record<string, string[]> = {
    openrouter: ["OPENROUTER_API_KEY"],
    groq: ["GROQ_API_KEY"],
    gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_AI_STUDIO_API_KEY"],
    google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_AI_STUDIO_API_KEY"],
    "google-ai-studio": [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_AI_STUDIO_API_KEY",
    ],
    xai: ["XAI_API_KEY"],
    openai: ["FORGE_API_KEY", "OPENAI_API_KEY"],
    "openai-compatible": ["FORGE_API_KEY", "OPENAI_API_KEY"],
    compatible: ["FORGE_API_KEY", "OPENAI_API_KEY"],
  };
  const names = keyNames[provider] ?? ["FORGE_API_KEY", "OPENAI_API_KEY"];
  const configuredKey = names.find((name) => Boolean(process.env[name]));
  const baseUrl = process.env.FORGE_BASE_URL;
  const model = process.env.FORGE_MODEL;
  if (!configuredKey)
    return {
      id: "provider",
      label: "Provider configuration",
      status: "warn",
      detail: `${provider} is selected but no credential was found; no network request was made.`,
      next: `Set ${names.join(" or ")} or use FORGE_PROVIDER=mock for offline mode.`,
    };
  if (provider === "openai-compatible" || provider === "compatible") {
    if (!baseUrl || !model)
      return {
        id: "provider",
        label: "Provider configuration",
        status: "warn",
        detail:
          "Credential found, but the generic provider still needs FORGE_BASE_URL and FORGE_MODEL.",
        next: "Set a bounded HTTPS-compatible endpoint and model name; Forge init does not contact it.",
      };
  }
  return {
    id: "provider",
    label: "Provider configuration",
    status: "pass",
    detail: `The ${provider} credential is present in the environment; its value was not printed or persisted.`,
  };
}

async function initCommand(args: ParsedArgs): Promise<number> {
  const workspace = path.resolve(
    flagString(args.flags, "workspace") || process.cwd(),
  );
  const checks: InitCheck[] = [];
  const json = flagString(args.flags, "output") === "json";
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(
    nodeMajor >= 22
      ? {
          id: "node",
          label: "Node.js runtime",
          status: "pass",
          detail: `${process.version} detected; Forge requires Node.js 22 or newer.`,
        }
      : {
          id: "node",
          label: "Node.js runtime",
          status: "fail",
          detail: `${process.version} detected; Forge requires Node.js 22 or newer.`,
          next: "Install or select Node.js 22+ before running Forge.",
        },
  );
  const python =
    process.env.FORGE_PYTHON ??
    (process.platform === "win32" ? "python" : "python3");
  try {
    const version = execFileSync(python, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    const match = version.match(/(\d+)\.(\d+)/);
    const major = Number(match?.[1] ?? 0);
    const minor = Number(match?.[2] ?? 0);
    checks.push(
      major > 3 || (major === 3 && minor >= 11)
        ? {
            id: "python",
            label: "Python runtime",
            status: "pass",
            detail: `${version} detected.`,
          }
        : {
            id: "python",
            label: "Python runtime",
            status: "fail",
            detail: `${version} detected; Forge requires Python 3.11 or newer.`,
            next: "Install or select Python 3.11+ and set FORGE_PYTHON if needed.",
          },
    );
  } catch {
    checks.push({
      id: "python",
      label: "Python runtime",
      status: "fail",
      detail:
        "Python could not be executed; no package installation was attempted.",
      next: "Install Python 3.11+ or set FORGE_PYTHON to the intended interpreter.",
    });
  }
  try {
    const stat = await fs.lstat(workspace);
    if (!stat.isDirectory()) throw new Error("not a directory");
    await fs.access(workspace, fsConstants.R_OK | fsConstants.W_OK);
    checks.push({
      id: "workspace",
      label: "Approved workspace",
      status: "pass",
      detail: `${workspace} is a readable and writable directory.`,
    });
  } catch {
    checks.push({
      id: "workspace",
      label: "Approved workspace",
      status: "fail",
      detail: `${workspace} is not a readable and writable directory.`,
      next: "Choose an existing workspace with --workspace <path> and correct permissions.",
    });
  }
  checks.push(providerInitCheck());
  const mcpPath = configFilePath("integrations.json");
  try {
    const mcpStat = await fs.lstat(mcpPath);
    if (!mcpStat.isFile()) throw new Error("not a file");
    const validation = await validateExternalServerConfig(mcpPath);
    checks.push(
      validation.valid
        ? {
            id: "mcp",
            label: "MCP configuration",
            status: "pass",
            detail: `Configuration is valid with ${validation.servers} server definition(s); no server was launched.`,
          }
        : {
            id: "mcp",
            label: "MCP configuration",
            status: "fail",
            detail: validation.errors.join("; "),
            next: `Run forge mcp validate --config ${mcpPath} for the bounded validation report.`,
          },
    );
  } catch {
    checks.push({
      id: "mcp",
      label: "MCP configuration",
      status: "warn",
      detail: "No local MCP configuration is present; MCP remains disabled.",
      next: "Create integrations.json only when you intentionally configure a local stdio server.",
    });
  }
  try {
    const ghVersion = execFileSync("gh", ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    }).split("\n")[0];
    checks.push({
      id: "github",
      label: "GitHub CLI integration",
      status: "pass",
      detail: `${ghVersion}; no network authentication check was performed.`,
    });
  } catch {
    checks.push({
      id: "github",
      label: "GitHub CLI integration",
      status: "warn",
      detail: "GitHub CLI is not available; GitHub workflows remain optional.",
      next: "Install gh only if you intend to use Forge’s explicit GitHub workflows.",
    });
  }
  const daytonaConfigured = Boolean(process.env.DAYTONA_API_KEY);
  checks.push(
    daytonaConfigured
      ? {
          id: "daytona",
          label: "Daytona integration",
          status: "warn",
          detail:
            "A Daytona credential is present in the environment; no remote request was made.",
          next: "Use forge daytona status only when you intentionally want to contact the configured endpoint.",
        }
      : {
          id: "daytona",
          label: "Daytona integration",
          status: "warn",
          detail:
            "Daytona is not configured; the optional integration is inactive.",
          next: "Set DAYTONA_API_KEY only when you intentionally enable Daytona workflows.",
        },
  );
  const failed = checks.filter((check) => check.status === "fail");
  if (json) {
    console.log(JSON.stringify({ workspace, readOnly: true, checks }, null, 2));
  } else {
    console.log("Forge CLI onboarding (read-only)");
    console.log(
      "No packages installed, credentials stored, servers launched, or remote actions performed.\n",
    );
    for (const check of checks) {
      const marker =
        check.status === "pass"
          ? "PASS"
          : check.status === "warn"
            ? "WARN"
            : "FAIL";
      console.log(`[${marker}] ${check.label}: ${check.detail}`);
      if (check.next) console.log(`       Next: ${check.next}`);
    }
    console.log(
      `\nResult: ${failed.length ? `${failed.length} check(s) need attention.` : "Core checks are ready; review warnings before using optional integrations."}`,
    );
  }
  return failed.length ? 1 : 0;
}

async function doctor(args?: ParsedArgs): Promise<number> {
  console.log(`Forge CLI ${VERSION}`);
  console.log(`Platform: ${os.platform()} ${os.arch()}`);
  if (args?.flags.repair === true) {
    console.log(
      "Repair mode is guidance-only; Forge will not install packages or modify the workspace.",
    );
    console.log(
      "Recommended checks: npm ci; python3 -m pip install --user .; npm run typecheck; npm test",
    );
    console.log("Set FORGE_PYTHON if python3 is not the intended interpreter.");
  }
  console.log(`Node.js: ${process.version}`);
  try {
    const python =
      process.env.FORGE_PYTHON ??
      (process.platform === "win32" ? "python" : "python3");
    console.log(
      `Python: ${execFileSync(python, ["--version"], { encoding: "utf8" }).trim()}`,
    );
  } catch {
    console.error(
      "Python: unavailable; install Python 3.11+ or set FORGE_PYTHON",
    );
    return 1;
  }
  const supervisor = new ForgeSupervisor();
  const result = await supervisor.run({
    prompt: "doctor",
    workspace: process.cwd(),
    onEvent: (event) => {
      if (event.type === "error") renderEvent(event, false);
    },
  });
  console.log(
    `Worker: ${result.status === "completed" ? "ready" : "not ready"}`,
  );
  console.log(`Session data: ${supervisor.getSessionPath()}`);
  return result.status === "completed" ? 0 : 1;
}

async function readRestrictedFile(target: string): Promise<string | null> {
  const stat = await fs.lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(
      `Refusing to read non-regular configuration file: ${target}`,
    );
  return fs.readFile(target, "utf8");
}

async function writeRestrictedFile(
  target: string,
  content: string,
): Promise<void> {
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function systemPromptPath(): string {
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "forge",
    "system-prompt.txt",
  );
}

async function loadSystemPrompt(): Promise<string | undefined> {
  const content = await readRestrictedFile(systemPromptPath());
  return content ? content.slice(0, 20_000) : undefined;
}

async function promptCommand(args: ParsedArgs): Promise<number> {
  const action = args.positional[0] ?? "show";
  const promptPath = systemPromptPath();
  if (action === "show") {
    const content = await readRestrictedFile(promptPath);
    if (content === null) {
      console.log("No user system prompt configured.");
      return 0;
    }
    process.stdout.write(content);
    if (!content.endsWith("\n")) process.stdout.write("\n");
    return 0;
  }
  if (action === "clear") {
    await fs.unlink(promptPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    console.log("User system prompt cleared.");
    return 0;
  }
  if (action === "set") {
    const file = flagString(args.flags, "file");
    const content = file
      ? await fs.readFile(path.resolve(file), "utf8")
      : args.positional.slice(1).join(" ");
    if (!content.trim() || content.length > 20_000 || content.includes("\0")) {
      console.error(
        "A user system prompt must contain 1-20000 safe characters.",
      );
      return 2;
    }
    await writeRestrictedFile(promptPath, content);
    console.log(`User system prompt saved to ${promptPath}`);
    return 0;
  }
  console.error("Usage: forge prompt show|set <text>|set --file <path>|clear");
  return 2;
}

async function configCommand(args: ParsedArgs): Promise<number> {
  const configPath = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "forge",
    "config.json",
  );
  if (args.positional[0] === "path") {
    console.log(configPath);
    return 0;
  }
  if (args.positional[0] === "show" || !args.positional[0]) {
    const content = (await readRestrictedFile(configPath)) ?? "{}";
    const parsed = JSON.parse(content) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      const value = redactValue(parsed[key]);
      console.log(
        `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
      );
    }
    return 0;
  }
  if (args.positional[0] === "set") {
    const key = args.positional[1];
    const value = args.positional[2];
    if (!key || value === undefined) {
      console.error("Usage: forge config set <key> <value>");
      return 2;
    }
    const content = (await readRestrictedFile(configPath)) ?? "{}";
    const parsed = JSON.parse(content) as Record<string, unknown>;
    parsed[key] = value;
    await writeRestrictedFile(configPath, JSON.stringify(parsed, null, 2));
    console.log(`Updated ${key}`);
    return 0;
  }
  console.error("Usage: forge config show|path|set <key> <value>");
  return 2;
}

async function assessRecovery(
  record: SessionRecord,
  prompt: string,
): Promise<RecoveryAssessment> {
  const activeStep = record.journal.find(
    (entry) =>
      entry.status === "active" || entry.status === "awaiting-approval",
  );
  const nextStep =
    activeStep ?? record.journal.find((entry) => entry.status === "pending");
  const completed = record.status === "completed";
  let assessment: RecoveryAssessment = {
    sourceSessionId: record.id,
    decision: completed || !nextStep ? "re-plan" : "continue",
    reasonCode: completed
      ? "completed-session"
      : nextStep
        ? "unchanged-active-step"
        : "unchanged-no-active-step",
    ...(nextStep ? { stepId: nextStep.stepId } : {}),
    reason: completed
      ? "The source session completed; start a fresh bounded plan instead of replaying it."
      : nextStep
        ? `Continue from the recorded step: ${nextStep.description}`
        : "No active step was recorded; create a fresh bounded plan.",
    workspaceChanged: false,
    nextAction: completed || !nextStep ? "re-plan" : "resume",
  };
  const workspaceStat = await fs.stat(record.workspace).catch(() => null);
  if (!workspaceStat?.isDirectory()) {
    return {
      ...assessment,
      decision: "manual-intervention",
      reasonCode: "workspace-missing",
      reason: "The recorded workspace is missing or is no longer a directory.",
      workspaceChanged: true,
      nextAction: "inspect-workspace",
    };
  }
  if (record.workspaceFingerprint) {
    const currentContext = await buildRepositoryContext(
      record.workspace,
      prompt,
    );
    const currentFingerprint = fingerprintRepositoryContext(currentContext);
    if (currentFingerprint !== record.workspaceFingerprint) {
      return {
        ...assessment,
        decision: "manual-intervention",
        reasonCode: "workspace-drift",
        reason:
          "Workspace state changed since this session; inspect the changes and re-plan before resuming.",
        workspaceChanged: true,
        nextAction: "inspect-workspace",
      };
    }
  } else {
    assessment = {
      ...assessment,
      decision: "re-plan",
      reasonCode: "legacy-session",
      reason:
        "This legacy session has no workspace fingerprint; begin a fresh bounded plan.",
      nextAction: "re-plan",
    };
  }
  return assessment;
}

async function sessionCommand(args: ParsedArgs): Promise<number> {
  const supervisor = new ForgeSupervisor();
  const action = args.positional[0] ?? "list";
  if (action === "list") {
    const sessions = await supervisor.listSessions();
    if (!sessions.length) console.log("No Forge sessions found.");
    for (const session of sessions)
      console.log(`${session.id}  ${session.updatedAt}  ${session.workspace}`);
    return 0;
  }
  const id = args.positional[1];
  if (!id) {
    console.error(`Usage: forge session ${action} <id>`);
    return 2;
  }
  if (action === "delete") {
    await supervisor.removeSession(id);
    console.log(`Deleted ${id}`);
    return 0;
  }
  const record = await supervisor.readSession(id);
  if (action === "export") {
    console.log(JSON.stringify(record, null, 2));
    return 0;
  }
  if (action === "recovery") {
    const start = record.events.find((event) => event.type === "session.start");
    if (!start || start.type !== "session.start" || !start.prompt) {
      console.error(
        "This session does not contain enough data for recovery assessment",
      );
      return 1;
    }
    const assessment = await assessRecovery(record, start.prompt);
    console.log(JSON.stringify(assessment, null, 2));
    return assessment.decision === "manual-intervention" ? 2 : 0;
  }
  if (action === "resume") {
    const start = record.events.find((event) => event.type === "session.start");
    if (!start || start.type !== "session.start" || !start.prompt) {
      console.error("This session does not contain a resumable prompt");
      return 1;
    }
    const assessment = await assessRecovery(record, start.prompt);
    if (assessment.decision === "manual-intervention") {
      await supervisor.setRecoveryAssessment(record.id, assessment);
      console.error(assessment.reason);
      return 2;
    }
    await supervisor.setRecoveryAssessment(record.id, assessment);
    await supervisor.markSessionResumed(record.id);
    return runTask(
      {
        command: "interactive",
        positional: [start.prompt],
        flags: { workspace: record.workspace },
      },
      assessment,
    );
  }
  console.error("Usage: forge session list|recovery|resume|export|delete <id>");
  return 2;
}

async function auditCommand(args: ParsedArgs): Promise<number> {
  const sessionId = args.positional[0];
  if (!sessionId) {
    console.error("Usage: forge audit <session-id>");
    return 2;
  }
  try {
    const session = await new ForgeSupervisor().readSession(sessionId);
    const entries = session.events.map((event) => {
      switch (event.type) {
        case "session.start":
          return {
            timestamp: event.timestamp,
            type: event.type,
            workspace: event.workspace,
            provider: event.provider,
            policy: event.policy,
            profile: event.profile ?? null,
            workspaceFingerprint: event.workspaceFingerprint ?? null,
          };
        case "agent.text":
          return {
            timestamp: event.timestamp,
            type: event.type,
            text: String(redactValue(event.text.slice(0, 1_000))),
          };
        case "agent.plan":
          return {
            timestamp: event.timestamp,
            type: event.type,
            goal: event.goal,
            steps: event.steps,
          };
        case "agent.checklist":
          return {
            timestamp: event.timestamp,
            type: event.type,
            items: event.items,
          };
        case "agent.scratchpad":
          return {
            timestamp: event.timestamp,
            type: event.type,
            items: event.items,
          };
        case "agent.delegation":
          return {
            timestamp: event.timestamp,
            type: event.type,
            role: event.role,
            status: event.status,
            turns: event.turns,
            budget: event.budget ?? null,
            error: event.error ?? null,
          };
        case "agent.repair":
          return {
            timestamp: event.timestamp,
            type: event.type,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            strategy: event.strategy,
            status: event.status,
            reason: event.reason,
          };
        case "tool.proposal":
          return {
            timestamp: event.timestamp,
            type: event.type,
            tool: event.tool,
            risk: event.risk,
            reason: event.reason,
            arguments: redactValue(event.arguments),
          };
        case "approval.result":
          return {
            timestamp: event.timestamp,
            type: event.type,
            proposalId: event.proposalId,
            decision: event.decision,
            category: event.category ?? null,
          };
        case "tool.result":
          return {
            timestamp: event.timestamp,
            type: event.type,
            tool: event.tool,
            ok: event.ok,
            approved: event.approved,
            durationMs: event.durationMs,
            error: event.error
              ? {
                  code: event.error.code,
                  retryable: event.error.retryable,
                  message: String(redactValue(event.error.message)),
                }
              : null,
          };
        case "session.complete":
          return {
            timestamp: event.timestamp,
            type: event.type,
            status: event.status,
            summary: String(redactValue(event.summary)),
            changedFiles: event.changedFiles,
            checks: event.checks.map((check) => ({
              command: check.command,
              ok: check.ok,
              status: check.status ?? null,
              exitCode: check.exitCode,
            })),
          };
        case "error":
          return {
            timestamp: event.timestamp,
            type: event.type,
            code: event.error.code,
            retryable: event.error.retryable,
            message: String(redactValue(event.error.message)),
          };
        case "user.prompt":
          return {
            timestamp: event.timestamp,
            type: event.type,
            prompt: String(redactValue(event.prompt.slice(0, 1_000))),
          };
        case "session.cancel":
          return {
            timestamp: event.timestamp,
            type: event.type,
            reason: event.reason,
          };
      }
    });
    console.log(
      JSON.stringify(
        {
          sessionId: session.id,
          status: session.status,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          eventCount: entries.length,
          redacted: true,
          entries,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function verifyCommand(args: ParsedArgs): Promise<number> {
  const sessionId = args.positional[0];
  if (!sessionId) {
    console.error("Usage: forge verify <session-id>");
    return 2;
  }
  try {
    const session = await new ForgeSupervisor().readSession(sessionId);
    let stale = false;
    let currentFingerprint: string | undefined;
    if (session.workspaceFingerprint) {
      const context = await buildRepositoryContext(
        session.workspace,
        session.plan?.goal ?? "verification",
      );
      currentFingerprint = fingerprintRepositoryContext(context);
      stale = currentFingerprint !== session.workspaceFingerprint;
    }
    const evidence = session.verification.map((check) => ({
      ...check,
      status:
        stale && check.status === "passed"
          ? "stale"
          : (check.status ?? (check.ok ? "passed" : "failed")),
    }));
    const evidenceDigest = createHash("sha256")
      .update(JSON.stringify(evidence))
      .digest("hex");
    console.log(
      JSON.stringify(
        {
          sessionId: session.id,
          workspace: session.workspace,
          stale,
          recordedFingerprint: session.workspaceFingerprint,
          currentFingerprint,
          replayed: false,
          evidenceDigest,
          nextAction: stale ? "review-workspace-before-rerun" : "none",
          evidence,
        },
        null,
        2,
      ),
    );
    return evidence.length > 0 &&
      evidence.every((check) => check.status === "passed")
      ? 0
      : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function inspectCommand(args: ParsedArgs): Promise<number> {
  const sessionId = args.positional[0];
  if (!sessionId) {
    console.error("Usage: forge inspect <session-id>");
    return 2;
  }
  try {
    const session = await new ForgeSupervisor().readSession(sessionId);
    const counts: Record<string, number> = {};
    const toolMetrics: Record<
      string,
      { count: number; failures: number; totalMs: number }
    > = {};
    const approvalCounts: Record<string, number> = {};
    const delegation: Array<{ role: string; status: string; turns: number }> =
      [];
    const repairs: Array<{
      attempt: number;
      strategy: "alternate" | "deep-thinking";
      status: "started" | "succeeded" | "failed" | "exhausted";
      reason: string;
    }> = [];
    let delegationBudget:
      | {
          profile: "economy" | "balanced" | "quality";
          plannedRoles: number;
          usedRoles: number;
          plannedTurns: number;
          usedTurns: number;
          contextChars: number;
          outputChars: number;
          skippedRoles: string[];
        }
      | undefined;
    let checks: Array<{
      command: string;
      ok: boolean;
      exitCode: number | null;
    }> = [];
    let provider: string | undefined;
    let profile: string | undefined;
    for (const event of session.events) {
      counts[event.type] = (counts[event.type] ?? 0) + 1;
      if (event.type === "session.start") {
        provider = event.provider;
        profile = event.profile;
      }
      if (event.type === "tool.result") {
        const metric = (toolMetrics[event.tool] ??= {
          count: 0,
          failures: 0,
          totalMs: 0,
        });
        metric.count += 1;
        metric.totalMs += event.durationMs;
        if (!event.ok) metric.failures += 1;
      }
      if (event.type === "approval.result")
        approvalCounts[event.decision] =
          (approvalCounts[event.decision] ?? 0) + 1;
      if (event.type === "agent.repair") {
        repairs.push({
          attempt: event.attempt,
          strategy: event.strategy,
          status: event.status,
          reason: event.reason,
        });
      }
      if (event.type === "agent.delegation") {
        delegation.push({
          role: event.role,
          status: event.status,
          turns: event.turns,
        });
        if (event.budget) delegationBudget = event.budget;
      }
      if (event.type === "session.complete")
        checks = event.checks.map((check) => ({
          command: check.command,
          ok: check.ok,
          exitCode: check.exitCode,
        }));
    }
    console.log(
      JSON.stringify(
        {
          id: session.id,
          workspace: session.workspace,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          provider,
          profile,
          status: session.status,
          resumeCount: session.resumeCount,
          workspaceFingerprint: session.workspaceFingerprint,
          recovery: session.recovery,
          scratchpad: session.scratchpad,
          checklist: session.checklist,
          plan: session.plan,
          journal: session.journal,
          verification: session.verification,
          eventCount: session.events.length,
          eventTypes: counts,
          toolMetrics,
          approvalCounts,
          delegation,
          repairs,
          delegationBudget: delegationBudget ?? null,
          checks,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function gitCommand(args: ParsedArgs): Promise<number> {
  const action = args.positional[0] ?? "status";
  const workspace = path.resolve(
    flagString(args.flags, "workspace", process.cwd()),
  );
  const tools = new WorkspaceTools(workspace);
  if (action === "status") {
    const result = await tools.execute({ tool: "git.status", arguments: {} });
    console.log(JSON.stringify(result.output ?? result.error, null, 2));
    return result.ok ? 0 : 1;
  }
  if (action === "prepare-pr") {
    const result = await tools.execute({
      tool: "workspace.diff",
      arguments: {},
    });
    if (!result.ok) {
      console.error(JSON.stringify(result.error, null, 2));
      return 1;
    }
    const title =
      args.positional.slice(1).join(" ").trim() || "Forge changes for review";
    const diff =
      typeof result.output === "object" && result.output !== null
        ? String((result.output as { output?: unknown }).output ?? "")
        : "";
    let diffSummary: ReturnType<typeof summarizeUnifiedDiff> | null = null;
    try {
      if (diff.trim()) diffSummary = summarizeUnifiedDiff(diff);
    } catch {
      diffSummary = null;
    }
    const body = [
      "## Summary",
      "",
      "Prepared locally by Forge for review.",
      "",
      "## Verification",
      "",
      "- Review the generated diff before committing.",
      "- Run the project checks before submission.",
      "",
      "## Diff",
      "",
      "```diff",
      diff.slice(0, 80_000),
      "```",
    ].join("\\n");
    console.log(
      JSON.stringify(
        {
          title,
          body,
          summary: diffSummary,
          remoteAction: "none",
          verification: [
            "Review the generated diff before committing.",
            "Run the project checks before submission.",
          ],
        },
        null,
        2,
      ),
    );
    return 0;
  }
  let tool: "git.branch" | "git.stage" | "git.commit";
  let arguments_: Record<string, unknown>;
  if (action === "branch") {
    tool = "git.branch";
    arguments_ = { name: args.positional[1] };
  } else if (action === "stage") {
    tool = "git.stage";
    arguments_ = { paths: args.positional.slice(1) };
  } else if (action === "commit") {
    tool = "git.commit";
    arguments_ = { message: args.positional.slice(1).join(" ") };
  } else {
    console.error(
      "Usage: forge git status|branch <name>|stage <paths...>|commit <message>",
    );
    return 2;
  }
  if (!input.isTTY) {
    console.error(
      "Git mutations require an interactive terminal approval; remote pushes are never performed by this command.",
    );
    return 2;
  }
  const rl = createInterface({ input, output });
  try {
    console.log(`Proposed Git action: ${tool} ${JSON.stringify(arguments_)}`);
    const answer = (
      await rl.question("Approve this local Git action? Type YES to continue: ")
    ).trim();
    if (answer !== "YES") {
      console.log("Git action denied.");
      return 1;
    }
    const result = await tools.execute({ tool, arguments: arguments_ });
    console.log(JSON.stringify(result.output ?? result.error, null, 2));
    return result.ok ? 0 : 1;
  } finally {
    rl.close();
  }
}

async function githubCommand(args: ParsedArgs): Promise<number> {
  const action = (args.positional[0] ?? "status") as
    "status" | "connect" | "create" | "clone" | "push";
  if (!["status", "connect", "create", "clone", "push"].includes(action)) {
    console.error(
      "Usage: forge github status|connect|create <owner/name>|clone <owner/name> --destination <dir>|push [branch]",
    );
    return 2;
  }
  const workspace = path.resolve(
    flagString(args.flags, "workspace", process.cwd()),
  );
  try {
    const prepared = await prepareGitHubAction(action, workspace, {
      repository: args.positional[1],
      destination: flagString(args.flags, "destination"),
      branch: args.positional[1],
      push: args.flags.push === true,
    });
    if (action === "status") {
      const result = await runGitHubCommand(
        prepared.command,
        prepared.cwd,
        action,
      );
      console.log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    if (!input.isTTY) {
      console.error(
        "GitHub connection and remote repository actions require an interactive YES confirmation.",
      );
      return 2;
    }
    const rl = createInterface({ input, output });
    try {
      const displayed = prepared.command.join(" ");
      console.log(`Proposed GitHub action: ${displayed}`);
      const answer = (
        await rl.question(
          "This may authenticate, create, clone, or push to GitHub. Type YES to continue: ",
        )
      ).trim();
      if (answer !== "YES") {
        console.log("GitHub action denied.");
        return 1;
      }
      const result = await runGitHubCommand(
        prepared.command,
        prepared.cwd,
        action,
        true,
      );
      if (!result.ok) console.error(result.output);
      else console.log(result.output);
      return result.ok ? 0 : 1;
    } finally {
      rl.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function daytonaCommand(args: ParsedArgs): Promise<number> {
  const action = args.positional[0] ?? "status";
  const client = new DaytonaClient();
  if (action === "status") {
    const id = args.positional[1];
    const result = await client.getSandbox(id);
    console.log(
      JSON.stringify({ action, ...client.configuration(), ...result }, null, 2),
    );
    return result.ok ? 0 : 1;
  }
  if (action === "create") {
    if (!input.isTTY) {
      console.error(
        "Daytona sandbox creation requires an interactive terminal approval.",
      );
      return 2;
    }
    const rl = createInterface({ input, output });
    try {
      const answer = (
        await rl.question("Create a Daytona sandbox? Type YES to continue: ")
      ).trim();
      if (answer !== "YES") {
        console.log("Daytona sandbox creation denied.");
        return 1;
      }
    } finally {
      rl.close();
    }
    const language = flagString(args.flags, "language");
    if (
      language &&
      !["python", "typescript", "javascript"].includes(language)
    ) {
      console.error("--language must be python, typescript, or javascript");
      return 2;
    }
    const intervalRaw = args.flags["auto-delete-minutes"];
    const autoDeleteInterval =
      typeof intervalRaw === "string"
        ? boundedFlagInt(args.flags, "auto-delete-minutes", 0, -1, 43_200)
        : undefined;
    const result = await client.createSandbox({
      ...(flagString(args.flags, "snapshot")
        ? { snapshot: flagString(args.flags, "snapshot") }
        : {}),
      ...(flagString(args.flags, "image")
        ? { image: flagString(args.flags, "image") }
        : {}),
      ...(language
        ? { language: language as "python" | "typescript" | "javascript" }
        : {}),
      ...(autoDeleteInterval === undefined ? {} : { autoDeleteInterval }),
    });
    console.log(JSON.stringify({ action, ...result }, null, 2));
    return result.ok ? 0 : 1;
  }
  if (action === "cleanup") {
    const id = args.positional[1];
    const cleanup = flagString(args.flags, "action", "stop");
    if (!id || (cleanup !== "stop" && cleanup !== "delete")) {
      console.error(
        "Usage: forge daytona cleanup <sandbox-id> [--action stop|delete]",
      );
      return 2;
    }
    if (!input.isTTY) {
      console.error(
        "Daytona cleanup requires an interactive terminal approval; use status for read-only inspection.",
      );
      return 2;
    }
    const rl = createInterface({ input, output });
    try {
      const answer = (
        await rl.question(
          `Daytona ${cleanup} for ${id}? Type YES to continue: `,
        )
      ).trim();
      if (answer !== "YES") {
        console.log("Daytona cleanup denied.");
        return 1;
      }
    } finally {
      rl.close();
    }
    const result =
      cleanup === "delete"
        ? await client.deleteSandbox(id)
        : await client.stopSandbox(id);
    console.log(
      JSON.stringify({ action: cleanup, sandboxId: id, ...result }, null, 2),
    );
    return result.ok ? 0 : 1;
  }
  console.error(
    "Usage: forge daytona status [sandbox-id]|create|cleanup <sandbox-id> [--action stop|delete]",
  );
  return 2;
}

async function indexCommand(args: ParsedArgs): Promise<number> {
  const action = args.positional[0] ?? "show";
  const workspace = path.resolve(
    flagString(args.flags, "workspace", process.cwd()),
  );
  try {
    if (action === "build") {
      const index = await buildRepositoryIndex(workspace);
      console.log(
        JSON.stringify(
          {
            action,
            version: index.version,
            root: index.root,
            files: index.files.length,
            relationships: index.relationships.length,
            scan: index.scan,
            updatedAt: index.updatedAt,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    if (action === "show") {
      console.log(
        JSON.stringify(await readRepositoryIndex(workspace), null, 2),
      );
      return 0;
    }
    if (action === "query") {
      const query = args.positional.slice(1).join(" ").trim();
      const index = await readRepositoryIndex(workspace);
      console.log(JSON.stringify(queryRepositoryIndex(index, query), null, 2));
      return 0;
    }
    if (action === "clear") {
      await clearRepositoryIndex(workspace);
      console.log(
        JSON.stringify({ action, root: workspace, cleared: true }, null, 2),
      );
      return 0;
    }
    console.error(
      "Usage: forge index build|show|query <term>|clear [--workspace <path>]",
    );
    return 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function profilesCommand(args: ParsedArgs): Promise<number> {
  if (args.positional.length) {
    console.error("Usage: forge profiles");
    return 2;
  }
  console.log(JSON.stringify(listAutonomyProfiles(), null, 2));
  return 0;
}

async function contextCommand(args: ParsedArgs): Promise<number> {
  const prompt = args.positional.join(" ").trim();
  if (!prompt) {
    console.error("Usage: forge context <prompt> [--workspace <path>]");
    return 2;
  }
  try {
    const workspace = path.resolve(
      flagString(args.flags, "workspace", process.cwd()),
    );
    const context = await buildRepositoryContext(workspace, prompt);
    console.log(
      JSON.stringify(
        {
          root: context.root,
          projectType: context.projectType,
          packageManager: context.packageManager,
          changedFiles: context.changedFiles,
          contextStats: context.stats,
          relevantFiles: context.relevantFiles.map(
            ({ path: filePath, bytes, symbols, reasons }) => ({
              path: filePath,
              bytes,
              symbols,
              reasons,
            }),
          ),
          verificationCommands: context.verificationCommands,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function extensionsCommand(args: ParsedArgs): Promise<number> {
  const action = args.positional[0] ?? "list";
  if (action !== "list" && action !== "inspect") {
    console.error("Usage: forge extensions list|inspect [id] [directory]");
    return 2;
  }
  const directory = path.resolve(
    action === "inspect"
      ? (args.positional[2] ??
          path.join(
            process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
            "forge",
            "extensions",
          ))
      : (args.positional[1] ??
          path.join(
            process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
            "forge",
            "extensions",
          )),
  );
  try {
    const manifests = await loadExtensionManifests(directory);
    if (action === "inspect") {
      const id = args.positional[1];
      const manifest = manifests.find((item) => item.id === id);
      if (!manifest) {
        console.error(`Unknown extension manifest: ${id ?? "missing id"}`);
        return 1;
      }
      console.log(
        JSON.stringify(
          {
            id: manifest.id,
            version: manifest.version,
            capabilities: manifest.capabilities,
            execution: "inert-metadata-only",
            recipes: manifest.recipes ?? null,
            bounds: {
              maxContextGlobs: 16,
              maxVerificationRecipes: 8,
              maxArgumentsPerRecipe: 8,
              executable: false,
            },
          },
          null,
          2,
        ),
      );
      return 0;
    }
    console.log(JSON.stringify(manifests, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function policyCommand(args: ParsedArgs): Promise<number> {
  const action = args.positional[0];
  if (action === "explain") {
    const risk = args.positional[1];
    const validRisks = [
      "read-only",
      "reversible-write",
      "local-execution",
      "destructive",
      "network",
      "credential-sensitive",
    ] as const;
    if (!risk || !validRisks.includes(risk as (typeof validRisks)[number])) {
      console.error(
        "Usage: forge policy explain <risk> [tool] [--profile <name>]",
      );
      return 2;
    }
    const tool = args.positional[2];
    if (tool && !TOOL_METADATA[tool as keyof typeof TOOL_METADATA]) {
      console.error(`Unknown Forge tool: ${tool}`);
      return 2;
    }
    try {
      const profile = getAutonomyProfile(flagString(args.flags, "profile"));
      const packPath = flagString(args.flags, "policy-pack");
      const pack = packPath
        ? await loadPolicyPack(path.resolve(packPath))
        : null;
      const allRisks = [...validRisks];
      const profileDeniedRisks = allRisks.filter(
        (value) => !profile.allowedRisks.includes(value),
      );
      const policy = new PolicyEngine("safe", {
        denyRisks: [...profileDeniedRisks, ...(pack?.denyRisks ?? [])],
        ...(pack?.denyTools ? { denyTools: pack.denyTools } : {}),
      });
      console.log(
        JSON.stringify(
          {
            profile: profile.name,
            policyPack: pack?.id ?? null,
            decision: policy.explain(
              risk as (typeof validRisks)[number],
              tool as keyof typeof TOOL_METADATA | undefined,
            ),
          },
          null,
          2,
        ),
      );
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (action === "effective") {
    try {
      const pack = args.positional[1]
        ? await loadPolicyPack(path.resolve(args.positional[1]))
        : null;
      console.log(
        JSON.stringify(
          {
            globalSafetyCeiling: {
              deniedRisks: ["destructive", "network", "credential-sensitive"],
              deniedCapabilities: [
                "unrestricted-autonomy",
                "hidden-background-work",
                "remote-push",
              ],
            },
            policyPack: pack,
          },
          null,
          2,
        ),
      );
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (action !== "validate" || !args.positional[1]) {
    console.error(
      "Usage: forge policy validate <file> | effective [file] | explain <risk> [tool]",
    );
    return 2;
  }
  try {
    console.log(
      JSON.stringify(
        await loadPolicyPack(path.resolve(args.positional[1])),
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function acpCommand(args: ParsedArgs): Promise<number> {
  if (args.positional[0] !== "serve") {
    console.error("Usage: forge acp serve");
    return 2;
  }
  const bridge = new AcpJsonlBridge();
  const maxBytes = 1_000_000;
  const maxRequests = 200;
  let buffered = "";
  let totalBytes = 0;
  let requestCount = 0;
  const handleLine = (line: string): void => {
    if (!line.trim()) return;
    requestCount += 1;
    if (requestCount > maxRequests)
      throw new Error("ACP input exceeds the 200-request limit");
    process.stdout.write(`${bridge.handleLine(line)}\n`);
  };
  try {
    for await (const chunk of input) {
      const text = Buffer.from(chunk).toString("utf8");
      totalBytes += Buffer.byteLength(text, "utf8");
      if (totalBytes > maxBytes)
        throw new Error("ACP input exceeds the 1000000-byte limit");
      buffered += text;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        handleLine(buffered.slice(0, newline).replace(/\r$/, ""));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    }
    handleLine(buffered);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

async function previewDiffCommand(args: ParsedArgs): Promise<number> {
  const diffPath = args.positional[0];
  if (!diffPath) {
    console.error("Usage: forge preview-diff <diff-file>");
    return 2;
  }
  try {
    const diff = await fs.readFile(path.resolve(diffPath), "utf8");
    const workspace = path.resolve(
      flagString(args.flags, "workspace", process.cwd()),
    );
    const preview = await new WorkspaceTools(workspace).previewUnifiedDiff(
      diff,
      selectedDiffPaths(args.flags),
    );
    console.log(JSON.stringify(preview, null, 2));
    return preview.safeToApply ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function diffCommand(args: ParsedArgs, apply: boolean): Promise<number> {
  const diffPath = args.positional[0];
  if (!diffPath) {
    console.error(
      `Usage: forge ${apply ? "apply-diff" : "review"} <diff-file> [--workspace <path>]`,
    );
    return 2;
  }
  try {
    const diff = await fs.readFile(path.resolve(diffPath), "utf8");
    const summary = summarizeUnifiedDiff(diff);
    if (!apply) {
      console.log(JSON.stringify({ mode: "review", summary }, null, 2));
      return 0;
    }
    const workspace = path.resolve(
      flagString(args.flags, "workspace", process.cwd()),
    );
    const selectedPaths = selectedDiffPaths(args.flags);
    const tools = new WorkspaceTools(workspace);
    const preview = await tools.previewUnifiedDiff(diff, selectedPaths);
    if (!preview.safeToApply) {
      console.log(JSON.stringify({ mode: "apply", summary, preview }, null, 2));
      return 1;
    }
    if (!input.isTTY) {
      console.error(
        "Applying a unified diff requires an interactive terminal approval.",
      );
      return 2;
    }
    const rl = createInterface({ input, output });
    try {
      console.log(JSON.stringify({ summary, preview }, null, 2));
      const answer = (
        await rl.question("Apply this unified diff? Type YES to continue: ")
      ).trim();
      if (answer !== "YES") {
        console.log("Unified diff denied.");
        return 1;
      }
    } finally {
      rl.close();
    }
    const result = await tools.execute({
      tool: "workspace.apply_unified_diff",
      arguments: {
        diff,
        ...(selectedPaths ? { paths: selectedPaths } : {}),
      },
    });
    console.log(JSON.stringify(result.output ?? result.error, null, 2));
    return result.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function mcpCommand(args: ParsedArgs): Promise<number> {
  const configPath = flagString(
    args.flags,
    "config",
    path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
      "forge",
      "integrations.json",
    ),
  );
  const action = args.positional[0] ?? "list";
  if (action === "validate") {
    const result = await validateExternalServerConfig(configPath);
    console.log(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  }
  if (action === "enable" || action === "disable") {
    const id = args.positional[1];
    if (!id || !input.isTTY) {
      console.error(
        "Usage: forge mcp enable|disable <server-id> (interactive approval required)",
      );
      return 2;
    }
    const content = (await readRestrictedFile(configPath)) ?? "{}";
    const parsed = JSON.parse(content) as { servers?: unknown };
    if (!Array.isArray(parsed.servers)) {
      console.error("No MCP servers are configured.");
      return 1;
    }
    const server = parsed.servers.find(
      (value): value is Record<string, unknown> =>
        Boolean(
          value &&
          typeof value === "object" &&
          (value as Record<string, unknown>).id === id,
        ),
    );
    if (!server) {
      console.error(`Unknown MCP server: ${id}`);
      return 1;
    }
    const rl = createInterface({ input, output });
    try {
      const answer = (
        await rl.question(
          `Persist MCP ${action} for ${id}? Type YES to continue: `,
        )
      ).trim();
      if (answer !== "YES") {
        console.log("MCP trust change denied.");
        return 1;
      }
    } finally {
      rl.close();
    }
    server.enabled = action === "enable";
    server.explicitConsent = action === "enable";
    await writeRestrictedFile(configPath, JSON.stringify(parsed, null, 2));
    console.log(`MCP server ${id} ${action}d in local configuration.`);
    return 0;
  }
  const registry = await loadExternalServers(configPath);
  if (action === "list") {
    console.log(JSON.stringify(registry.list(), null, 2));
    return 0;
  }
  const id = args.positional[1];
  if (!id) {
    console.error(
      "Usage: forge mcp list|tools <server-id>|call <server-id> <tool> [json]",
    );
    return 2;
  }
  if (action !== "tools" && action !== "call") {
    console.error("Usage: forge mcp list|enable|disable|tools|call ...");
    return 2;
  }
  if (args.flags.enable !== true) {
    console.error(
      "MCP use is disabled by default; add --enable to explicitly enable this server for one command.",
    );
    return 2;
  }
  try {
    registry.enable(id);
    const client = new McpStdioClient(registry.getEnabled(id));
    await client.start();
    try {
      if (action === "tools") {
        console.log(JSON.stringify(await client.listTools(), null, 2));
        return 0;
      }
      if (action !== "call") {
        console.error(
          "Usage: forge mcp list|tools <server-id>|call <server-id> <tool> [json]",
        );
        return 2;
      }
      const tool = args.positional[2];
      if (!tool) {
        console.error("Usage: forge mcp call <server-id> <tool> [json]");
        return 2;
      }
      let arguments_: Record<string, unknown> = {};
      const rawArguments = args.positional[3];
      if (rawArguments) {
        const parsed = JSON.parse(rawArguments) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("MCP arguments must be a JSON object");
        arguments_ = parsed as Record<string, unknown>;
      }
      if (!input.isTTY) {
        console.error(
          "MCP tool calls require an interactive terminal approval; use tools discovery for non-mutating inspection.",
        );
        return 2;
      }
      const rl = createInterface({ input, output });
      try {
        const answer = (
          await rl.question(
            `Approve MCP call ${id}/${tool}? Type YES to continue: `,
          )
        ).trim();
        if (answer !== "YES") {
          console.log("MCP call denied.");
          return 1;
        }
      } finally {
        rl.close();
      }
      console.log(
        JSON.stringify(await client.callTool(tool, arguments_), null, 2),
      );
      return 0;
    } finally {
      client.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function integrationsCommand(args: ParsedArgs): Promise<number> {
  const configPath = flagString(
    args.flags,
    "config",
    path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
      "forge",
      "integrations.json",
    ),
  );
  const registry = await loadExternalServers(configPath);
  const action = args.positional[0] ?? "list";
  if (action !== "list") {
    console.error(
      "External servers are configured through integrations.json and remain disabled until a future explicit consent flow.",
    );
    return 2;
  }
  const servers = registry.list();
  if (!servers.length) console.log("No external servers configured.");
  for (const server of servers)
    console.log(
      `${server.id}  disabled  risk=${server.defaultRisk}  command=${server.command}`,
    );
  return 0;
}

async function undoCommand(args: ParsedArgs): Promise<number> {
  const checkpoint = args.positional[0];
  if (!checkpoint) {
    console.error("Usage: forge undo <checkpoint-id> [--workspace <path>]");
    return 2;
  }
  const workspace = path.resolve(
    flagString(args.flags, "workspace", process.cwd()),
  );
  try {
    await new WorkspaceTools(workspace).restoreCheckpoint(checkpoint);
    console.log(`Restored checkpoint ${checkpoint} in ${workspace}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runTask(
  args: ParsedArgs,
  recovery?: RecoveryAssessment,
): Promise<number> {
  const isJson = flagString(args.flags, "output", "text") === "json";
  const costProfile = flagString(args.flags, "cost-profile");
  if (costProfile && !["economy", "balanced", "quality"].includes(costProfile))
    throw new Error("--cost-profile must be economy, balanced, or quality");
  const workspace = path.resolve(
    flagString(args.flags, "workspace", process.cwd()),
  );
  let prompt =
    args.command === "plan"
      ? args.positional.join(" ")
      : flagString(args.flags, "prompt", args.positional.join(" "));
  const interactive =
    !isJson && args.command === "interactive" && Boolean(input.isTTY);
  const rl = interactive ? createInterface({ input, output }) : undefined;
  const cancellation = new AbortController();
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
    cancellation.abort();
    rl?.close();
  };
  process.once("SIGINT", onSigint);
  const tui =
    interactive && args.flags.simple !== true ? new FullScreenTui() : undefined;
  const cleanupCancellation = (): void => {
    process.removeListener("SIGINT", onSigint);
    rl?.close();
    tui?.stop();
  };
  if (tui) tui.start();
  try {
    if (!prompt && interactive && rl)
      prompt = (await rl.question("What should Forge do? ")).trim();
    if (!prompt) {
      console.error(
        args.command === "plan"
          ? "Usage: forge plan <prompt>"
          : "Usage: forge run --prompt <prompt>",
      );
      cleanupCancellation();
      return 2;
    }
  } catch (error) {
    cleanupCancellation();
    if (interrupted || cancellation.signal.aborted) {
      console.error("Forge run cancelled by operator.");
      return 130;
    }
    throw error;
  }
  const approve =
    interactive && rl
      ? async (
          proposal: ToolProposalEvent,
        ): Promise<"approve-once" | "approve-session" | "deny" | "cancel"> => {
          tui?.showApproval(proposal);
          const answer = (
            await rl.question(
              `Approve ${proposal.tool}? [y]es/[s]ession/[n]o/[r]evoke/[c]ancel: `,
            )
          )
            .trim()
            .toLowerCase();
          if (answer === "y" || answer === "yes") return "approve-once";
          if (answer === "s" || answer === "session") return "approve-session";
          if (answer === "r" || answer === "revoke") {
            revokeApprovalScope = true;
            return "deny";
          }
          if (answer === "c" || answer === "cancel") return "cancel";
          return "deny";
        }
      : undefined;
  const supervisor = new ForgeSupervisor();
  let revokeApprovalScope = false;
  try {
    const policyPackPath = flagString(args.flags, "policy-pack");
    const profileName = flagString(args.flags, "profile");
    const autonomyProfile = profileName
      ? getAutonomyProfile(profileName).name
      : undefined;
    const policyPack = policyPackPath
      ? await loadPolicyPack(path.resolve(policyPackPath))
      : undefined;
    const systemPrompt = await loadSystemPrompt();
    const runOptions = {
      prompt,
      workspace,
      ...(systemPrompt ? { systemPrompt } : {}),
      policy: "safe" as const,
      json: isJson,
      signal: cancellation.signal,
      onEvent: (event: ForgeEvent) => {
        if (tui) tui.handle(event);
        else renderEvent(event, isJson);
      },
      ...(approve ? { approve } : {}),
      ...(args.flags["multi-agent"] === true
        ? {
            multiAgent: true,
            ...(typeof args.flags["max-agents"] === "string"
              ? { maxAgents: boundedFlagInt(args.flags, "max-agents", 4, 1, 4) }
              : {}),
            ...(typeof args.flags["max-total-turns"] === "string"
              ? {
                  maxTotalTurns: boundedFlagInt(
                    args.flags,
                    "max-total-turns",
                    8,
                    1,
                    16,
                  ),
                }
              : {}),
            ...(costProfile
              ? {
                  costProfile: costProfile as
                    "economy" | "balanced" | "quality",
                }
              : {}),
          }
        : {}),
      ...(args.flags["no-record"] === true ? { record: false } : {}),
      ...(policyPack ? { policyPack } : {}),
      ...(autonomyProfile
        ? { autonomyProfile: autonomyProfile as AutonomyProfileName }
        : {}),
      ...(recovery ? { recovery } : {}),
      revokeApprovalScope: () => {
        const revoked = revokeApprovalScope;
        revokeApprovalScope = false;
        return revoked;
      },
    };
    const result = await supervisor.run(runOptions);
    if (cancellation.signal.aborted || interrupted) return 130;
    const sandboxId = flagString(args.flags, "daytona-sandbox");
    const cleanup = flagString(args.flags, "daytona-cleanup");
    if (cleanup && !sandboxId)
      throw new Error("--daytona-cleanup requires --daytona-sandbox <id>");
    if (sandboxId && cleanup) {
      if (cleanup !== "stop" && cleanup !== "delete")
        throw new Error("--daytona-cleanup must be stop or delete");
      if (!input.isTTY)
        throw new Error(
          "Daytona cleanup requires an interactive terminal approval",
        );
      const rl = createInterface({ input, output });
      try {
        const answer = (
          await rl.question(
            `Daytona ${cleanup} for ${sandboxId}? Type YES to continue: `,
          )
        ).trim();
        if (answer !== "YES") console.log("Daytona cleanup denied.");
        else {
          const client = new DaytonaClient();
          const cleanupResult =
            cleanup === "delete"
              ? await client.deleteSandbox(sandboxId)
              : await client.stopSandbox(sandboxId);
          console.log(
            JSON.stringify(
              { action: cleanup, sandboxId, ...cleanupResult },
              null,
              2,
            ),
          );
          if (!cleanupResult.ok) return 1;
        }
      } finally {
        rl.close();
      }
    }
    return result.status === "completed" ? 0 : 1;
  } catch (error) {
    if (interrupted || cancellation.signal.aborted) {
      console.error("Forge run cancelled by operator.");
      return 130;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    cleanupCancellation();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.help || args.command === "help") {
    console.log(usage());
    return 0;
  }
  if (args.flags.version) {
    console.log(VERSION);
    return 0;
  }
  if (args.command === "init") return initCommand(args);
  if (args.command === "doctor") return doctor(args);
  if (args.command === "providers") return providersCommand();
  if (args.command === "errors") return errorsCommand(args);
  if (args.command === "config") return configCommand(args);
  if (args.command === "prompt") return promptCommand(args);
  if (args.command === "session") return sessionCommand(args);
  if (args.command === "inspect") return inspectCommand(args);
  if (args.command === "audit") return auditCommand(args);
  if (args.command === "verify") return verifyCommand(args);
  if (args.command === "undo") return undoCommand(args);
  if (args.command === "integrations") return integrationsCommand(args);
  if (args.command === "mcp") return mcpCommand(args);
  if (args.command === "review") return diffCommand(args, false);
  if (args.command === "preview-diff") return previewDiffCommand(args);
  if (args.command === "apply-diff") return diffCommand(args, true);
  if (args.command === "acp") return acpCommand(args);
  if (args.command === "policy") return policyCommand(args);
  if (args.command === "context") return contextCommand(args);
  if (args.command === "profiles") return profilesCommand(args);
  if (args.command === "index") return indexCommand(args);
  if (args.command === "extensions") return extensionsCommand(args);
  if (args.command === "git") return gitCommand(args);
  if (args.command === "github") return githubCommand(args);
  if (args.command === "daytona") return daytonaCommand(args);
  return runTask(args);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => (process.exitCode = code))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
