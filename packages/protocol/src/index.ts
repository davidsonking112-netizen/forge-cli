import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = 1 as const;

export type RiskClass =
  | "read-only"
  | "reversible-write"
  | "local-execution"
  | "destructive"
  | "network"
  | "credential-sensitive";

export type ToolName =
  | "workspace.list"
  | "workspace.search"
  | "workspace.read"
  | "workspace.diff"
  | "workspace.apply_patch"
  | "process.run"
  | "git.status";

export interface BaseEvent {
  protocol: typeof PROTOCOL_VERSION;
  id: string;
  sessionId: string;
  type: string;
  timestamp: string;
}

export interface SessionStartEvent extends BaseEvent {
  type: "session.start";
  workspace: string;
  policy: PolicyMode;
  provider: string;
  capabilities: string[];
  prompt?: string;
}

export interface UserPromptEvent extends BaseEvent {
  type: "user.prompt";
  prompt: string;
}

export interface AgentTextEvent extends BaseEvent {
  type: "agent.text";
  text: string;
}

export interface AgentPlanEvent extends BaseEvent {
  type: "agent.plan";
  goal: string;
  steps: PlanStep[];
  assumptions: string[];
  verification: string[];
}

export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "active" | "complete" | "blocked";
}

export interface ToolProposalEvent extends BaseEvent {
  type: "tool.proposal";
  tool: ToolName;
  risk: RiskClass;
  arguments: Record<string, unknown>;
  reason: string;
}

export interface ToolResultEvent extends BaseEvent {
  type: "tool.result";
  tool: ToolName;
  ok: boolean;
  output?: unknown;
  error?: ToolError;
  approved: boolean;
  durationMs: number;
}

export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ApprovalResultEvent extends BaseEvent {
  type: "approval.result";
  proposalId: string;
  decision: "approve-once" | "approve-session" | "deny" | "cancel";
}

export interface SessionCancelEvent extends BaseEvent {
  type: "session.cancel";
  reason: string;
}

export interface SessionCompleteEvent extends BaseEvent {
  type: "session.complete";
  status: "completed" | "failed" | "cancelled";
  summary: string;
  changedFiles: string[];
  checks: CheckResult[];
}

export interface CheckResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export interface ErrorEvent extends BaseEvent {
  type: "error";
  error: ToolError;
}

export type ForgeEvent =
  | SessionStartEvent
  | UserPromptEvent
  | AgentTextEvent
  | AgentPlanEvent
  | ToolProposalEvent
  | ToolResultEvent
  | ApprovalResultEvent
  | SessionCancelEvent
  | SessionCompleteEvent
  | ErrorEvent;

export type PolicyMode = "safe" | "session-approve" | "unsafe";

export function isForgeEvent(value: unknown): value is ForgeEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.protocol === PROTOCOL_VERSION &&
    typeof candidate.id === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.timestamp === "string"
  );
}

export function parseForgeEvent(line: string): ForgeEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Protocol line is not valid JSON");
  }
  if (!isForgeEvent(value)) {
    throw new Error("Protocol event is missing required envelope fields");
  }
  return value;
}

export function encodeForgeEvent(event: ForgeEvent): string {
  return JSON.stringify(event);
}

export function createEnvelope<T extends string>(
  type: T,
  sessionId: string,
  id = randomUUID(),
): BaseEvent & { type: T } {
  return {
    protocol: PROTOCOL_VERSION,
    id,
    sessionId,
    type,
    timestamp: new Date().toISOString(),
  };
}
