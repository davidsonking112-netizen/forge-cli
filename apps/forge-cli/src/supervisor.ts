import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEnvelope,
  encodeForgeEvent,
  parseForgeEvent,
  type ForgeEvent,
  type PolicyMode,
  type RiskClass,
  type ApprovalScope,
  type RecoveryAssessment,
  type ToolName,
  type ToolProposalEvent,
  type ToolResultEvent,
} from "../../../packages/protocol/src/index.js";
import { PolicyEngine, TOOL_METADATA, WorkspaceTools } from "./tools.js";
import { SessionStore, type SessionRecord } from "./sessions.js";
import {
  buildRepositoryContext,
  fingerprintRepositoryContext,
} from "./context.js";
import type { PolicyPack } from "./policy.js";
import { getAutonomyProfile, type AutonomyProfileName } from "./profiles.js";

const FORGE_VERSION = "0.9.0";

export interface RunOptions {
  prompt: string;
  workspace: string;
  policy?: PolicyMode;
  json?: boolean;
  approveAll?: boolean;
  multiAgent?: boolean;
  maxAgents?: number;
  maxTotalTurns?: number;
  record?: boolean;
  policyPack?: PolicyPack;
  autonomyProfile?: AutonomyProfileName;
  recovery?: RecoveryAssessment;
  revokeApprovalScope?: () => boolean;
  onEvent?: (event: ForgeEvent) => void;
  approve?: (
    proposal: ToolProposalEvent,
  ) => Promise<"approve-once" | "approve-session" | "deny" | "cancel">;
}

export interface RunResult {
  sessionId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  changedFiles: string[];
}

function extractScopePaths(arguments_: Record<string, unknown>): string[] {
  const values: string[] = [];
  const add = (value: unknown): void => {
    if (
      typeof value === "string" &&
      value.length <= 500 &&
      !path.isAbsolute(value)
    )
      values.push(value.replaceAll("\\", "/"));
    else if (Array.isArray(value)) value.slice(0, 100).forEach(add);
  };
  add(arguments_.path);
  add(arguments_.paths);
  if (Array.isArray(arguments_.files))
    for (const file of arguments_.files.slice(0, 100))
      if (file && typeof file === "object")
        add((file as Record<string, unknown>).path);
  return [...new Set(values)].slice(0, 100);
}

export class ForgeSupervisor {
  private readonly sessions: SessionStore;

  public constructor(sessions = new SessionStore()) {
    this.sessions = sessions;
  }

