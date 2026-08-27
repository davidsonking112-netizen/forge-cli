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
  type SessionCompleteEvent,
  type ApprovalResultEvent,
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
  type ContextAttempt,
  type ContextFailure,
} from "./context.js";
import type { PolicyPack } from "./policy.js";
import { redactValue } from "./redaction.js";
import { getAutonomyProfile, type AutonomyProfileName } from "./profiles.js";
import { acquireWorkspaceLock } from "./locks.js";
import {
  ImplementationStateMachine,
  type ExecutionStateSnapshot,
} from "./execution-state.js";
import { DependencyGraph } from "./dependency-graph.js";
import {
  chooseMilestoneVerification,
  classifyVerificationFailure,
  type MilestoneVerificationPlan,
} from "./verification.js";

const FORGE_VERSION = "0.9.10";

export interface RunOptions {
  prompt: string;
  workspace: string;
  policy?: PolicyMode;
  json?: boolean;
  approveAll?: boolean;
  multiAgent?: boolean;
  maxAgents?: number;
  parallelReadOnly?: boolean;
  maxTotalTurns?: number;
  costProfile?: "economy" | "balanced" | "quality";
  systemPrompt?: string;
  record?: boolean;
  policyPack?: PolicyPack;
  autonomyProfile?: AutonomyProfileName;
  recovery?: RecoveryAssessment;
  failureContext?: ContextFailure[];
  attemptHistory?: ContextAttempt[];
  signal?: AbortSignal;
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
  if (typeof arguments_.diff === "string")
    for (const match of arguments_.diff.matchAll(/^\+\+\+ b\/(.+)$/gm))
      add(match[1]);
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
    const lock = await acquireWorkspaceLock(workspace);
    try {
      return await this.runUnlocked(options, workspace);
    } finally {
      await lock.release();
    }
  }

  private dependencyGraphEvent(
    sessionId: string,
    event: import("../../../packages/protocol/src/index.js").AgentGraphEvent,
  ): ForgeEvent {
    return { ...event, sessionId };
  }

  private executionStateEvent(
    sessionId: string,
    snapshot: ExecutionStateSnapshot,
  ): ForgeEvent {
    return {
      ...createEnvelope("agent.state", sessionId),
      type: "agent.state",
      ...snapshot,
    };
  }

  private async runUnlocked(
    options: RunOptions,
    workspace: string,
  ): Promise<RunResult> {
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
            scratchpad: [],
            checklist: [],
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
      undefined,
      {
        ...(options.failureContext
          ? { failureContext: options.failureContext }
          : {}),
        ...(options.attemptHistory
          ? { attemptHistory: options.attemptHistory }
          : {}),
      },
    );
    const workspaceFingerprint =
      fingerprintRepositoryContext(repositoryContext);
    session.workspaceFingerprint = workspaceFingerprint;
    if (options.record !== false) await this.sessions.save(session);
    const stateMachine = new ImplementationStateMachine(options.prompt, {
      maxProviderTurns: 64,
      maxToolCalls: 128,
      maxRepairAttempts: 4,
    });
    const worker = this.startWorker(options);
    const abortWorker = (): void => {
      if (!worker.killed) worker.kill("SIGTERM");
    };
    if (options.signal?.aborted) abortWorker();
    else options.signal?.addEventListener("abort", abortWorker, { once: true });
    let workerError: Error | undefined;
    worker.on("error", (error) => {
      workerError = error instanceof Error ? error : new Error(String(error));
    });
    worker.stdin.on("error", (error) => {
      workerError = error instanceof Error ? error : new Error(String(error));
    });
    let sessionResult: RunResult | undefined;
    let dependencyGraph: DependencyGraph | undefined;
    let completionRejections = 0;
    let approvalMode: "safe" | "session-approve" | "unsafe" = policy.mode;
    let approvalScope: ApprovalScope | undefined;
    const failureContext: ContextFailure[] = [
      ...(options.failureContext ?? []),
    ].slice(-8);
    const attemptHistory: ContextAttempt[] = [
      ...(options.attemptHistory ?? []),
    ].slice(-8);
    const observedChangedFiles = new Set(repositoryContext.changedFiles);

    const send = (event: ForgeEvent): void => {
      if (workerError) throw workerError;
      worker.stdin.write(`${encodeForgeEvent(event)}\n`);
    };

    const emit = async (event: ForgeEvent): Promise<void> => {
      if (options.record !== false) await this.sessions.append(session, event);
      options.onEvent?.(event);
    };

    const executeMilestoneCheck = async (
      plan: MilestoneVerificationPlan,
    ): Promise<ToolResultEvent> => {
      const arguments_: Record<string, unknown> =
        plan.tool === "browser.smoke"
          ? { path: plan.args[0] ?? "" }
          : { command: plan.command, args: plan.args, timeoutMs: 120_000 };
      const proposal: ToolProposalEvent = {
        ...createEnvelope("tool.proposal", session.id),
        type: "tool.proposal",
        tool: plan.tool,
        risk: "local-execution",
        arguments: arguments_,
        reason: plan.reason,
      };
      await emit(proposal);
      const needsApproval = policy.requiresApproval(proposal.risk);
      const policyAllowed = policy.isAllowed(proposal.risk, proposal.tool);
      let decision: "approve-once" | "approve-session" | "deny" | "cancel" =
        "approve-once";
      let approved = !needsApproval && policyAllowed;
      if (needsApproval) {
        if (options.approveAll) {
          approved = policyAllowed;
          decision = approved ? "approve-session" : "deny";
        } else if (
          approvalMode === "session-approve" &&
          approvalScope &&
          new Date(approvalScope.expiresAt).getTime() > Date.now() &&
          approvalScope.tool === proposal.tool &&
          approvalScope.argumentDigest ===
            this.argumentDigest(proposal.arguments)
        ) {
          approved = policyAllowed;
          decision = approved ? "approve-session" : "deny";
        } else if (options.approve) {
          decision = options.signal?.aborted
            ? "cancel"
            : await options.approve(proposal);
          approved =
            (decision === "approve-once" || decision === "approve-session") &&
            policyAllowed;
          if (decision === "approve-session") {
            approvalMode = "session-approve";
            approvalScope = this.createApprovalScope(proposal);
          }
        } else {
          approved = false;
          decision = "deny";
        }
      }
      await emit({
        ...createEnvelope("approval.result", session.id),
        type: "approval.result",
        proposalId: proposal.id,
        decision,
        category: !policyAllowed
          ? "policy"
          : needsApproval
            ? "user"
            : "automatic",
        ...(decision === "approve-session" && approvalScope
          ? { scope: approvalScope }
          : {}),
      });
      const result = approved
        ? await tools.execute({
            tool: proposal.tool,
            arguments: proposal.arguments,
            ...(options.signal ? { signal: options.signal } : {}),
          })
        : {
            ok: false,
            error: {
              code:
                decision === "cancel"
                  ? "APPROVAL_CANCELLED"
                  : "APPROVAL_DENIED",
              message: "The milestone verification was not approved.",
              retryable: false,
            },
            durationMs: 0,
          };
      const output =
        result.output && typeof result.output === "object"
          ? (result.output as Record<string, unknown>)
          : {};
      const failure = !result.ok
        ? classifyVerificationFailure({
            tool: plan.tool,
            kind: plan.kind,
            ...(result.error?.code ? { code: result.error.code } : {}),
            ...(result.error?.message ? { message: result.error.message } : {}),
            output: String(output.output ?? ""),
          })
        : undefined;
      const priorAttempts = [...attemptHistory];
      let resultEvent: ToolResultEvent = {
        ...createEnvelope("tool.result", session.id),
        type: "tool.result",
        tool: proposal.tool,
        ok: result.ok,
        ...(result.output === undefined ? {} : { output: result.output }),
        ...(result.error === undefined ? {} : { error: result.error }),
        approved,
        durationMs: result.durationMs,
        milestoneId: plan.milestoneId,
        verificationKind: plan.kind,
        ...(failure
          ? {
              failureKind: failure.failureKind,
              recoveryStrategy: failure.recoveryStrategy,
            }
          : {}),
      };
      const evidenceOutput =
        result.output &&
        typeof result.output === "object" &&
        !Array.isArray(result.output)
          ? (result.output as Record<string, unknown>)
          : {};
      const evidence = {
        milestoneId: plan.milestoneId,
        verificationKind: plan.kind,
        command:
          typeof evidenceOutput.command === "string"
            ? evidenceOutput.command
            : [plan.command, ...plan.args].join(" "),
        ...(typeof evidenceOutput.exitCode === "number"
          ? { exitCode: evidenceOutput.exitCode }
          : {}),
        output: String(
          redactValue(
            typeof evidenceOutput.output === "string"
              ? evidenceOutput.output
              : (result.error?.message ?? ""),
          ),
        ).slice(0, 20_000),
        changedFiles: [...observedChangedFiles].slice(0, 200),
        workspaceFingerprint,
        priorRepairAttempts: priorAttempts.slice(-8),
        ...(failure
          ? {
              failureKind: failure.failureKind,
              recoveryStrategy: failure.recoveryStrategy,
            }
          : {}),
      };
      resultEvent = {
        ...resultEvent,
        output: { ...evidenceOutput, forgeVerification: evidence },
      };
      await emit(resultEvent);
      const snapshot = stateMachine.recordMilestoneVerification(resultEvent);
      if (snapshot) await emit(this.executionStateEvent(session.id, snapshot));
      if (!result.ok) {
        const failureRecord: ContextFailure = {
          milestoneId: plan.milestoneId,
          tool: plan.tool,
          command:
            typeof output.command === "string"
              ? output.command
              : [plan.command, ...plan.args].join(" "),
          ...(typeof output.exitCode === "number"
            ? { exitCode: output.exitCode }
            : {}),
          output: String(
            redactValue(
              [result.error?.message, output.output]
                .filter(Boolean)
                .join("\\n"),
            ),
          ).slice(0, 20_000),
          changedFiles: [...observedChangedFiles].slice(0, 200),
          workspaceFingerprint,
          ...(failure
            ? {
                failureKind: failure.failureKind,
                recoveryStrategy: failure.recoveryStrategy,
              }
            : {}),
        };
        failureContext.push(failureRecord);
        while (failureContext.length > 8) failureContext.shift();
        attemptHistory.push({
          strategy: failure?.recoveryStrategy ?? "change-focused-command",
          reason: failureRecord.output.slice(0, 1_000),
          outcome: "failed",
        });
        while (attemptHistory.length > 8) attemptHistory.shift();
        repositoryContext.contextPack.failureContext = [...failureContext];
        repositoryContext.contextPack.attemptHistory = [...attemptHistory];
      }
      return resultEvent;
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
        if (event.type === "agent.plan") {
          dependencyGraph = new DependencyGraph(event);
          await emit(
            this.dependencyGraphEvent(
              session.id,
              dependencyGraph.event(
                dependencyGraph.isValid()
                  ? "Supervisor assigned stable dependency-graph step IDs and validated the proposed contracts."
                  : "Supervisor blocked the proposed dependency graph because one or more step contracts are invalid.",
                dependencyGraph.isValid() ? "validated" : "blocked",
              ),
            ),
          );
        }
        if (
          event.type === "agent.plan" ||
          event.type === "tool.proposal" ||
          event.type === "session.complete"
        ) {
          stateMachine.recordProviderTurn();
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
        if (event.type === "tool.proposal") {
          const graphGate = dependencyGraph?.actionGate(
            event.tool,
            extractScopePaths(event.arguments),
          );
          if (dependencyGraph && graphGate && !graphGate.ok) {
            await emit(event);
            await emit(
              this.dependencyGraphEvent(
                session.id,
                dependencyGraph.event(
                  `Graph blocked ${event.tool}: ${graphGate.reason}`,
                  "blocked",
                ),
              ),
            );
            const denied: ApprovalResultEvent = {
              ...createEnvelope("approval.result", session.id),
              type: "approval.result",
              proposalId: event.id,
              decision: "deny",
              category: "policy",
            };
            await emit(denied);
            const graphDenied: ToolResultEvent = {
              ...createEnvelope("tool.result", session.id),
              type: "tool.result",
              tool: event.tool,
              ok: false,
              error: {
                code: "DEPENDENCY_GRAPH_BLOCKED",
                message: graphGate.reason,
                retryable: false,
              },
              approved: false,
              durationMs: 0,
            };
            await emit(graphDenied);
            send(graphDenied);
            continue;
          }
          const proposalGate = stateMachine.proposalGate(event.tool);
          if (!proposalGate.ok) {
            await emit(event);
            const blocked = stateMachine.block(proposalGate.reason);
            await emit(this.executionStateEvent(session.id, blocked));
            const denied: ApprovalResultEvent = {
              ...createEnvelope("approval.result", session.id),
              type: "approval.result",
              proposalId: event.id,
              decision: "deny",
              category: "policy",
            };
            await emit(denied);
            const stateDenied: ToolResultEvent = {
              ...createEnvelope("tool.result", session.id),
              type: "tool.result",
              tool: event.tool,
              ok: false,
              error: {
                code: "STATE_TRANSITION_BLOCKED",
                message: proposalGate.reason,
                retryable: false,
              },
              approved: false,
              durationMs: 0,
            };
            await emit(stateDenied);
            send(stateDenied);
            continue;
          }
        }
        const stateSnapshot = stateMachine.observe(event);
        if (stateSnapshot)
          await emit(this.executionStateEvent(session.id, stateSnapshot));
        if (event.type === "session.complete") {
          const stateGate = stateMachine.completionGate(event);
          const graphGate = dependencyGraph?.completionGate();
          const gate =
            graphGate && !graphGate.ok
              ? { ok: false, reason: graphGate.reason }
              : stateGate;
          if (event.status === "completed" && gate.ok) {
            await emit(
              this.executionStateEvent(
                session.id,
                stateMachine.acceptCompletion(),
              ),
            );
          }
          if (event.status === "completed" && !gate.ok) {
            completionRejections += 1;
            const blocked = stateMachine.block(gate.reason);
            await emit(this.executionStateEvent(session.id, blocked));
            if (completionRejections <= 3) {
              attemptHistory.push({
                strategy: "completion-gate-repair",
                reason: gate.reason.slice(0, 1_000),
                outcome: "blocked",
              });
              while (attemptHistory.length > 8) attemptHistory.shift();
              repositoryContext.contextPack.attemptHistory = [
                ...attemptHistory,
              ];
              const recentFailures = failureContext
                .slice(-3)
                .map(
                  (failure) =>
                    `${failure.tool}${failure.command ? ` ${failure.command}` : ""}: ${failure.output}`,
                )
                .join(" | ");
              const recentAttempts = attemptHistory
                .slice(-3)
                .map((attempt) => `${attempt.strategy}: ${attempt.reason}`)
                .join(" | ");
              send({
                ...createEnvelope("user.prompt", session.id),
                type: "user.prompt",
                prompt: `Forge rejected the completion claim: ${gate.reason} Continue from the last verified checkpoint. Perform the missing bounded milestone or verification step; do not claim done until the supervisor evidence satisfies the completion gates. Recent failure context: ${recentFailures || "none"}. Previous repair strategies to avoid repeating: ${recentAttempts || "none"}.`,
              });
              continue;
            }
            const failed: SessionCompleteEvent = {
              ...event,
              status: "failed",
              summary: `Forge refused completion after ${completionRejections} evidence-gate failures: ${gate.reason}`,
            };
            await emit(failed);
            sessionResult = {
              sessionId: session.id,
              status: failed.status,
              summary: failed.summary,
              changedFiles: failed.changedFiles,
            };
            worker.stdin.end();
            continue;
          }
        }
        await emit(event);
        if (event.type === "tool.proposal") {
          if (dependencyGraph) {
            await emit(
              this.dependencyGraphEvent(
                session.id,
                dependencyGraph.event(
                  `Graph authorized ${event.tool} for ${dependencyGraph.currentStepId() ?? "the next ready step"}.`,
                  "in-progress",
                ),
              ),
            );
          }
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
              if (options.signal?.aborted) decision = "cancel";
              else if (!options.signal) decision = await options.approve(event);
              else {
                decision = await new Promise((resolve, reject) => {
                  let settled = false;
                  const finish = (
                    value:
                      "approve-once" | "approve-session" | "deny" | "cancel",
                  ): void => {
                    if (settled) return;
                    settled = true;
                    options.signal?.removeEventListener("abort", onAbort);
                    resolve(value);
                  };
                  const onAbort = (): void => finish("cancel");
                  options.signal?.addEventListener("abort", onAbort, {
                    once: true,
                  });
                  options.approve!(event)
                    .then(finish)
                    .catch((error: unknown) => {
                      if (settled) return;
                      settled = true;
                      options.signal?.removeEventListener("abort", onAbort);
                      reject(error);
                    });
                });
              }
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
            if (!options.signal?.aborted)
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
                  ...(options.signal ? { signal: options.signal } : {}),
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
          let resultEvent: ToolResultEvent = {
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
          if (
            resultEvent.ok &&
            resultEvent.output &&
            typeof resultEvent.output === "object"
          ) {
            const output = resultEvent.output as Record<string, unknown>;
            if (Array.isArray(output.files))
              output.files.slice(0, 200).forEach((file) => {
                if (
                  typeof file === "string" &&
                  file.length <= 500 &&
                  !path.isAbsolute(file)
                )
                  observedChangedFiles.add(file.replaceAll("\\", "/"));
              });
          }
          const resultSnapshot = stateMachine.observe(resultEvent);
          if (resultSnapshot)
            await emit(this.executionStateEvent(session.id, resultSnapshot));
          const isMutation = [
            "workspace.apply_patch",
            "workspace.apply_unified_diff",
            "git.branch",
            "git.stage",
            "git.commit",
          ].includes(event.tool);
          if (resultEvent.ok && isMutation) {
            const changed = [...observedChangedFiles].slice(0, 200);
            const milestoneId =
              dependencyGraph?.currentStepId() ??
              `milestone-${stateMachine.current().stepIndex}`;
            const plan = chooseMilestoneVerification(
              milestoneId,
              changed,
              repositoryContext.files,
              repositoryContext.contextPack.projectContract,
            );
            if (plan) {
              stateMachine.requireMilestoneVerification();
              const verificationResult = await executeMilestoneCheck(plan);
              const mutationOutput =
                resultEvent.output &&
                typeof resultEvent.output === "object" &&
                !Array.isArray(resultEvent.output)
                  ? (resultEvent.output as Record<string, unknown>)
                  : {};
              const verificationOutput =
                verificationResult.output &&
                typeof verificationResult.output === "object" &&
                !Array.isArray(verificationResult.output)
                  ? (verificationResult.output as Record<string, unknown>)
                  : {};
              resultEvent = {
                ...resultEvent,
                output: {
                  ...mutationOutput,
                  forgeVerification: {
                    milestoneId: plan.milestoneId,
                    verificationKind: plan.kind,
                    ok: verificationResult.ok,
                    command:
                      verificationOutput.command ??
                      [plan.command, ...plan.args].join(" "),
                    ...(typeof verificationOutput.exitCode === "number"
                      ? { exitCode: verificationOutput.exitCode }
                      : {}),
                    output: String(
                      redactValue(
                        typeof verificationOutput.output === "string"
                          ? verificationOutput.output
                          : (verificationResult.error?.message ?? ""),
                      ),
                    ).slice(0, 20_000),
                    changedFiles: changed,
                    workspaceFingerprint,
                    priorRepairAttempts: attemptHistory.slice(-8),
                    ...(verificationResult.failureKind
                      ? { failureKind: verificationResult.failureKind }
                      : {}),
                    ...(verificationResult.recoveryStrategy
                      ? {
                          recoveryStrategy: verificationResult.recoveryStrategy,
                        }
                      : {}),
                  },
                },
              };
              const verificationSnapshot =
                stateMachine.recordMilestoneVerification(verificationResult);
              if (verificationSnapshot)
                await emit(
                  this.executionStateEvent(session.id, verificationSnapshot),
                );
            }
          }
          if (!resultEvent.ok) {
            const output =
              resultEvent.output && typeof resultEvent.output === "object"
                ? (resultEvent.output as Record<string, unknown>)
                : {};
            const command =
              typeof output.command === "string"
                ? output.command
                : event.tool === "process.run" &&
                    typeof event.arguments.command === "string"
                  ? event.arguments.command
                  : undefined;
            const failureOutput = [
              resultEvent.error?.message,
              typeof output.output === "string" ? output.output : undefined,
            ]
              .filter((value): value is string => Boolean(value))
              .join("\n");
            const failureClassification =
              resultEvent.tool === "process.run" ||
              resultEvent.tool === "browser.smoke"
                ? classifyVerificationFailure({
                    tool: resultEvent.tool,
                    ...(resultEvent.tool === "browser.smoke"
                      ? { kind: "browser-smoke" as const }
                      : {}),
                    ...(resultEvent.error?.code
                      ? { code: resultEvent.error.code }
                      : {}),
                    ...(resultEvent.error?.message
                      ? { message: resultEvent.error.message }
                      : {}),
                    output: failureOutput,
                  })
                : undefined;
            const failure: ContextFailure = {
              tool: resultEvent.tool,
              ...(command ? { command } : {}),
              ...(typeof output.exitCode === "number"
                ? { exitCode: output.exitCode }
                : {}),
              output: String(redactValue(failureOutput || "Tool failed")).slice(
                0,
                20_000,
              ),
              changedFiles: [...observedChangedFiles].slice(0, 200),
              workspaceFingerprint,
              ...(failureClassification
                ? {
                    failureKind: failureClassification.failureKind,
                    recoveryStrategy: failureClassification.recoveryStrategy,
                  }
                : {}),
            };
            failureContext.push(failure);
            while (failureContext.length > 8) failureContext.shift();
            attemptHistory.push({
              strategy:
                failureClassification?.recoveryStrategy ?? "bounded-repair",
              reason: failure.output.slice(0, 1_000),
              outcome:
                resultEvent.error?.code === "APPROVAL_DENIED"
                  ? "blocked"
                  : "failed",
            });
            while (attemptHistory.length > 8) attemptHistory.shift();
            repositoryContext.contextPack.failureContext = [...failureContext];
            repositoryContext.contextPack.attemptHistory = [...attemptHistory];
          }
          if (
            dependencyGraph &&
            resultEvent.ok &&
            resultEvent.tool === "process.run" &&
            stateMachine.current().phase === "full-verify"
          ) {
            const graphProgress = dependencyGraph.markStepCompleted();
            if (graphProgress)
              await emit(this.dependencyGraphEvent(session.id, graphProgress));
          }
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
    for (const snapshot of stateMachine.initialSnapshots())
      await emit(this.executionStateEvent(session.id, snapshot));
    send(startEvent);
    await processing;
    if (!sessionResult) {
      if (options.record !== false) {
        if (options.signal?.aborted) {
          await this.sessions.append(
            session,
            this.cancelEvent(session.id, "Run cancelled by operator"),
          );
        } else {
          await this.sessions.markInterrupted(session);
        }
      }
      sessionResult = {
        sessionId: session.id,
        status: options.signal?.aborted ? "cancelled" : "failed",
        summary: options.signal?.aborted
          ? "Run cancelled by operator. No pending mutation was replayed."
          : workerError
            ? `The worker failed: ${workerError.message}`
            : "The worker exited before completing the session.",
        changedFiles: [],
      };
    }
    options.signal?.removeEventListener("abort", abortWorker);
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
          "REQUESTY_API_KEY",
          "OPENAI_API_KEY",
          "OPENROUTER_API_KEY",
          "GROQ_API_KEY",
          "GEMINI_API_KEY",
          "GOOGLE_API_KEY",
          "GOOGLE_AI_STUDIO_API_KEY",
          "XAI_API_KEY",
          "FORGE_BASE_URL",
          "FORGE_MODEL",
          "FORGE_MAX_TOKENS",
          "FORGE_TOKEN_PARAMETER",
          "FORGE_REASONING_EFFORT",
          "FORGE_PROVIDER_RETRIES",
          "FORGE_MAX_READONLY_TOOLS",
          "FORGE_STREAM",
          "FORGE_HTTP_REFERER",
          "FORGE_APP_NAME",
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
      ...(options.parallelReadOnly === undefined
        ? {}
        : { FORGE_PARALLEL_READONLY: options.parallelReadOnly ? "1" : "0" }),
      ...(options.maxTotalTurns === undefined
        ? {}
        : { FORGE_MAX_TOTAL_TURNS: String(options.maxTotalTurns) }),
      ...(options.costProfile === undefined
        ? {}
        : { FORGE_COST_PROFILE: options.costProfile }),
      ...(options.systemPrompt === undefined
        ? {}
        : { FORGE_SYSTEM_PROMPT: options.systemPrompt.slice(0, 20_000) }),
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
