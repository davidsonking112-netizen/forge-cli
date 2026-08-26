import type {
  RiskClass,
  ToolName,
} from "../../../packages/protocol/src/index.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TOOL_METADATA, type ToolMetadata } from "./tools.js";

export interface ForgeExtensionManifest {
  id: string;
  version: string;
  protocol: number;
  capabilities: Array<"tool" | "provider" | "context" | "renderer">;
}

export interface ForgeToolExtension {
  name: string;
  risk: RiskClass;
  description: string;
  execute(arguments_: Record<string, unknown>): Promise<unknown>;
}

export class ExtensionRegistry {
  private readonly manifests = new Map<string, ForgeExtensionManifest>();
  private readonly tools = new Map<string, ForgeToolExtension>();

  public register(
    manifest: ForgeExtensionManifest,
    tools: ForgeToolExtension[] = [],
  ): void {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(manifest.id))
      throw new Error("Extension IDs must be lowercase and bounded");
    if (manifest.protocol !== 1)
      throw new Error(
        `Extension ${manifest.id} requires unsupported protocol ${manifest.protocol}`,
      );
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version))
      throw new Error(`Extension ${manifest.id} requires a semantic version`);
    const allowedCapabilities = new Set([
      "tool",
      "provider",
      "context",
      "renderer",
    ]);
    if (
      !manifest.capabilities.length ||
      manifest.capabilities.some(
        (capability) => !allowedCapabilities.has(capability),
      )
    )
      throw new Error(
        `Extension ${manifest.id} declares an invalid capability`,
      );
    if (this.manifests.has(manifest.id))
      throw new Error(`Extension ${manifest.id} is already registered`);
    for (const tool of tools) {
      if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(tool.name))
        throw new Error(`Invalid extension tool name: ${tool.name}`);
      if (TOOL_METADATA[tool.name as ToolName])
        throw new Error(`Extension cannot replace built-in tool: ${tool.name}`);
      if (this.tools.has(tool.name))
        throw new Error(`Extension tool is already registered: ${tool.name}`);
    }
    this.manifests.set(manifest.id, {
      ...manifest,
      capabilities: [...manifest.capabilities],
    });
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  public list(): ForgeExtensionManifest[] {
    return [...this.manifests.values()].map((manifest) => ({
      ...manifest,
      capabilities: [...manifest.capabilities],
    }));
  }

  public getTool(name: string): ForgeToolExtension {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown extension tool: ${name}`);
    return tool;
  }

  public toolMetadata(): Record<string, ToolMetadata> {
    return Object.fromEntries(
      [...this.tools.entries()].map(([name, tool]) => [
        name,
        { risk: tool.risk, description: tool.description },
      ]),
    );
  }
}

export async function loadExtensionManifests(
  directory: string,
): Promise<ForgeExtensionManifest[]> {
  const registry = new ExtensionRegistry();
  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(directory, entry.name);
    const content = await fs.readFile(filePath, "utf8");
    if (Buffer.byteLength(content, "utf8") > 100_000)
      throw new Error(
        `Extension manifest exceeds the 100000-byte limit: ${entry.name}`,
      );
    const parsed = JSON.parse(content) as Record<string, unknown>;
    registry.register({
      id: String(parsed.id ?? ""),
      version: String(parsed.version ?? ""),
      protocol: parsed.protocol as 1,
      capabilities: Array.isArray(parsed.capabilities)
        ? (parsed.capabilities as ForgeExtensionManifest["capabilities"])
        : [],
    });
  }
  return registry.list();
}
