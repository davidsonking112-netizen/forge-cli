#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const child = spawn(process.execPath, [entrypoint, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.exitCode = 128 + (signal === "SIGINT" ? 2 : 15);
  } else {
    process.exitCode = code ?? 1;
  }
});
