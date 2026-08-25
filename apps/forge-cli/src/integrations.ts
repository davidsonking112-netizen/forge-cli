import { promises as fs } from "node:fs";
import type { RiskClass } from "../../../packages/protocol/src/index.js";

export interface ExternalServer {
  id: string;
  command: string;
  args: string[];
  enabled: boolean;
  trust: "untrusted";
  defaultRisk: RiskClass;
}

export interface AcpEvent {
  type: "workspace.open" | "prompt" | "edit.proposal" | "verification";
  workspace?: string;
  prompt?: string;
  files?: string[];
  status?: string;
}

export class ExternalToolRegistry {
  private readonly servers = new Map<string, ExternalServer>();

  public register(server: ExternalServer): void {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(server.id))
      throw new Error("External server IDs must be lowercase and bounded");
    if (!server.command || server.command.includes("\0"))
      throw new Error("External server command is invalid");
    this.servers.set(server.id, {
      ...server,
      enabled: false,
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
    if (typeof item.id !== "string" || typeof item.command !== "string")
      continue;
    registry.register({
      id: item.id,
      command: item.command,
      args: Array.isArray(item.args) ? item.args.map(String) : [],
      enabled: false,
      trust: "untrusted",
      defaultRisk: "network",
    });
  }
  return registry;
}

export class AcpBridge {
  public normalize(event: AcpEvent): AcpEvent {
    if (!event.type) throw new Error("ACP event type is required");
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
