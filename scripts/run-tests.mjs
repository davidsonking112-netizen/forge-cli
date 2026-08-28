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

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return testFiles(fullPath);
      return entry.isFile() && entry.name.endsWith(".test.mjs") ? [fullPath] : [];
    })
    .sort();
}

run(process.execPath, ["--test", ...testFiles(path.join(root, "tests"))]);

const python =
  process.env.FORGE_PYTHON ??
  (process.platform === "win32" ? "python" : "python3");
run(python, ["-m", "unittest", "discover", "-s", "python/tests", "-p", "test_*.py"]);
