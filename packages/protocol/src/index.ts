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
  | "workspace.apply_unified_diff"
  | "process.run"
  | "git.status"
  | "git.branch"
  | "git.stage"
  | "git.commit";

export interface BaseEvent {
  protocol: typeof PROTOCOL_VERSION;
  id: string;
  sessionId: string;
  type: string;
  timestamp: string;
}

export type RecoveryDecision = "continue" | "re-plan" | "manual-intervention";
export type RecoveryReasonCode =
  | "unchanged-active-step"
  | "unchanged-no-active-step"
  | "completed-session"
  | "legacy-session"
  | "workspace-drift"
  | "workspace-missing";

export interface RecoveryAssessment {
  sourceSessionId: string;
  decision: RecoveryDecision;
  reasonCode: RecoveryReasonCode;
  stepId?: string;
  reason: string;
  workspaceChanged: boolean;
  nextAction: "resume" | "re-plan" | "inspect-workspace";
}

export interface SessionStartEvent extends BaseEvent {
  type: "session.start";
  workspace: string;
  policy: PolicyMode;
  provider: string;
  profile?: string;
  capabilities: string[];
  prompt?: string;
  context?: unknown;
  workspaceFingerprint?: string;
  recovery?: RecoveryAssessment;
}

export interface UserPromptEvent extends BaseEvent {
  type: "user.prompt";
  prompt: string;
}

export interface AgentTextEvent extends BaseEvent {
  type: "agent.text";
  text: string;
}

export interface ScratchpadItem {
  key: string;
  value: string;
  status: "todo" | "active" | "done" | "blocked";
}

export interface AgentScratchpadEvent extends BaseEvent {
  type: "agent.scratchpad";
  items: ScratchpadItem[];
}

export interface AgentDelegationEvent extends BaseEvent {
  type: "agent.delegation";
  role: "explorer" | "implementer" | "tester" | "reviewer";
  status: "completed" | "failed" | "skipped";
  turns: number;
  text: string;
  error?: string;
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

export interface ApprovalScope {
  tool: ToolName;
  argumentDigest: string;
  summary: string;
  expiresAt: string;
  paths?: string[];
}

export interface ApprovalResultEvent extends BaseEvent {
  type: "approval.result";
  proposalId: string;
  decision: "approve-once" | "approve-session" | "deny" | "cancel";
  category?: "automatic" | "user" | "policy";
  scope?: ApprovalScope;
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

export type VerificationStatus =
  "not-run" | "passed" | "failed" | "timed-out" | "blocked" | "stale";

export interface CheckResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
  status?: VerificationStatus;
  startedAt?: string;
  finishedAt?: string;
  workspaceFingerprint?: string;
  commandDigest?: string;
  toolVersion?: string;
  outputTruncated?: boolean;
}

export interface ErrorEvent extends BaseEvent {
  type: "error";
  error: ToolError;
}

export type ForgeEvent =
  | SessionStartEvent
  | UserPromptEvent
  | AgentTextEvent
  | AgentScratchpadEvent
  | AgentDelegationEvent
  | AgentPlanEvent
  | ToolProposalEvent
  | ToolResultEvent
  | ApprovalResultEvent
  | SessionCancelEvent
  | SessionCompleteEvent
  | ErrorEvent;

export type PolicyMode = "safe" | "session-approve" | "unsafe";

const knownRisks = new Set<RiskClass>([
  "read-only",
  "reversible-write",
  "local-execution",
  "destructive",
  "network",
  "credential-sensitive",
]);
const knownTools = new Set<ToolName>([
  "workspace.list",
  "workspace.search",
  "workspace.read",
  "workspace.diff",
  "workspace.apply_patch",
  "workspace.apply_unified_diff",
  "process.run",
  "git.status",
  "git.branch",
  "git.stage",
  "git.commit",
]);
const protocolString = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length <= maximum && !value.includes("\0");
const protocolArray = (value: unknown, maximum: number): value is unknown[] =>
  Array.isArray(value) && value.length <= maximum;

function validCheck(value: unknown): value is CheckResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const check = value as Record<string, unknown>;
  return (
    protocolString(check.command, 500) &&
    typeof check.ok === "boolean" &&
    (check.exitCode === null ||
      (typeof check.exitCode === "number" &&
        Number.isSafeInteger(check.exitCode))) &&
    protocolString(check.output, 100_000) &&
    (check.status === undefined ||
      ["not-run", "passed", "failed", "timed-out", "blocked", "stale"].includes(
        String(check.status),
      )) &&
    (check.workspaceFingerprint === undefined ||
      (typeof check.workspaceFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(check.workspaceFingerprint))) &&
    (check.commandDigest === undefined ||
      (typeof check.commandDigest === "string" &&
        /^[a-f0-9]{64}$/.test(check.commandDigest))) &&
    (check.toolVersion === undefined ||
      protocolString(check.toolVersion, 32)) &&
    (check.outputTruncated === undefined ||
      typeof check.outputTruncated === "boolean")
  );
}