  public async run(options: RunOptions): Promise<RunResult> {
    const workspace = path.resolve(options.workspace);
    const workspaceStat = await fs.stat(workspace).catch(() => null);
    if (!workspaceStat?.isDirectory())
      throw new Error(
        "Approved workspace does not exist or is not a directory",
      );
    const timestamp = new Date().toISOString();
    const session: SessionRecord =
      options.record === false
        ? {
            id: randomUUID(),
            workspace,
            createdAt: timestamp,
            updatedAt: timestamp,
            status: "running",
            resumeCount: 0,
            journal: [],
            verification: [],
            events: [],
          }
        : await this.sessions.create(workspace);
    const profile = getAutonomyProfile(options.autonomyProfile);
    const allRisks: RiskClass[] = [
      "read-only",
      "reversible-write",
      "local-execution",
      "destructive",
      "network",
      "credential-sensitive",
    ];
    const profileDeniedRisks = allRisks.filter(
      (risk) => !profile.allowedRisks.includes(risk),
    );
    const policy = new PolicyEngine(options.policy ?? "safe", {
      denyRisks: [
        ...profileDeniedRisks,
        ...(options.policyPack?.denyRisks ?? []),
      ],
      ...(options.policyPack?.denyTools
        ? { denyTools: options.policyPack.denyTools }
        : {}),
    });
    const tools = new WorkspaceTools(workspace);
    const repositoryContext = await buildRepositoryContext(
      workspace,
      options.prompt,
    );
    const workspaceFingerprint =
      fingerprintRepositoryContext(repositoryContext);
    session.workspaceFingerprint = workspaceFingerprint;
    if (options.record !== false) await this.sessions.save(session);
    const worker = this.startWorker(options);
    let workerError: Error | undefined;
    worker.on("error", (error) => {
      workerError = error instanceof Error ? error : new Error(String(error));
    });
    worker.stdin.on("error", (error) => {
      workerError = error instanceof Error ? error : new Error(String(error));
    });
    let sessionResult: RunResult | undefined;
    let approvalMode: "safe" | "session-approve" | "unsafe" = policy.mode;
    let approvalScope: ApprovalScope | undefined;

    const send = (event: ForgeEvent): void => {
      if (workerError) throw workerError;
      worker.stdin.write(`${encodeForgeEvent(event)}\n`);
    };

    const emit = async (event: ForgeEvent): Promise<void> => {
      if (options.record !== false) await this.sessions.append(session, event);
      options.onEvent?.(event);
    };

    const readline = createInterface({ input: worker.stdout });
    const processing = (async (): Promise<void> => {
      for await (const line of readline) {
        if (typeof line !== "string" || !line.trim()) continue;
        let event: ForgeEvent;
        try {
          event = parseForgeEvent(line);
        } catch (error) {
          await emit(
            this.errorEvent(
              session.id,
              "WORKER_PROTOCOL_ERROR",
              error instanceof Error ? error.message : String(error),
            ),
          );
          continue;
        }
        if (event.type === "session.complete") {
          event = {
            ...event,
            checks: event.checks.map((check) => ({
              ...check,
              commandDigest: createHash("sha256")
                .update(check.command)
                .digest("hex"),
              toolVersion: FORGE_VERSION,
            })),
          };
        }
        await emit(event);
        if (event.type === "tool.proposal") {
          if (options.revokeApprovalScope?.()) {
            approvalMode = "safe";
            approvalScope = undefined;
          }
          const metadata = TOOL_METADATA[event.tool];
          const needsApproval = metadata
            ? policy.requiresApproval(event.risk)
            : true;
          let approved = !needsApproval;
          let decision: "approve-once" | "approve-session" | "deny" | "cancel" =
            "approve-once";
          if (needsApproval) {
            if (options.approveAll) {
              approved = true;
              decision = "approve-session";
            } else if (
              approvalMode === "session-approve" &&
              approvalScope &&
              new Date(approvalScope.expiresAt).getTime() > Date.now() &&
              approvalScope.tool === event.tool &&
              approvalScope.argumentDigest ===
                this.argumentDigest(event.arguments)
            ) {
              approved = true;
              decision = "approve-session";
            } else if (options.approve) {
              decision = await options.approve(event);
              approved =
                decision === "approve-once" || decision === "approve-session";
              if (decision === "approve-session") {
                approvalMode = "session-approve";
                approvalScope = this.createApprovalScope(event);
              }
            }
          }
          const policyAllowed = policy.isAllowed(event.risk, event.tool);
          await emit({
            ...createEnvelope("approval.result", session.id),
            type: "approval.result",
            proposalId: event.id,
            decision,
            category: !needsApproval
              ? "automatic"
              : !policyAllowed
                ? "policy"
                : "user",
            ...(decision === "approve-session" && approvalScope
              ? { scope: approvalScope }
              : {}),
          });
          if (decision === "cancel") {
            send(
              this.cancelEvent(
                session.id,
                "User cancelled the requested operation",
              ),
            );
            continue;
          }
          const result =
            approved && policyAllowed
              ? await tools.execute({
                  tool: event.tool,
                  arguments: event.arguments,
                })
              : {
                  ok: false,
                  error: {
                    code: "APPROVAL_DENIED",
                    message:
                      "The operation was denied by Forge policy or the user.",
                    retryable: false,
                  },
                  durationMs: 0,
                };
          const resultEvent: ToolResultEvent = {
            ...createEnvelope("tool.result", session.id),
            type: "tool.result",
            tool: event.tool,
            ok: result.ok,
            ...(result.output === undefined ? {} : { output: result.output }),
            ...(result.error === undefined ? {} : { error: result.error }),
            approved,
            durationMs: result.durationMs,
          };
          await emit(resultEvent);
          send(resultEvent);
        }
        if (event.type === "session.complete") {
          sessionResult = {
            sessionId: session.id,
            status: event.status,
            summary: event.summary,
            changedFiles: event.changedFiles,
          };
          worker.stdin.end();
        }
      }
    })();

    const startEvent = {
      ...createEnvelope("session.start", session.id),
      type: "session.start" as const,
      workspace,
      policy: options.policy ?? "safe",
      provider: process.env.FORGE_PROVIDER ?? "mock",
      profile: profile.name,
      capabilities: Object.keys(TOOL_METADATA),
      prompt: options.prompt,
      context: repositoryContext,
      workspaceFingerprint,
      ...(options.recovery ? { recovery: options.recovery } : {}),
    };
    await emit(startEvent);
    send(startEvent);
    await processing;
    if (!sessionResult) {
      if (options.record !== false)
        await this.sessions.markInterrupted(session);
      sessionResult = {
        sessionId: session.id,
        status: "failed",
        summary: workerError
          ? `The worker failed: ${workerError.message}`
          : "The worker exited before completing the session.",
        changedFiles: [],
      };
    }
    if (!worker.killed) worker.kill();
    return sessionResult;
  }

