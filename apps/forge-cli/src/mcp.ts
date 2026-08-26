import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { ExternalServer } from "./integrations.js";

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const keys = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) if (process.env[key]) env[key] = process.env[key];
  for (const key of Object.keys(process.env))
    if (key.startsWith("LC_")) env[key] = process.env[key];
  return env;
}

export class McpStdioClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: JsonRpcResponse) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private nextId = 0;
  private closed = false;

  public constructor(
    private readonly server: ExternalServer,
    private readonly timeoutMs = 15_000,
  ) {}

  public async start(): Promise<void> {
    if (!this.server.enabled)
      throw new Error(`MCP server ${this.server.id} is not explicitly enabled`);
    this.closed = false;
    this.process = spawn(this.server.command, this.server.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: childEnvironment(),
      windowsHide: true,
    });
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.process.on("error", (error) => this.rejectAll(error));
    this.process.on("close", (code) =>
      this.rejectAll(new Error(`MCP server exited with code ${code ?? 1}`)),
    );
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "forge-cli", version: "0.6.0" },
    });
    this.notify("notifications/initialized", {});
  }

  public async listTools(): Promise<McpToolDescriptor[]> {
    const response = await this.request("tools/list", {});
    const tools = (response.result as { tools?: unknown } | undefined)?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const tool = value as Record<string, unknown>;
      return typeof tool.name === "string"
        ? [
            {
              name: tool.name,
              ...(typeof tool.description === "string"
                ? { description: tool.description }
                : {}),
              inputSchema:
                typeof tool.inputSchema === "object" && tool.inputSchema
                  ? (tool.inputSchema as Record<string, unknown>)
                  : { type: "object" },
            },
          ]
        : [];
    });
  }

  public async callTool(
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown> {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(name))
      throw new Error("Invalid MCP tool name");
    const response = await this.request("tools/call", {
      name,
      arguments: arguments_,
    });
    return response.result;
  }

  public close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    this.process?.kill("SIGTERM");
    this.process = undefined;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.process?.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  private request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    if (!this.process || this.closed)
      return Promise.reject(new Error("MCP client is not started"));
    const id = `${++this.nextId}-${randomUUID()}`;
    this.process.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private handleLine(line: string): void {
    if (this.closed || Buffer.byteLength(line, "utf8") > 1_000_000) return;
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (!response.id) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error)
      pending.reject(
        new Error(
          `MCP ${response.error.code ?? "error"}: ${response.error.message ?? "request failed"}`,
        ),
      );
    else pending.resolve(response);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
