import type {
  RiskClass,
  ToolName,
} from "../../../packages/protocol/src/index.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TOOL_METADATA, type ToolMetadata } from "./tools.js";

export interface ForgeExtensionRecipes {
  contextGlobs: string[];
  verification: string[][];
}

export interface ForgeExtensionManifest {
  id: string;
  version: string;
  protocol: number;
  capabilities: Array<"tool" | "provider" | "context" | "renderer">;
  recipes?: ForgeExtensionRecipes;
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
    const recipes = validateRecipes(manifest.id, manifest.recipes);
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
      ...(recipes ? { recipes } : {}),
    });
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  public list(): ForgeExtensionManifest[] {
    return [...this.manifests.values()].map((manifest) => ({
      ...manifest,
      capabilities: [...manifest.capabilities],
      ...(manifest.recipes
        ? {
            recipes: {
              contextGlobs: [...manifest.recipes.contextGlobs],
              verification: manifest.recipes.verification.map((command) => [
                ...command,
              ]),
            },
          }
        : {}),
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

function validateRecipes(
  id: string,
  recipes: ForgeExtensionRecipes | undefined,
): ForgeExtensionRecipes | undefined {
  if (recipes === undefined) return undefined;
  if (!recipes || typeof recipes !== "object")
    throw new Error(`Extension ${id} recipes must be an object`);
  const contextGlobs = recipes.contextGlobs;
  if (
    !Array.isArray(contextGlobs) ||
    contextGlobs.length > 16 ||
    !contextGlobs.every(
      (glob) =>
        typeof glob === "string" &&
        glob.length > 0 &&
        glob.length <= 200 &&
        !path.isAbsolute(glob) &&
        !glob.includes("..") &&
        !glob.includes("\0"),
    )
  )
    throw new Error(`Extension ${id} has invalid context recipes`);
  const verification = recipes.verification;
  if (
    !Array.isArray(verification) ||
    verification.length > 8 ||
    !verification.every(
      (command) =>
        Array.isArray(command) &&
        command.length > 0 &&
        command.length <= 8 &&
        command.every(
          (part) =>
            typeof part === "string" &&
            part.length > 0 &&
            part.length <= 200 &&
            !part.includes("\0"),
        ),
    )
  )
    throw new Error(`Extension ${id} has invalid verification recipes`);
  return {
    contextGlobs: [...contextGlobs],
    verification: verification.map((command) => [...command]),
  };
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
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(
        `Extension manifest must have an object root: ${entry.name}`,
      );
    const manifest = parsed as Record<string, unknown>;
    registry.register({
      id: String(manifest.id ?? ""),
      version: String(manifest.version ?? ""),
      protocol: manifest.protocol as 1,
      capabilities: Array.isArray(manifest.capabilities)
        ? (manifest.capabilities as ForgeExtensionManifest["capabilities"])
        : [],
      ...(manifest.recipes === undefined
        ? {}
        : { recipes: manifest.recipes as ForgeExtensionRecipes }),
    });
  }
  return registry.list();
}
