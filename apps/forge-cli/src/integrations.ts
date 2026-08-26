import { promises as fs } from "node:fs";
import type { RiskClass } from "../../../packages/protocol/src/index.js";

export interface ExternalServer {
  id: string;
  command: string;
  args: string[];
  enabled: boolean;
  explicitConsent?: boolean;
  trust: "untrusted";
  defaultRisk: RiskClass;
}

export type AcpErrorCategory =
  "parse" | "invalid-request" | "invalid-params" | "unsupported-event";

export interface AcpEvent {
  type:
    "workspace.open" | "prompt" | "edit.proposal" | "verification" | "cancel";
  workspace?: string;
  prompt?: string;
  files?: string[];
  status?: string;
  reason?: string;
  correlationId?: string | number;
}

export interface AcpJsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export class AcpJsonlBridge {
  private readonly normalizer = new AcpBridge();

  public constructor(private readonly maxLineBytes = 250_000) {}

  public handleLine(line: string): string {
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes)
      return this.error(
        null,
        -32600,
        "ACP message exceeds the size limit",
        "invalid-request",
      );
    let request: AcpJsonRpcRequest;
    try {
      request = JSON.parse(line) as AcpJsonRpcRequest;
    } catch {
      return this.error(null, -32700, "ACP message is not valid JSON", "parse");
    }
    if (
      request.jsonrpc !== "2.0" ||
      typeof request.method !== "string" ||
      (typeof request.id !== "string" && typeof request.id !== "number")
    )
      return this.error(
        request.id ?? null,
        -32600,
        "ACP request requires jsonrpc 2.0, a method, and a string or numeric id",
        "invalid-request",
      );
    try {
      if (
        request.params !== undefined &&
        request.params !== null &&
        (typeof request.params !== "object" || Array.isArray(request.params))
      )
        return this.error(
          request.id,
          -32602,
          "ACP params must be an object",
          "invalid-params",
        );
      const params =
        request.params && typeof request.params === "object"
          ? (request.params as Record<string, unknown>)
          : {};
      const event = this.normalizer.normalize({
        type: request.method as AcpEvent["type"],
        ...(typeof params.workspace === "string"
          ? { workspace: params.workspace }
          : {}),
        ...(typeof params.prompt === "string" ? { prompt: params.prompt } : {}),
        ...(Array.isArray(params.files)
          ? {
              files: params.files.every((file) => typeof file === "string")
                ? params.files.slice(0, 100)
                : [],
            }
          : {}),
        ...(typeof params.status === "string" ? { status: params.status } : {}),
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
        ...(request.id === undefined ? {} : { correlationId: request.id }),
      });
      const approvalRequired =
        event.type === "edit.proposal" || event.type === "verification";
      return JSON.stringify({
        jsonrpc: "2.0",
        id: request.id ?? null,
        result: {
          event,
          approvalRequired,
          correlationId: request.id,
        },
      });
    } catch (error) {
      return this.error(
        request.id ?? null,
        -32602,
        error instanceof Error ? error.message : String(error),
        "unsupported-event",
      );
    }
  }

  private error(
    id: string | number | null,
    code: number,
    message: string,
    category: AcpErrorCategory,
  ): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message, data: { category } },
    });
  }
}

export class ExternalToolRegistry {
  private readonly servers = new Map<string, ExternalServer>();

  public register(
    server: ExternalServer,
    allowConfiguredEnablement = false,
  ): void {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(server.id))
      throw new Error("External server IDs must be lowercase and bounded");
    if (!server.command || server.command.includes("\0"))
      throw new Error("External server command is invalid");
    this.servers.set(server.id, {
      ...server,
      enabled: allowConfiguredEnablement && server.enabled,
      explicitConsent: allowConfiguredEnablement && server.enabled,
      trust: "untrusted",
    });
  }

  public enable(id: string): void {
    const server = this.servers.get(id);
    if (!server) throw new Error(`Unknown external server: ${id}`);
    server.enabled = true;
  }

  public disable(id: string): void {
    const server = this.servers.get(id);
    if (server) server.enabled = false;
  }

  public list(): ExternalServer[] {
    return [...this.servers.values()].map((server) => ({
      ...server,
      args: [...server.args],
    }));
  }

  public getEnabled(id: string): ExternalServer {
    const server = this.servers.get(id);
    if (!server || !server.enabled)
      throw new Error(`External server ${id} is not explicitly enabled`);
    return server;
  }
}

