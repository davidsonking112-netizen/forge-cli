import type {
  AgentPlanEvent,
  ForgeEvent,
  SessionCompleteEvent,
  ToolResultEvent,
} from "../../../packages/protocol/src/index.js";
import type { ToolName } from "../../../packages/protocol/src/index.js";
import { classifyTaskIntent, type TaskIntent } from "./task-intent.js";

export type ExecutionPhase =
  | "intake"
  | "inspect"
  | "plan"
  | "milestone"
  | "implement"
  | "targeted-verify"
  | "evidence"
  | "repair"
  | "full-verify"
  | "summarize";

export type ExecutionStatus = "active" | "blocked" | "completed" | "failed";
export type UserFacingStage = "understand" | "act" | "verify" | "report";
export type ActionLevel = "read" | "write" | "run";

export function userFacingStage(phase: ExecutionPhase): UserFacingStage {
  if (["intake", "inspect", "plan", "milestone"].includes(phase))
    return "understand";
  if (["implement", "repair"].includes(phase)) return "act";
  if (["targeted-verify", "evidence", "full-verify"].includes(phase))
    return "verify";
  return "report";
}

export function actionLevelForTool(tool: ToolName): ActionLevel {
  if (READ_TOOLS.has(tool)) return "read";
  if (MUTATION_TOOLS.has(tool)) return "write";
  return "run";
}

