import assert from "node:assert/strict";
import test from "node:test";
import {
  AcpJsonlBridge,
  ExternalToolRegistry,
} from "../dist/apps/forge-cli/src/integrations.js";
import {
  McpClientError,
  McpStdioClient,
} from "../dist/apps/forge-cli/src/mcp.js";

test("ACP accepts canonical JSON-RPC events and preserves correlation ids", () => {
  const bridge = new AcpJsonlBridge(1_000);
  const response = JSON.parse(
    bridge.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "edit.proposal",
        params: { workspace: ".", files: ["src/app.ts"], reason: "review" },
      }),
    ),
  );
  assert.equal(response.id, 7);
  assert.equal(response.result.correlationId, 7);
  assert.equal(response.result.approvalRequired, true);
  assert.equal(response.result.event.type, "edit.proposal");
});

test("ACP rejects malformed, oversized and scalar requests", () => {
  const bridge = new AcpJsonlBridge(100);
  assert.equal(
    JSON.parse(bridge.handleLine("not-json")).error.data.category,
    "parse",
  );
  assert.equal(
    JSON.parse(bridge.handleLine("x".repeat(101))).error.data.category,
    "invalid-request",
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
});

test("ACP limits event file lists and rejects unknown methods", () => {
  const bridge = new AcpJsonlBridge(10_000);
  const response = JSON.parse(
    bridge.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "prompt",
        params: {
          prompt: "inspect these files",
          files: Array.from({ length: 500 }, (_, i) => `f${i}`),
        },
      }),
    ),
  );
  assert.equal(response.result.event.files.length, 100);
  assert.equal(
    JSON.parse(
      bridge.handleLine(
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "bogus", params: {} }),
      ),
    ).error.data.category,
    "unsupported-event",
  );
});

test("MCP client rejects requests after close", async () => {
  const server = {
    id: "fixture",
    command: process.execPath,
    args: ["-e", "process.stdin.on('data',()=>{})"],
    enabled: true,
    explicitConsent: true,
    trust: "untrusted",
    defaultRisk: "network",
  };
  const client = new McpStdioClient(server, 100);
  await assert.rejects(
    () => client.callTool("tools.call", {}),
    (error) =>
      error instanceof McpClientError && error.category === "configuration",
  );
  client.close();
  await assert.rejects(
    () => client.callTool("tools.call", {}),
    (error) =>
      error instanceof McpClientError && error.category === "configuration",
  );
});

test("external tool registry never enables servers implicitly", () => {
  const registry = new ExternalToolRegistry();
  registry.register({
    id: "fixture",
    command: process.execPath,
    args: ["-e", ""],
    enabled: true,
    trust: "untrusted",
    defaultRisk: "network",
  });
  assert.throws(() => registry.getEnabled("fixture"), /not explicitly enabled/);
  registry.enable("fixture");
  assert.equal(registry.getEnabled("fixture").enabled, true);
});
