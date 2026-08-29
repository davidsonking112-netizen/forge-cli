import assert from "node:assert/strict";
import test from "node:test";
import { AcpJsonlBridge } from "../../dist/apps/forge-cli/src/integrations.js";

test("ACP rejects malformed JSON, missing ids, invalid params, and oversized input", () => {
  const bridge = new AcpJsonlBridge(100);
  assert.equal(JSON.parse(bridge.handleLine("bad")).error.code, -32700);
  assert.equal(
    JSON.parse(
      bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "prompt" })),
    ).error.code,
    -32600,
  );
  assert.equal(
    JSON.parse(
      bridge.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "prompt",
          params: "bad",
        }),
      ),
    ).error.code,
    -32602,
  );
  assert.equal(
    JSON.parse(bridge.handleLine("x".repeat(101))).error.code,
    -32600,
  );
});

test("ACP preserves correlation and marks executable boundaries", () => {
  const bridge = new AcpJsonlBridge();
  const prompt = JSON.parse(
    bridge.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "p1",
        method: "prompt",
        params: { prompt: "inspect" },
      }),
    ),
  );
  assert.equal(prompt.result.correlationId, "p1");
  assert.equal(prompt.result.approvalRequired, false);
  const edit = JSON.parse(
    bridge.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "edit.proposal",
        params: { files: ["src/app.ts"] },
      }),
    ),
  );
  assert.equal(edit.result.correlationId, 2);
  assert.equal(edit.result.approvalRequired, true);
});
