import { promises as fs } from "node:fs";
import type {
  RiskClass,
  ToolName,
} from "../../../packages/protocol/src/index.js";
import { TOOL_METADATA } from "./tools.js";

export interface PolicyPack {
  id: string;
  version: string;
  protocol: 1;
  denyRisks: RiskClass[];
  denyTools: ToolName[];
}

const riskClasses: RiskClass[] = [
  "read-only",
  "reversible-write",
  "local-execution",
  "destructive",
  "network",
  "credential-sensitive",
];

export async function loadPolicyPack(filePath: string): Promise<PolicyPack> {
  const content = await fs.readFile(filePath, "utf8");
  if (Buffer.byteLength(content, "utf8") > 100_000)
    throw new Error("Policy pack exceeds the 100000-byte limit");
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (Object.keys(parsed).some((key) => key.toLowerCase().startsWith("allow")))
    throw new Error("Policy packs may only add restrictions, never allowances");
  if (
    typeof parsed.id !== "string" ||
    !/^[a-z][a-z0-9_-]{1,63}$/.test(parsed.id) ||
    typeof parsed.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(parsed.version) ||
    parsed.protocol !== 1
  )
    throw new Error(
      "Policy pack requires bounded id, semantic version, and protocol 1",
    );
  const denyRisks = Array.isArray(parsed.denyRisks) ? parsed.denyRisks : [];
  if (
    !denyRisks.every(
      (value) =>
        typeof value === "string" && riskClasses.includes(value as RiskClass),
    )
  )
    throw new Error("Policy pack contains an unknown risk class");
  const denyTools = Array.isArray(parsed.denyTools) ? parsed.denyTools : [];
  if (
    !denyTools.every(
      (value) =>
        typeof value === "string" && Boolean(TOOL_METADATA[value as ToolName]),
    )
  )
    throw new Error("Policy pack contains an unknown tool");
  return {
    id: parsed.id,
    version: parsed.version,
    protocol: 1,
    denyRisks: [...new Set(denyRisks as RiskClass[])],
    denyTools: [...new Set(denyTools as ToolName[])],
  };
}
