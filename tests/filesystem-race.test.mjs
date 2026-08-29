import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceTools } from "../dist/apps/forge-cli/src/tools.js";

test("workspace writes reject symlink targets without modifying the target", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-race-"));
  try {
    const target = path.join(dir, "target.txt");
    const outside = path.join(dir, "outside.txt");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, target);
    const result = await new WorkspaceTools(dir).execute({
      tool: "workspace.apply_patch",
      arguments: { path: "target.txt", content: "ATTACK" },
    });
    assert.equal(result.ok, false);
    assert.equal(await readFile(outside, "utf8"), "outside");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace rejects symlinked parent directories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "forge-race-"));
  try {
    const realDir = path.join(dir, "real");
    await mkdir(realDir);
    const linkDir = path.join(dir, "link");
    await writeFile(path.join(realDir, "file.txt"), "safe", "utf8");
    await symlink(realDir, linkDir);
    const result = await new WorkspaceTools(dir).execute({
      tool: "workspace.apply_patch",
      arguments: { path: "link/file.txt", content: "ATTACK" },
    });
    assert.equal(result.ok, false);
    assert.equal(
      await readFile(path.join(realDir, "file.txt"), "utf8"),
      "safe",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