function validRecovery(value: unknown): value is RecoveryAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const recovery = value as Record<string, unknown>;
  return (
    protocolString(recovery.sourceSessionId, 100) &&
    ["continue", "re-plan", "manual-intervention"].includes(
      String(recovery.decision),
    ) &&
    (recovery.stepId === undefined || protocolString(recovery.stepId, 100)) &&
    protocolString(recovery.reason, 500) &&
    [
      "unchanged-active-step",
      "unchanged-no-active-step",
      "completed-session",
      "legacy-session",
      "workspace-drift",
      "workspace-missing",
    ].includes(String(recovery.reasonCode)) &&
    typeof recovery.workspaceChanged === "boolean" &&
    ["resume", "re-plan", "inspect-workspace"].includes(
      String(recovery.nextAction),
    )
  );
}

export function isForgeEvent(value: unknown): value is ForgeEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.protocol !== PROTOCOL_VERSION ||
    !protocolString(candidate.id, 100) ||
    !protocolString(candidate.sessionId, 100) ||
    !protocolString(candidate.type, 64) ||
    !protocolString(candidate.timestamp, 64) ||
    Number.isNaN(Date.parse(candidate.timestamp))
  )
    return false;
  switch (candidate.type) {
    case "session.start":
      return (
        protocolString(candidate.workspace, 4_000) &&
        ["safe", "session-approve", "unsafe"].includes(
          String(candidate.policy),
        ) &&
        protocolString(candidate.provider, 200) &&
        protocolArray(candidate.capabilities, 64) &&
        candidate.capabilities.every((item) => protocolString(item, 200)) &&
        (candidate.prompt === undefined ||
          protocolString(candidate.prompt, 20_000)) &&
        (candidate.workspaceFingerprint === undefined ||
          (typeof candidate.workspaceFingerprint === "string" &&
            /^[a-f0-9]{64}$/.test(candidate.workspaceFingerprint))) &&
        (candidate.recovery === undefined || validRecovery(candidate.recovery))
      );
    case "agent.text":
      return protocolString(candidate.text, 100_000);
    case "agent.scratchpad":
      return (
        protocolArray(candidate.items, 64) &&
        candidate.items.every((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item))
            return false;
          const entry = item as Record<string, unknown>;
          return (
            protocolString(entry.key, 100) &&
            protocolString(entry.value, 1_000) &&
            ["todo", "active", "done", "blocked"].includes(String(entry.status))
          );
        })
      );
    case "agent.delegation":
      return (
        ["explorer", "implementer", "tester", "reviewer"].includes(
          String(candidate.role),
        ) &&
        ["completed", "failed", "skipped"].includes(String(candidate.status)) &&
        typeof candidate.turns === "number" &&
        Number.isSafeInteger(candidate.turns) &&
        candidate.turns >= 0 &&
        candidate.turns <= 100 &&
        protocolString(candidate.text, 100_000) &&
        (candidate.error === undefined ||
          protocolString(candidate.error, 2_000))
      );
    case "agent.plan":
      return (
        protocolString(candidate.goal, 4_000) &&
        protocolArray(candidate.steps, 64) &&
        candidate.steps.every((step) => {
          if (!step || typeof step !== "object" || Array.isArray(step))
            return false;
          const item = step as Record<string, unknown>;
          return (
            protocolString(item.id, 100) &&
            protocolString(item.description, 1_000) &&
            ["pending", "active", "complete", "blocked"].includes(
              String(item.status),
            )
          );
        }) &&
        protocolArray(candidate.assumptions, 64) &&
        candidate.assumptions.every((item) => protocolString(item, 2_000)) &&
        protocolArray(candidate.verification, 64) &&
        candidate.verification.every((item) => protocolString(item, 2_000))
      );
    case "tool.proposal":
      return (
        typeof candidate.tool === "string" &&
        knownTools.has(candidate.tool as ToolName) &&
        typeof candidate.risk === "string" &&
        knownRisks.has(candidate.risk as RiskClass) &&
        !!candidate.arguments &&
        typeof candidate.arguments === "object" &&
        !Array.isArray(candidate.arguments) &&
        protocolString(candidate.reason, 2_000)
      );
    case "tool.result":
      return (
        typeof candidate.tool === "string" &&
        knownTools.has(candidate.tool as ToolName) &&
        typeof candidate.ok === "boolean" &&
        typeof candidate.approved === "boolean" &&
        typeof candidate.durationMs === "number" &&
        Number.isFinite(candidate.durationMs) &&
        candidate.durationMs >= 0 &&
        candidate.durationMs <= 120_000 &&
        (candidate.error === undefined ||
          (!!candidate.error &&
            typeof candidate.error === "object" &&
            protocolString(
              (candidate.error as Record<string, unknown>).code,
              100,
            ) &&
            protocolString(
              (candidate.error as Record<string, unknown>).message,
              2_000,
            ) &&
            typeof (candidate.error as Record<string, unknown>).retryable ===
              "boolean"))
      );
    case "approval.result":
      return (
        protocolString(candidate.proposalId, 100) &&
        ["approve-once", "approve-session", "deny", "cancel"].includes(
          String(candidate.decision),
        ) &&
        (candidate.category === undefined ||
          ["automatic", "user", "policy"].includes(
            String(candidate.category),
          )) &&
        (candidate.scope === undefined || validApprovalScope(candidate.scope))
      );
    case "session.cancel":
      return protocolString(candidate.reason, 2_000);
    case "session.complete":
      return (
        ["completed", "failed", "cancelled"].includes(
          String(candidate.status),
        ) &&
        protocolString(candidate.summary, 4_000) &&
        protocolArray(candidate.changedFiles, 200) &&
        candidate.changedFiles.every((item) => protocolString(item, 500)) &&
        protocolArray(candidate.checks, 32) &&
        candidate.checks.every(validCheck)
      );
    case "error":
      return !!candidate.error && validToolError(candidate.error);
    default:
      return false;
  }
}

function validToolError(value: unknown): value is ToolError {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const error = value as Record<string, unknown>;
  return (
    protocolString(error.code, 100) &&
    protocolString(error.message, 2_000) &&
    typeof error.retryable === "boolean"
  );
}

function validApprovalScope(value: unknown): value is ApprovalScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return (
    typeof scope.tool === "string" &&
    knownTools.has(scope.tool as ToolName) &&
    typeof scope.argumentDigest === "string" &&
    /^[a-f0-9]{64}$/.test(scope.argumentDigest) &&
    protocolString(scope.summary, 500) &&
    protocolString(scope.expiresAt, 64) &&
    !Number.isNaN(Date.parse(scope.expiresAt)) &&
    (scope.paths === undefined ||
      (protocolArray(scope.paths, 100) &&
        scope.paths.every((item) => protocolString(item, 500))))
  );
}

export function parseForgeEvent(line: string): ForgeEvent {
  if (Buffer.byteLength(line, "utf8") > 1_000_000)
    throw new Error("Protocol line exceeds the 1000000-byte limit");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Protocol line is not valid JSON");
  }
  if (!isForgeEvent(value)) {
    throw new Error("Protocol event is invalid or exceeds a protocol bound");
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
