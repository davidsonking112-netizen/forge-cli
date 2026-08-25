import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type {
  ForgeEvent,
  ToolProposalEvent,
} from "../../../packages/protocol/src/index.js";
import { ForgeSupervisor } from "./supervisor.js";
import { FullScreenTui } from "./tui.js";
import { loadExternalServers } from "./integrations.js";
import { WorkspaceTools } from "./tools.js";
import { McpStdioClient } from "./mcp.js";

const VERSION = "0.4.0";

function usage(): string {
  return `Forge CLI v${VERSION}

Usage:
  forge [prompt]                         Start an interactive coding session
  forge plan <prompt>                    Explore and produce a read-only plan
  forge run --prompt <prompt>            Run a task with machine-readable output support
  forge doctor [--repair]                Check runtime; print safe repair guidance
  forge config show|path|set <key> <v>   Inspect or update local configuration
  forge session list|resume|export|delete Manage local sessions
  forge undo <checkpoint-id>              Restore a Forge-managed checkpoint
  forge git status|branch|stage|commit    Use approval-gated local Git workflows
  forge git prepare-pr [title]            Prepare a local review-ready PR draft
  forge mcp list|tools|call               Use explicitly enabled MCP stdio servers

Options:
  --output text|json     Select rendering mode (default: text)
  --workspace <path>     Set the approved workspace root
  --policy safe           Use the default approval policy (default)
  --simple               Disable the full-screen terminal workspace
  --multi-agent          Enable bounded explorer/implementer/tester/reviewer delegation
  --max-agents <n>       Limit delegated specialist roles (default: 4)
  --max-total-turns <n>  Limit total delegated provider turns (default: 8)
  --no-record            Do not persist this session locally
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
    "doctor",
    "config",
    "session",
    "inspect",
    "undo",
    "integrations",
    "mcp",
    "git",
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
      const key = token.slice(2);
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

function boundedFlagInt(
  flags: Record<string, string | boolean>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = flags[key];
  if (typeof raw !== "string" || !/^\\d+$/.test(raw)) return fallback;
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
    const content = await fs.readFile(configPath, "utf8").catch(() => "{}");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      console.log(
        `${key}=${key.toLowerCase().includes("key") || key.toLowerCase().includes("token") ? "[REDACTED]" : String(parsed[key])}`,
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
    await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    const content = await fs.readFile(configPath, "utf8").catch(() => "{}");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    parsed[key] = value;
    await fs.writeFile(configPath, JSON.stringify(parsed, null, 2), {
      mode: 0o600,
    });
    console.log(`Updated ${key}`);
    return 0;
  }
  console.error("Usage: forge config show|path|set <key> <value>");
  return 2;
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
  if (action === "resume") {
    const start = record.events.find((event) => event.type === "session.start");
    if (!start || start.type !== "session.start" || !start.prompt) {
      console.error("This session does not contain a resumable prompt");
      return 1;
    }
    return runTask({
      command: "interactive",
      positional: [start.prompt],
      flags: { workspace: record.workspace },
    });
  }
  console.error("Usage: forge session list|resume|export|delete <id>");
  return 2;
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
    for (const event of session.events)
      counts[event.type] = (counts[event.type] ?? 0) + 1;
    console.log(
      JSON.stringify(
        {
          id: session.id,
          workspace: session.workspace,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          eventCount: session.events.length,
          eventTypes: counts,
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
    console.log(JSON.stringify({ title, body, remoteAction: "none" }, null, 2));
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
  const registry = await loadExternalServers(configPath);
  const action = args.positional[0] ?? "list";
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

async function runTask(args: ParsedArgs): Promise<number> {
  const isJson = flagString(args.flags, "output", "text") === "json";
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
  const tui =
    interactive && args.flags.simple !== true ? new FullScreenTui() : undefined;
  if (tui) tui.start();
  if (!prompt && interactive && rl)
    prompt = (await rl.question("What should Forge do? ")).trim();
  if (!prompt) {
    if (rl) rl.close();
    console.error(
      args.command === "plan"
        ? "Usage: forge plan <prompt>"
        : "Usage: forge run --prompt <prompt>",
    );
    return 2;
  }
  const approve =
    interactive && rl
      ? async (
          proposal: ToolProposalEvent,
        ): Promise<"approve-once" | "approve-session" | "deny" | "cancel"> => {
          tui?.showApproval(proposal);
          const answer = (
            await rl.question(
              `Approve ${proposal.tool}? [y]es/[s]ession/[n]o/[c]ancel: `,
            )
          )
            .trim()
            .toLowerCase();
          if (answer === "y" || answer === "yes") return "approve-once";
          if (answer === "s" || answer === "session") return "approve-session";
          if (answer === "c" || answer === "cancel") return "cancel";
          return "deny";
        }
      : undefined;
  const supervisor = new ForgeSupervisor();
  try {
    const runOptions = {
      prompt,
      workspace,
      policy: "safe" as const,
      json: isJson,
      onEvent: (event: ForgeEvent) => {
        if (tui) tui.handle(event);
        else renderEvent(event, isJson);
      },
      ...(approve ? { approve } : {}),
      ...(args.flags["multi-agent"] === true
        ? {
            multiAgent: true,
            maxAgents: boundedFlagInt(args.flags, "max-agents", 4, 1, 4),
            maxTotalTurns: boundedFlagInt(
              args.flags,
              "max-total-turns",
              8,
              1,
              16,
            ),
          }
        : {}),
      ...(args.flags["no-record"] === true ? { record: false } : {}),
    };
    const result = await supervisor.run(runOptions);
    return result.status === "completed" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    if (rl) rl.close();
    if (tui) tui.stop();
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
  if (args.command === "doctor") return doctor(args);
  if (args.command === "config") return configCommand(args);
  if (args.command === "session") return sessionCommand(args);
  if (args.command === "inspect") return inspectCommand(args);
  if (args.command === "undo") return undoCommand(args);
  if (args.command === "integrations") return integrationsCommand(args);
  if (args.command === "mcp") return mcpCommand(args);
  if (args.command === "git") return gitCommand(args);
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
