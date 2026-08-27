import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const python =
  process.env.FORGE_PYTHON ??
  (process.platform === "win32" ? "python" : "python3");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    console.error(`${command} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(npm, ["run", "format:check"]);
run(npm, ["run", "typecheck"]);
run(npm, ["test"]);
const wheelDirectory = mkdtempSync(
  path.join(os.tmpdir(), "forge-wheel-check-"),
);
run(python, [
  "-m",
  "pip",
  "wheel",
  "./python",
  "--no-deps",
  "--no-cache-dir",
  "-w",
  wheelDirectory,
]);
