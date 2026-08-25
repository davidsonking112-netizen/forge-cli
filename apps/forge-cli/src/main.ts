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

const VERSION = "0.1.0";

function usage(): string {
  return `Forge CLI v${VERSION}

Usage:
  forge [prompt]                         Start an interactive coding session
  forge plan <prompt>                    Explore and produce a read-only plan
  forge run --prompt <prompt>            Run a task with machine-readable output support
  forge doctor                           Check local runtime and worker readiness
  forge config show|path|set <key> <v>   Inspect or update local configuration
  forge session list|resume|export|delete Manage local sessions

Options:
  --output text|json     Select rendering mode (default: text)
  --workspace <path>     Set the approved workspace root
  --policy safe           Use the default approval policy (default)
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

async function doctor(): Promise<number> {
  console.log(`Forge CLI ${VERSION}`);
  console.log(`Platform: ${os.platform()} ${os.arch()}`);
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
  if (action === "export" || action === "resume") {
    console.log(JSON.stringify(record, null, 2));
    return 0;
  }
  console.error("Usage: forge session list|resume|export|delete <id>");
  return 2;
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
      onEvent: (event: ForgeEvent) => renderEvent(event, isJson),
      ...(approve ? { approve } : {}),
    };
    const result = await supervisor.run(runOptions);
    if (rl) rl.close();
    return result.status === "completed" ? 0 : 1;
  } catch (error) {
    if (rl) rl.close();
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
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
  if (args.command === "doctor") return doctor();
  if (args.command === "config") return configCommand(args);
  if (args.command === "session") return sessionCommand(args);
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
