import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("../..", import.meta.url).pathname);

test("release scripts expose the clean-install and Python audit gates", () => {
  const releaseCheck = readFileSync(path.join(root, "scripts", "release-check.mjs"), "utf8");
  const smoke = path.join(root, "scripts", "clean-install-smoke.mjs");
  assert.equal(existsSync(smoke), true);
  assert.match(releaseCheck, /pip-audit/);
  assert.match(releaseCheck, /pip wheel/);
  assert.match(releaseCheck, /pip.*install.*\.\/python/);
  assert.match(releaseCheck, /clean-install-smoke\.mjs/);
});
