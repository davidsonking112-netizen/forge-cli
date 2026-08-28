#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { normalizeExecutionPrompt } from "./prompt-intent.mjs";

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
const simpleMode = process.argv.includes("--simple");

function normalizeArgv(argv) {
  const normalized = [...argv];
  const command = normalized[0] ?? "";
  let promptIndex = -1;

  if (command === "run") {
    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index] === "--prompt" && index + 1 < normalized.length) {
        promptIndex = index + 1;
        break;
      }
      if (normalized[index]?.startsWith("--prompt=")) {
        promptIndex = index;
        break;
      }
    }
  } else if (!command.startsWith("--")) {
    promptIndex = 0;
  }

  if (promptIndex < 0) return normalized;
  if (normalized[promptIndex]?.startsWith("--prompt=")) {
    const value = normalized[promptIndex].slice("--prompt=".length);
    const rewritten = normalizeExecutionPrompt(value);
    if (rewritten !== value) normalized[promptIndex] = `--prompt=${rewritten}`;
    return normalized;
  }

  const value = normalized[promptIndex];
  if (typeof value === "string") {
    const rewritten = normalizeExecutionPrompt(value);
    if (rewritten !== value) normalized[promptIndex] = rewritten;
  }
  return normalized;
}

const child = spawn(process.execPath, [entrypoint, ...normalizeArgv(process.argv.slice(2))], {
  stdio: simpleMode ? ["inherit", "pipe", "inherit"] : "inherit",
  windowsHide: true,
});

if (simpleMode) {
  const rl = readline.createInterface({ input: child.stdout });
  let skipLines = 0;
  (async () => {
    for await (const rawLine of rl) {
      const line = String(rawLine);
      if (skipLines > 0) {
        skipLines -= 1;
        continue;
      }
      if (line === "Checklist:") {
        skipLines = 6;
        continue;
      }
      if (line.startsWith("[forge state]")) {
        skipLines = 5;
        continue;
      }
      if (line.startsWith("Dependency graph:")) {
        skipLines = 1;
        continue;
      }
      if (line.startsWith("Plan artifact:")) continue;
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