  public async listSessions(): Promise<ReturnType<SessionStore["list"]>> {
    return this.sessions.list();
  }

  public async readSession(id: string): Promise<SessionRecord> {
    return this.sessions.read(id);
  }

  public async markSessionResumed(id: string): Promise<void> {
    const record = await this.sessions.read(id);
    await this.sessions.incrementResume(record);
  }

  public async setRecoveryAssessment(
    id: string,
    assessment: RecoveryAssessment,
  ): Promise<void> {
    const record = await this.sessions.read(id);
    await this.sessions.setRecoveryAssessment(record, assessment);
  }

  public async removeSession(id: string): Promise<void> {
    await this.sessions.remove(id);
  }

  public getSessionPath(): string {
    return this.sessions.getPath();
  }

  private startWorker(options: RunOptions): ChildProcessWithoutNullStreams {
    const python =
      process.env.FORGE_PYTHON ??
      (process.platform === "win32" ? "python" : "python3");
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const pythonRoot = path.resolve(moduleDirectory, "../../../../python");
    const inherited = process.env;
    const env: NodeJS.ProcessEnv = {
      PATH: inherited.PATH,
      PYTHONPATH: pythonRoot,
      ...(process.platform === "win32" && inherited.SystemRoot
        ? { SystemRoot: inherited.SystemRoot }
        : {}),
      ...(inherited.HOME ? { HOME: inherited.HOME } : {}),
      ...(inherited.TMPDIR ? { TMPDIR: inherited.TMPDIR } : {}),
      ...(inherited.TEMP ? { TEMP: inherited.TEMP } : {}),
      ...(inherited.TMP ? { TMP: inherited.TMP } : {}),
      ...Object.fromEntries(
        [
          "FORGE_PROVIDER",
          "FORGE_API_KEY",
          "OPENAI_API_KEY",
          "FORGE_BASE_URL",
          "FORGE_MODEL",
          "FORGE_MAX_TOKENS",
          "FORGE_REASONING_EFFORT",
          "FORGE_PROVIDER_RETRIES",
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "NO_PROXY",
          "http_proxy",
          "https_proxy",
          "no_proxy",
        ]
          .filter((key) => inherited[key] !== undefined)
          .map((key) => [key, inherited[key]]),
      ),
      ...(options.multiAgent === undefined
        ? {}
        : { FORGE_MULTI_AGENT: options.multiAgent ? "1" : "0" }),
      ...(options.maxAgents === undefined
        ? {}
        : { FORGE_MAX_AGENTS: String(options.maxAgents) }),
      ...(options.maxTotalTurns === undefined
        ? {}
        : { FORGE_MAX_TOTAL_TURNS: String(options.maxTotalTurns) }),
    };
    return spawn(python, ["-m", "forge_agent.worker"], {
      cwd: path.resolve(options.workspace),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  private argumentDigest(arguments_: Record<string, unknown>): string {
    return createHash("sha256")
      .update(JSON.stringify(arguments_))
      .digest("hex");
  }

  private createApprovalScope(proposal: ToolProposalEvent): ApprovalScope {
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const paths = extractScopePaths(proposal.arguments);
    return {
      tool: proposal.tool as ToolName,
      argumentDigest: this.argumentDigest(proposal.arguments),
      summary: `Exact arguments for ${proposal.tool}; expires in 15 minutes`,
      expiresAt,
      ...(paths.length ? { paths } : {}),
    };
  }

  private errorEvent(
    sessionId: string,
    code: string,
    message: string,
  ): ForgeEvent {
    return {
      ...createEnvelope("error", sessionId),
      type: "error",
      error: { code, message, retryable: false },
    };
  }

  private cancelEvent(sessionId: string, reason: string): ForgeEvent {
    return {
      ...createEnvelope("session.cancel", sessionId),
      type: "session.cancel",
      reason,
    };
  }
}
