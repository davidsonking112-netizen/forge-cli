import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExternalServer } from "./integrations.js";

export type McpErrorCategory =
  | "configuration"
  | "transport"
  | "timeout"
  | "cancelled"
  | "protocol"
  | "server";

export class McpClientError extends Error {
  public constructor(
    message: string,
    public readonly category: McpErrorCategory,
  ) {
    super(message);
    this.name = "McpClientError";
  }
}

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
  private stdoutBuffer = "";

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
    this.stdoutBuffer = "";
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.process.stderr.resume();
    this.process.on("error", (error) => this.rejectAll(error));
    this.process.stdin.on("error", (error) => this.rejectAll(error));
    this.process.on("close", (code) =>
      this.rejectAll(new Error(`MCP server exited with code ${code ?? 1}`)),
    );
    try {
      await this.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "forge-cli", version: "1.0.0" },
      });
      this.notify("notifications/initialized", {});
    } catch (error) {
      this.close();
      throw error;
    }
  }

  public async listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    const response = await this.request("tools/list", {}, signal);
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
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(name))
      throw new Error("Invalid MCP tool name");
    const response = await this.request(
      "tools/call",
      {
        name,
        arguments: arguments_,
      },
      signal,
    );
    return response.result;
  }

  public cancelPending(reason = "MCP requests cancelled"): void {
    for (const [id, pending] of this.pending.entries()) {
      this.notify("notifications/cancelled", { requestId: id, reason });
      clearTimeout(pending.timer);
      pending.reject(new McpClientError(reason, "cancelled"));
    }
    this.pending.clear();
  }

  public close(): void {
    this.closed = true;
    this.rejectAll(new McpClientError("MCP client closed", "cancelled"));
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
    signal?: AbortSignal,
  ): Promise<JsonRpcResponse> {
    if (!this.process || this.closed)
      return Promise.reject(
        new McpClientError("MCP client is not started", "configuration"),
      );
    if (signal?.aborted)
      return Promise.reject(
        new McpClientError("MCP request cancelled", "cancelled"),
      );
    const id = `${++this.nextId}-${randomUUID()}`;
    this.process.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new McpClientError(`MCP request timed out: ${method}`, "timeout"),
        );
      }, this.timeoutMs);
      const onAbort = (): void => {
        this.pending.delete(id);
        clearTimeout(timer);
        this.notify("notifications/cancelled", {
          requestId: id,
          reason: "Client aborted the request",
        });
        reject(new McpClientError("MCP request cancelled", "cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        timer,
      });
    });
  }

  private handleStdout(chunk: string): void {
    if (this.closed) return;
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > 1_000_000) {
      this.stdoutBuffer = "";
      this.closed = true;
      this.rejectAll(new Error("MCP response exceeds the 1000000-byte limit"));
      this.process?.kill("SIGTERM");
      return;
    }
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.handleLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
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
        new McpClientError(
          `MCP ${response.error.code ?? "error"}: ${response.error.message ?? "request failed"}`,
          "server",
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
