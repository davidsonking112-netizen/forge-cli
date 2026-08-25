import type {
  RiskClass,
  ToolName,
} from "../../../packages/protocol/src/index.js";
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
