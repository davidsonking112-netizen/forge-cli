import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

run(process.execPath, [
  "--test",
  ...readdirSync(path.join(root, "tests"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => path.join("tests", name)),
]);

const python =
  process.env.FORGE_PYTHON ??
  (process.platform === "win32" ? "python" : "python3");
run(python, [
  "-m",
  "unittest",
  "discover",
  "-s",
  "python/tests",
  "-p",
  "test_*.py",
]);
