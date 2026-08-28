import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const python =
  process.env.FORGE_PYTHON ??
  (process.platform === "win32" ? "python" : "python3");

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
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

const wheelDirectory = mkdtempSync(path.join(os.tmpdir(), "forge-wheel-check-"));
const cleanVenv = mkdtempSync(path.join(os.tmpdir(), "forge-release-venv-"));
const venvPython =
  process.platform === "win32"
    ? path.join(cleanVenv, "Scripts", "python.exe")
    : path.join(cleanVenv, "bin", "python");

try {
  run(python, ["-m", "venv", cleanVenv]);
  run(venvPython, ["-m", "pip", "install", "--upgrade", "pip", "setuptools"]);
  run(venvPython, ["-m", "pip", "install", "./python", "--no-cache-dir"]);
  run(venvPython, [
    "-c",
    "import forge_agent, forge_agent.worker; print('forge-agent clean release install ok')",
  ]);
  run(venvPython, [
    "-m",
    "pip",
    "wheel",
    "./python",
    "--no-deps",
    "--no-cache-dir",
    "-w",
    wheelDirectory,
  ]);
  run(venvPython, ["-m", "pip", "install", "pip-audit"]);
  run(venvPython, ["-m", "pip_audit", "--desc"]);
  run(process.execPath, [path.join(root, "scripts", "clean-install-smoke.mjs")]);
} finally {
  rmSync(wheelDirectory, { recursive: true, force: true });
  rmSync(cleanVenv, { recursive: true, force: true });
}
