#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const entrypoint = path.join(
  packageRoot,
  "dist",
  "apps",
  "forge-cli",
  "src",
  "main.js",
);
const argv = process.argv.slice(2);
const simpleMode = argv.includes("--simple");

function normalizedArgv(args) {
  if (!simpleMode) return args;
  const result = [...args];
  if (
    !result.includes("--output") &&
    !result.some((value) => value.startsWith("--output="))
  ) {
    result.push("--output", "json");
  }
  return result;
}

function renderSimpleEvent(event) {
  if (!event || typeof event !== "object") return false;
  switch (event.type) {
    case "agent.text":
      process.stdout.write(`${String(event.text ?? "").trim()}\n`);
      return true;
    case "tool.proposal":
      process.stdout.write(`\n[proposal] ${event.tool}: ${event.reason}\n`);
      return true;
    case "approval.result":
      process.stdout.write(`[approval] ${event.decision}\n`);
      return true;
    case "tool.result": {
      const status = event.ok ? "ok" : "failed";
      process.stdout.write(`[tool ${status}] ${event.tool}`);
      if (event.error?.message)
        process.stdout.write(` — ${String(event.error.message)}`);
      process.stdout.write("\n");
      return true;
    }
    case "agent.repair":
      process.stdout.write(
        `\n[repair ${event.status}] attempt ${event.attempt}/${event.maxAttempts} — ${event.reason}\n`,
      );
      return true;
    case "agent.delegation":
      process.stdout.write(
        `[specialist] ${String(event.role ?? event.roleId ?? "unknown")} — ${String(event.status ?? "completed")}\n`,
      );
      return true;
    case "session.complete":
      process.stdout.write(
        `\n[complete ${event.status}] ${String(event.summary ?? "")}\n`,
      );
      if (Array.isArray(event.changedFiles) && event.changedFiles.length) {
        process.stdout.write(
          `Changed files: ${event.changedFiles.join(", ")}\n`,
        );
      }
      return true;
    case "error":
      process.stdout.write(
        `[error] ${String(event.error?.code ?? "UNKNOWN")}: ${String(event.error?.message ?? "Unknown error")}\n`,
      );
      return true;
    default:
      return event.type !== undefined;
  }
}

const child = spawn(process.execPath, [entrypoint, ...normalizedArgv(argv)], {
  stdio: simpleMode ? ["inherit", "pipe", "inherit"] : "inherit",
  windowsHide: true,
});

if (simpleMode) {
  const rl = readline.createInterface({ input: child.stdout });
  (async () => {
    for await (const rawLine of rl) {
      const line = String(rawLine);
      try {
        const event = JSON.parse(line);
        if (renderSimpleEvent(event)) continue;
      } catch {
        // Approval prompts and other direct CLI text are intentionally passed through.
      }
      process.stdout.write(`${line}\n`);
    }
  })().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.exitCode = 128 + (signal === "SIGINT" ? 2 : 15);
  else process.exitCode = code ?? 1;
});