export async function validateExternalServerConfig(
  configPath: string,
): Promise<{ valid: boolean; servers: number; errors: string[] }> {
  const errors: string[] = [];
  const content = await fs.readFile(configPath, "utf8").catch(() => "{}");
  if (Buffer.byteLength(content, "utf8") > 100_000)
    return {
      valid: false,
      servers: 0,
      errors: ["MCP configuration exceeds the 100000-byte limit"],
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      valid: false,
      servers: 0,
      errors: ["MCP configuration is not valid JSON"],
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return {
      valid: false,
      servers: 0,
      errors: ["MCP configuration root must be an object"],
    };
  const root = parsed as { servers?: unknown };
  if (root.servers === undefined)
    return { valid: true, servers: 0, errors: [] };
  if (!Array.isArray(root.servers))
    return {
      valid: false,
      servers: 0,
      errors: ["MCP configuration servers must be an array"],
    };
  const seen = new Set<string>();
  root.servers.forEach((value, index) => {
    if (!value || typeof value !== "object") {
      errors.push(`servers[${index}] must be an object`);
      return;
    }
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || !/^[a-z][a-z0-9_-]{1,63}$/.test(item.id))
      errors.push(`servers[${index}].id is invalid`);
    else if (seen.has(item.id))
      errors.push(`duplicate MCP server id: ${item.id}`);
    else seen.add(item.id);
    if (
      typeof item.command !== "string" ||
      !item.command ||
      item.command.includes("\0")
    )
      errors.push(`servers[${index}].command is invalid`);
    if (
      item.args !== undefined &&
      (!Array.isArray(item.args) ||
        item.args.length > 64 ||
        item.args.some(
          (arg) =>
            typeof arg !== "string" || arg.length > 4_096 || arg.includes("\0"),
        ))
    )
      errors.push(
        `servers[${index}].args must contain at most 64 strings of 4096 safe characters`,
      );
    if (item.enabled !== undefined && typeof item.enabled !== "boolean")
      errors.push(`servers[${index}].enabled must be boolean`);
    if (
      item.explicitConsent !== undefined &&
      typeof item.explicitConsent !== "boolean"
    )
      errors.push(`servers[${index}].explicitConsent must be boolean`);
  });
  return { valid: errors.length === 0, servers: root.servers.length, errors };
}

export async function loadExternalServers(
  configPath: string,
): Promise<ExternalToolRegistry> {
  const registry = new ExternalToolRegistry();
  const content = await fs.readFile(configPath, "utf8").catch(() => "{}");
  const parsed = JSON.parse(content) as { servers?: unknown };
  if (!Array.isArray(parsed.servers)) return registry;
  for (const value of parsed.servers) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      typeof item.command !== "string" ||
      item.command.length > 256 ||
      item.command.includes("\0")
    )
      continue;
    const args = Array.isArray(item.args)
      ? item.args
          .filter(
            (arg): arg is string =>
              typeof arg === "string" &&
              arg.length <= 4_096 &&
              !arg.includes("\0"),
          )
          .slice(0, 64)
      : [];
    const explicitConsent = item.explicitConsent === true;
    registry.register(
      {
        id: item.id,
        command: item.command,
        args,
        enabled: item.enabled === true,
        explicitConsent,
        trust: "untrusted",
        defaultRisk: "network",
      },
      explicitConsent,
    );
  }
  return registry;
}

export class AcpBridge {
  public normalize(event: AcpEvent): AcpEvent {
    if (
      !event.type ||
      ![
        "workspace.open",
        "prompt",
        "edit.proposal",
        "verification",
        "cancel",
      ].includes(event.type)
    )
      throw new Error("Unsupported ACP event type");
    if (event.type === "prompt" && !event.prompt?.trim())
      throw new Error("ACP prompt cannot be empty");
    return {
      ...event,
      ...(event.prompt === undefined ? {} : { prompt: event.prompt.trim() }),
      ...(event.workspace === undefined
        ? {}
        : { workspace: event.workspace.trim() }),
    };
  }
}
