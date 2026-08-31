import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const prefix = mkdtempSync(path.join(os.tmpdir(), "forge-clean-install-"));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} exited with ${result.status}`);
  }
}

try {
  run(npm, ["pack", "--pack-destination", prefix]);
  const archive = readdirSync(prefix).find((name) => name.endsWith(".tgz"));
  if (!archive) throw new Error("npm pack produced no archive");
  run(npm, ["install", "--prefix", prefix, path.join(prefix, archive)]);
  const forge =
    process.platform === "win32"
      ? path.join(prefix, "node_modules", ".bin", "forge.cmd")
      : path.join(prefix, "node_modules", ".bin", "forge");
  run(forge, ["--version"]);
  run(forge, ["errors"]);
  console.log("clean package install end-to-end smoke test passed");
} finally {
  rmSync(prefix, { recursive: true, force: true });
}