export function userFacingOutcome(
  status: ExecutionStatus,
): "done" | "blocked" | "failed" | "cancelled" | "active" {
  if (status === "completed") return "done";
  if (status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  return "active";
}

export interface ExecutionBudget {
  providerTurns: number;
  maxProviderTurns: number;
  toolCalls: number;
  maxToolCalls: number;
  repairAttempts: number;
  maxRepairAttempts: number;
}

export interface ExecutionStateSnapshot {
  phase: ExecutionPhase;
  status: ExecutionStatus;
  stepId?: string;
  stepIndex: number;
  totalSteps: number;
  artifact: string;
  artifactId: string;
  entryConditions: string[];
  requiredArtifact: string;
  exitCondition: string;
  failureTransition: string;
  note: string;
  budget: ExecutionBudget;
}

export interface CompletionGate {
  ok: boolean;
  reason: string;
}

const READ_TOOLS = new Set<ToolName>([
  "workspace.list",
  "workspace.search",
  "workspace.read",
  "workspace.diff",
  "git.status",
]);

const MUTATION_TOOLS = new Set<ToolName>([
  "workspace.apply_patch",
  "workspace.apply_unified_diff",
  "git.branch",
  "git.stage",
  "git.commit",
]);

const CONTRACTS: Record<
  ExecutionPhase,
  Omit<
    ExecutionStateSnapshot,
    | "phase"
    | "status"
    | "stepId"
    | "stepIndex"
    | "totalSteps"
    | "artifactId"
    | "note"
    | "budget"
  >
> = {
  intake: {
    artifact: "task-contract",
    entryConditions: ["A bounded user prompt has been accepted."],
    requiredArtifact: "Task goal, workspace, policy, and provider boundary.",
    exitCondition:
      "The approved workspace exists and a session start is recorded.",
    failureTransition:
      "Fail closed with WORKSPACE_INVALID or SESSION_START_FAILED.",
  },
  inspect: {
    artifact: "inspection-evidence",
    entryConditions: ["The session contract is recorded."],
    requiredArtifact:
      "Bounded repository context or a successful read-only tool result.",
    exitCondition:
      "Relevant files, instructions, and verification surfaces are known.",
    failureTransition:
      "Return to inspect with a bounded retry, then fail without mutation.",
  },
  plan: {
    artifact: "execution-plan",
    entryConditions: ["Inspection evidence exists."],
    requiredArtifact:
      "A goal, ordered steps, assumptions, and verification requirements.",
    exitCondition:
      "At least one implementation/review milestone is defined or the task is read-only.",
    failureTransition:
      "Request a plan or re-plan; never enter implementation directly.",
  },
  milestone: {
    artifact: "milestone-contract",
    entryConditions: ["An execution plan exists."],
    requiredArtifact:
      "One bounded step with expected files, preconditions, and a check.",
    exitCondition:
      "The next change unit is selected and its prerequisite state is stable.",
    failureTransition: "Return to plan and create a smaller change unit.",
  },
  implement: {
    artifact: "approved-change",
    entryConditions: [
      "A milestone is defined and its tool proposal is policy-eligible.",
    ],
    requiredArtifact:
      "An approved contained patch or explicitly approved local Git mutation.",
    exitCondition:
      "The supervisor observes a successful mutation result and changed-file evidence.",
    failureTransition:
      "Enter repair; retry with a different bounded approach up to the repair ceiling.",
  },
  "targeted-verify": {
    artifact: "targeted-verification",
    entryConditions: ["A mutation result succeeded."],
    requiredArtifact:
      "A targeted test, syntax check, typecheck, or focused behavior check.",
    exitCondition:
      "The targeted command returns exit code 0 and produces a structured check.",
    failureTransition:
      "Enter repair with the exact command, exit code, and bounded output.",
  },
  evidence: {
    artifact: "evidence-bundle",
    entryConditions: ["At least one verification result exists."],
    requiredArtifact:
      "Changed files correlated with tool results and verification output.",
    exitCondition:
      "The supervisor has enough evidence to decide whether full verification is required.",
    failureTransition:
      "Return to targeted verification or repair; model text cannot satisfy the gate.",
  },
  repair: {
    artifact: "repair-attempt",
    entryConditions: [
      "A tool, verification, provider, or state transition failed.",
    ],
    requiredArtifact:
      "A different bounded strategy and a recorded reason for the retry.",
    exitCondition:
      "A new tool result succeeds, or the bounded repair budget is exhausted.",
    failureTransition:
      "After the ceiling, fail honestly and preserve the evidence trail.",
  },
  "full-verify": {
    artifact: "full-verification",
    entryConditions: ["The change unit has targeted evidence."],
    requiredArtifact:
      "The project’s required test/build/type/browser checks or an explicit read-only exemption.",
    exitCondition:
      "Every required recorded check passes and the workspace evidence is current.",
    failureTransition:
      "Enter repair; stale, missing, or failed evidence blocks completion.",
  },
  summarize: {
    artifact: "completion-summary",
    entryConditions: ["All required gates for this task type passed."],
    requiredArtifact:
      "A bounded summary, changed-file list, checks, and limitations.",
    exitCondition:
      "The supervisor emits session.complete only after the completion gate passes.",
    failureTransition:
      "Rewrite false completion as failed or blocked; never trust 'done' text alone.",
  },
};

export class ImplementationStateMachine {
  private snapshot: ExecutionStateSnapshot;
  private readonly intent: TaskIntent;
  private readonly requiresMutation: boolean;
  private planReady = false;
  private inspectionEvidence = false;
  private mutationApplied = false;
  private verificationPassed = false;
  private targetedVerificationPassed = false;
  private fullVerificationPassed = false;
  private verificationCount = 0;
  private mutationCount = 0;
  private pendingMilestoneVerifications = 0;
  private repairCount = 0;
  private hasFailure = false;
  private hasSummary = false;
  private transitionCount = 0;
  private readonly maxTransitions: number;

  public constructor(
    private readonly prompt: string,
    options: {
      maxProviderTurns?: number;
      maxToolCalls?: number;
      maxRepairAttempts?: number;
      maxTransitions?: number;
    } = {},
  ) {
    this.intent = classifyTaskIntent(prompt);
    this.requiresMutation =
      this.intent.mode === "change" && this.intent.allowsMutation;
    this.maxTransitions = options.maxTransitions ?? 128;
    this.snapshot = this.makeSnapshot(
      "intake",
      `Accepted bounded ${this.intent.mode} task contract. ${this.intent.rationale}`,
      "task",
    );
    this.snapshot.budget = {
      providerTurns: 0,
      maxProviderTurns: options.maxProviderTurns ?? 64,
      toolCalls: 0,
      maxToolCalls: options.maxToolCalls ?? 128,
      repairAttempts: 0,
      maxRepairAttempts: options.maxRepairAttempts ?? 4,
    };
  }

  public initialSnapshots(): ExecutionStateSnapshot[] {
    return [
      this.snapshot,
      this.transitionTo(
        "inspect",
        "Workspace inspection is the first executable state.",
      ),
    ];
  }

  public observe(event: ForgeEvent): ExecutionStateSnapshot | undefined {
    if (event.type === "agent.plan") {
      this.acceptPlan(event);
      return this.transitionTo(
        "milestone",
        "Execution plan artifact accepted; defining the next bounded milestone.",
        event.steps.find((step) => step.status === "active")?.id,
      );
    }
    if (event.type === "agent.repair") {
      this.repairCount = Math.max(this.repairCount, event.attempt);
      this.hasFailure =
        event.status === "failed" || event.status === "exhausted";
      return this.transitionTo(
        "repair",
        `Repair ${event.status}: ${event.reason}`,
      );
    }
    if (event.type === "tool.proposal") return this.observeProposal(event.tool);
    if (event.type === "tool.result")
      return this.observeToolResult(
        event.tool,
        event.ok,
        event.output,
        event.error?.message,
        event.verificationKind,
      );
    if (event.type === "error") {
      this.hasFailure = true;
      return this.transitionTo(
        "repair",
        `${event.error.code}: ${event.error.message}`,
      );
    }
    if (event.type === "session.complete") {
      this.hasSummary = true;
      return this.transitionTo(
        event.status === "completed" ? "summarize" : "repair",
        event.status === "completed"
          ? "Completion claim received; awaiting supervisor evidence gate."
          : event.summary,
        undefined,
        event.status === "completed" ? "active" : "failed",
      );
    }
    return undefined;
  }

  public recordProviderTurn(): void {
    this.snapshot.budget.providerTurns += 1;
  }

  public proposalGate(tool: ToolName): CompletionGate {
    if (MUTATION_TOOLS.has(tool) && !this.planReady)
      return {
        ok: false,
        reason:
          "A mutation proposal is blocked until Forge has an execution-plan artifact.",
      };
    if (MUTATION_TOOLS.has(tool) && !this.intent.allowsMutation)
      return {
        ok: false,
        reason: `This task is ${this.intent.mode}-only; Forge will not accept a workspace change for it.`,
      };
    if (
      MUTATION_TOOLS.has(tool) &&
      this.snapshot.phase === "repair" &&
      this.repairCount >= this.snapshot.budget.maxRepairAttempts
    )
      return {
        ok: false,
        reason:
          "The bounded repair budget is exhausted; no further mutation proposal is accepted.",
      };
    return {
      ok: true,
      reason: "Tool proposal satisfies the current state entry conditions.",
    };
  }

  public block(reason: string): ExecutionStateSnapshot {
    this.hasFailure = true;
    return this.transitionTo("repair", reason, undefined, "blocked");
  }

  public completionGate(event: SessionCompleteEvent): CompletionGate {
    if (event.status !== "completed")
      return {
        ok: true,
        reason: "The session is already failed or cancelled.",
      };
    if (this.snapshot.budget.toolCalls > this.snapshot.budget.maxToolCalls)
      return {
        ok: false,
        reason: "The execution tool-call budget was exceeded.",
      };
    if (this.requiresMutation) {
      if (!this.planReady)
        return {
          ok: false,
          reason: "Change task completed without an execution-plan artifact.",
        };
      if (!this.mutationApplied || event.changedFiles.length === 0)
        return {
          ok: false,
          reason:
            "Change task completed without a successful approved change and changed-file evidence.",
        };
      if (
        this.pendingMilestoneVerifications > 0 ||
        !this.targetedVerificationPassed ||
        !this.fullVerificationPassed ||
        event.checks.length === 0 ||
        event.checks.some((check) => !check.ok)
      )
        return {
          ok: false,
          reason:
            "Change task completed without passing supervisor milestone verification for every change plus both targeted and full verification evidence.",
        };
    } else if (this.intent.mode === "plan") {
      if (!this.planReady)
        return {
          ok: false,
          reason: "Plan task completed without an execution-plan artifact.",
        };
    } else if (!this.inspectionEvidence && !this.planReady) {
      return {
        ok: false,
        reason: "Read-only task completed without inspection or plan evidence.",
      };
    }
    return { ok: true, reason: "Completion gates have supervisor evidence." };
  }

  public acceptCompletion(): ExecutionStateSnapshot {
    return this.transitionTo(
      "summarize",
      "Supervisor completion gate passed; completion evidence is accepted.",
      undefined,
      "completed",
    );
  }

  public current(): ExecutionStateSnapshot {
    return this.snapshot;
  }

  private acceptPlan(event: AgentPlanEvent): void {
    this.planReady = event.steps.length > 0 || event.goal.trim().length > 0;
    this.snapshot.totalSteps = Math.max(1, event.steps.length);
  }

  private observeProposal(tool: ToolName): ExecutionStateSnapshot | undefined {
    this.snapshot.budget.toolCalls += 1;
    if (this.snapshot.budget.toolCalls > this.snapshot.budget.maxToolCalls) {
      this.hasFailure = true;
      return this.transitionTo(
        "repair",
        "Tool-call budget exceeded before another proposal could be approved.",
        undefined,
        "blocked",
      );
    }
    if (tool === "process.run" || tool === "browser.smoke")
      return this.transitionTo(
        this.mutationApplied ? "targeted-verify" : "full-verify",
        `Awaiting approval for verification command ${tool}.`,
      );
    if (MUTATION_TOOLS.has(tool))
      return this.transitionTo(
        "implement",
        `Awaiting approval for milestone change ${tool}.`,
      );
    if (READ_TOOLS.has(tool))
      return this.transitionTo(
        this.planReady ? "plan" : "inspect",
        `Awaiting bounded read-only evidence from ${tool}.`,
      );
    return undefined;
  }

  private observeToolResult(
    tool: ToolName,
    ok: boolean,
    output: unknown,
    error?: string,
    verificationKind?: ToolResultEvent["verificationKind"],
  ): ExecutionStateSnapshot | undefined {
    if (!ok) {
      this.hasFailure = true;
      return this.transitionTo(
        "repair",
        `${tool} failed: ${error || "no error detail"}`,
      );
    }
    if (READ_TOOLS.has(tool)) {
      this.inspectionEvidence = true;
      return this.transitionTo(
        this.planReady ? "milestone" : "plan",
        `${tool} produced bounded inspection evidence.`,
      );
    }
    if (MUTATION_TOOLS.has(tool)) {
      const changed = this.extractChangedFiles(output);
      this.mutationApplied =
        changed.length > 0 ||
        tool === "git.branch" ||
        tool === "git.stage" ||
        tool === "git.commit";
      this.mutationCount += 1;
      this.snapshot.stepIndex = Math.min(
        this.snapshot.totalSteps,
        this.snapshot.stepIndex + 1,
      );
      return this.transitionTo(
        "targeted-verify",
        `${tool} succeeded with ${changed.length || 1} mutation evidence item(s).`,
      );
    }
    if (tool === "process.run" || tool === "browser.smoke") {
      this.verificationCount += 1;
      const record =
        output && typeof output === "object" && !Array.isArray(output)
          ? (output as Record<string, unknown>)
          : {};
      const exitCode = record.exitCode;
      const command = String(record.command ?? "");
      this.verificationPassed = ok && exitCode === 0;
      const targetedCheck =
        verificationKind !== undefined
          ? verificationKind !== "broad"
          : tool === "browser.smoke" ||
            /--check\b|\bsyntax\b|\bfocused\b|\bsmoke\b/i.test(command);
      const broadCheck =
        !targetedCheck &&
        /\b(test|build|typecheck|check|verify|lint|compile)\b/i.test(command);
      if (this.verificationPassed) {
        if (targetedCheck && !this.targetedVerificationPassed)
          this.targetedVerificationPassed = true;
        if (broadCheck && this.targetedVerificationPassed)
          this.fullVerificationPassed = true;
      }
      return this.transitionTo(
        this.verificationPassed
          ? this.fullVerificationPassed
            ? "full-verify"
            : "evidence"
          : "repair",
        this.verificationPassed
          ? `${tool} passed with structured exit evidence${broadCheck ? " for a full project check" : ""}.`
          : `${tool} did not produce a passing exit-code evidence record.`,
        undefined,
        this.verificationPassed ? "active" : "blocked",
      );
    }
    return undefined;
  }

  public requireMilestoneVerification(): void {
    this.pendingMilestoneVerifications += 1;
  }

  public recordMilestoneVerification(
    event: ToolResultEvent,
  ): ExecutionStateSnapshot | undefined {
    if (
      !event.milestoneId ||
      (event.tool !== "process.run" && event.tool !== "browser.smoke")
    )
      return undefined;
    const output =
      event.output &&
      typeof event.output === "object" &&
      !Array.isArray(event.output)
        ? (event.output as Record<string, unknown>)
        : {};
    const passed = event.ok && output.exitCode === 0;
    this.verificationCount += 1;
    if (passed) {
      this.pendingMilestoneVerifications = Math.max(
        0,
        this.pendingMilestoneVerifications - 1,
      );
      this.verificationPassed = true;
      this.targetedVerificationPassed = true;
      return this.transitionTo(
        this.fullVerificationPassed ? "full-verify" : "evidence",
        `Supervisor-required milestone ${event.milestoneId} passed ${event.verificationKind ?? event.tool}.`,
        event.milestoneId,
      );
    }
    this.hasFailure = true;
    return this.transitionTo(
      "repair",
      `Supervisor-required milestone ${event.milestoneId} failed: ${event.failureKind ?? event.error?.message ?? "no exit-code evidence"}.`,
      event.milestoneId,
      "blocked",
    );
  }

  private extractChangedFiles(output: unknown): string[] {
    if (!output || typeof output !== "object" || Array.isArray(output))
      return [];
    const record = output as Record<string, unknown>;
    const values = [record.path, record.files, record.changedFiles];
    return values.flatMap((value) =>
      typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [],
    );
  }

  private transitionTo(
    phase: ExecutionPhase,
    note: string,
    stepId?: string,
    status: ExecutionStatus = "active",
  ): ExecutionStateSnapshot {
    if (this.transitionCount >= this.maxTransitions && phase !== "repair") {
      phase = "repair";
      status = "blocked";
      note =
        "State-transition budget exceeded; Forge stopped before another action.";
    }
    this.transitionCount += 1;
    this.snapshot = this.makeSnapshot(
      phase,
      note,
      `${phase}-${this.transitionCount}`,
      stepId,
      status,
    );
    this.snapshot.budget = {
      providerTurns: this.snapshot.budget.providerTurns,
      maxProviderTurns: this.snapshot.budget.maxProviderTurns,
      toolCalls: this.snapshot.budget.toolCalls,
      maxToolCalls: this.snapshot.budget.maxToolCalls,
      repairAttempts: Math.max(
        this.snapshot.budget.repairAttempts,
        this.repairCount,
      ),
      maxRepairAttempts: this.snapshot.budget.maxRepairAttempts,
    };
    return this.snapshot;
  }

  private makeSnapshot(
    phase: ExecutionPhase,
    note: string,
    artifactId: string,
    stepId?: string,
    status: ExecutionStatus = "active",
  ): ExecutionStateSnapshot {
    const contract = CONTRACTS[phase];
    return {
      phase,
      status,
      ...(stepId ? { stepId } : {}),
      stepIndex: this.snapshot?.stepIndex ?? 0,
      totalSteps: this.snapshot?.totalSteps ?? 6,
      artifact: contract.artifact,
      artifactId,
      entryConditions: [...contract.entryConditions],
      requiredArtifact: contract.requiredArtifact,
      exitCondition: contract.exitCondition,
      failureTransition: contract.failureTransition,
      note: note.slice(0, 1_000),
      budget: this.snapshot?.budget ?? {
        providerTurns: 0,
        maxProviderTurns: 64,
        toolCalls: 0,
        maxToolCalls: 128,
        repairAttempts: 0,
        maxRepairAttempts: 4,
      },
    };
  }
}
