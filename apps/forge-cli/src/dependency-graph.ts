import { createHash } from "node:crypto";
import type {
  AgentGraphEvent,
  AgentPlanEvent,
  DependencyGraphStep,
  DependencyGraphStepStatus,
  PlanGraphProposalStep,
  PlanStep,
  ToolName,
} from "../../../packages/protocol/src/index.js";

export interface GraphGate {
  ok: boolean;
  reason: string;
  stepId?: string;
}

const MUTATION_TOOLS = new Set<ToolName>([
  "workspace.apply_patch",
  "workspace.apply_unified_diff",
  "git.branch",
  "git.stage",
  "git.commit",
]);

const VERIFY_TOOL: ToolName = "process.run";
const MAX_STEPS = 64;

function stableId(index: number, title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28) || "step";
  const digest = createHash("sha256")
    .update(`${index}:${title}`)
    .digest("hex")
    .slice(0, 8);
  return `step-${String(index + 1).padStart(2, "0")}-${slug}-${digest}`;
}

function legacyProposal(
  step: PlanStep,
  index: number,
  verification: string[],
): PlanGraphProposalStep {
  return {
    title: step.description.slice(0, 200) || `Plan step ${index + 1}`,
    description:
      step.description.slice(0, 2_000) || `Complete plan step ${index + 1}.`,
    expectedFiles: [],
    dependsOn: index > 0 ? [index - 1] : [],
    risks: ["Supervisor policy and approval rules apply."],
    tests: verification.slice(0, 32),
    postconditions: [`Supervisor evidence confirms completion of ${step.id}.`],
  };
}

function normalizeList(values: string[], max: number): string[] {
  return values.map((value) => value.trim().slice(0, max)).filter(Boolean);
}

export class DependencyGraph {
  private readonly planArtifactId: string;
  private readonly steps: DependencyGraphStep[];
  private readonly graphWasProposed: boolean;
  private activeStepId: string | undefined;
  private eventCount = 0;

  public constructor(plan: AgentPlanEvent) {
    const proposals = plan.graph?.length
      ? plan.graph
      : plan.steps.map((step, index) =>
          legacyProposal(step, index, plan.verification),
        );
    this.graphWasProposed = Boolean(plan.graph?.length);
    this.planArtifactId = `plan-${createHash("sha256")
      .update(JSON.stringify({ goal: plan.goal, steps: proposals }))
      .digest("hex")
      .slice(0, 16)}`;
    const ids = proposals.map((step, index) => stableId(index, step.title));
    this.steps = proposals.slice(0, MAX_STEPS).map((proposal, index) => {
      const errors = this.contractErrors(proposal, index, proposals.length);
      const dependencies = proposal.dependsOn
        .filter(
          (dependency) =>
            dependency >= 0 && dependency < ids.length && dependency !== index,
        )
        .map((dependency) => ids[dependency] as string);
      return {
        id: ids[index] as string,
        sourceId: `proposal-${index + 1}`,
        index,
        title: proposal.title.trim().slice(0, 200),
        description: proposal.description.trim().slice(0, 2_000),
        expectedFiles: normalizeList(proposal.expectedFiles, 500).slice(0, 64),
        dependencies,
        risks: normalizeList(proposal.risks, 500).slice(0, 16),
        tests: normalizeList(proposal.tests, 500).slice(0, 32),
        postconditions: normalizeList(proposal.postconditions, 1_000).slice(
          0,
          16,
        ),
        status: errors.length ? "blocked" : "pending",
        contractValid: errors.length === 0,
        contractErrors: errors,
      };
    });
    for (const index of this.cycleNodes()) {
      const step = this.steps[index];
      if (!step) continue;
      step.contractErrors = [
        ...new Set([...step.contractErrors, "dependencies contain a cycle"]),
      ].slice(0, 16);
      step.contractValid = false;
      step.status = "blocked";
    }
    this.refreshReady();
  }

  public snapshot(): DependencyGraphStep[] {
    return this.steps.map((step) => ({
      ...step,
      expectedFiles: [...step.expectedFiles],
      dependencies: [...step.dependencies],
      risks: [...step.risks],
      tests: [...step.tests],
      postconditions: [...step.postconditions],
      contractErrors: [...step.contractErrors],
    }));
  }

  public event(
    note: string,
    statusOverride?: AgentGraphEvent["status"],
  ): AgentGraphEvent {
    const status = statusOverride ?? this.status();
    return {
      protocol: 1,
      id: `graph-${this.planArtifactId}-${++this.eventCount}`,
      sessionId: "",
      type: "agent.graph",
      timestamp: new Date().toISOString(),
      version: 1,
      status,
      planArtifactId: this.planArtifactId,
      ...(this.activeStepId ? { activeStepId: this.activeStepId } : {}),
      steps: this.snapshot(),
      note: note.slice(0, 1_000),
    };
  }

  public bindEvent(event: AgentGraphEvent, sessionId: string): AgentGraphEvent {
    return { ...event, sessionId };
  }

  public actionGate(tool: ToolName): GraphGate {
    if (!MUTATION_TOOLS.has(tool) && tool !== VERIFY_TOOL)
      return {
        ok: true,
        reason: "Read-only action does not require an active graph step.",
      };
    const invalid = this.steps.find((step) => !step.contractValid);
    if (invalid)
      return {
        ok: false,
        reason: `Dependency graph contract is invalid for ${invalid.id}: ${invalid.contractErrors.join("; ")}`,
        stepId: invalid.id,
      };
    const step =
      this.activeStep() ??
      this.steps.find((candidate) => candidate.status === "ready");
    if (!step)
      return {
        ok: false,
        reason:
          "No dependency-graph step is ready; prerequisite steps must complete before this action.",
      };
    const unmet = step.dependencies.filter((dependency) => {
      const dependencyStep = this.steps.find(
        (candidate) => candidate.id === dependency,
      );
      return !dependencyStep || dependencyStep.status !== "completed";
    });
    if (unmet.length)
      return {
        ok: false,
        reason: `${step.id} is blocked because prerequisite step(s) are incomplete: ${unmet.join(", ")}.`,
        stepId: step.id,
      };
    if (step.status === "blocked" || step.status === "failed")
      return {
        ok: false,
        reason: `${step.id} is ${step.status}; repair its contract before running another action.`,
        stepId: step.id,
      };
    if (!this.activeStepId) {
      this.activeStepId = step.id;
      step.status = "active";
    }
    return {
      ok: true,
      reason: `${tool} is permitted for ready dependency-graph step ${step.id}.`,
      stepId: step.id,
    };
  }

  public markStepCompleted(stepId?: string): AgentGraphEvent | undefined {
    const step = stepId
      ? this.steps.find((candidate) => candidate.id === stepId)
      : this.activeStep();
    if (!step || !step.contractValid) return undefined;
    step.status = "completed";
    if (this.activeStepId === step.id) this.activeStepId = undefined;
    this.refreshReady();
    return this.event(
      `Dependency step ${step.id} completed with supervisor-observed evidence.`,
    );
  }

  public markStepFailed(note: string): AgentGraphEvent {
    const step = this.activeStep();
    if (step) step.status = "failed";
    return this.event(note, "failed");
  }

  public gateForStep(stepId: string): GraphGate {
    const step = this.steps.find((candidate) => candidate.id === stepId);
    if (!step)
      return { ok: false, reason: `Unknown dependency-graph step ${stepId}.` };
    const unmet = step.dependencies.filter((dependency) => {
      const dependencyStep = this.steps.find(
        (candidate) => candidate.id === dependency,
      );
      return !dependencyStep || dependencyStep.status !== "completed";
    });
    return unmet.length
      ? {
          ok: false,
          reason: `${step.id} is blocked by incomplete prerequisite(s): ${unmet.join(", ")}.`,
          stepId,
        }
      : {
          ok: step.contractValid,
          reason: step.contractValid
            ? `${step.id} contract is valid.`
            : step.contractErrors.join("; "),
          stepId,
        };
  }

  public isValid(): boolean {
    return (
      this.steps.length > 0 && this.steps.every((step) => step.contractValid)
    );
  }

  public hasIncompleteSteps(): boolean {
    return (
      this.graphWasProposed &&
      this.steps.some((step) => step.status !== "completed")
    );
  }

  public completionGate(): GraphGate {
    const invalid = this.steps.find((step) => !step.contractValid);
    if (invalid)
      return {
        ok: false,
        reason: `Dependency graph contract is invalid for ${invalid.id}: ${invalid.contractErrors.join("; ")}`,
        stepId: invalid.id,
      };
    if (this.graphWasProposed) {
      const incomplete = this.steps.find((step) => step.status !== "completed");
      if (incomplete)
        return {
          ok: false,
          reason: `Dependency graph is incomplete; ${incomplete.id} is ${incomplete.status} and its postconditions are not supervisor-verified.`,
          stepId: incomplete.id,
        };
    }
    return {
      ok: true,
      reason:
        "Dependency graph contracts and prerequisite completion are valid.",
    };
  }

  public currentStepId(): string | undefined {
    return this.activeStepId;
  }

  public proposedByModel(): boolean {
    return this.graphWasProposed;
  }

  private activeStep(): DependencyGraphStep | undefined {
    return this.activeStepId
      ? this.steps.find((step) => step.id === this.activeStepId)
      : undefined;
  }

  private status(): AgentGraphEvent["status"] {
    if (!this.isValid()) return "blocked";
    if (this.steps.every((step) => step.status === "completed"))
      return "completed";
    if (
      this.activeStepId ||
      this.steps.some(
        (step) => step.status === "ready" || step.status === "active",
      )
    )
      return "in-progress";
    return "validated";
  }

  private refreshReady(): void {
    for (const step of this.steps) {
      if (
        step.status === "completed" ||
        step.status === "failed" ||
        step.status === "active"
      )
        continue;
      if (!step.contractValid) {
        step.status = "blocked";
        continue;
      }
      const dependenciesComplete = step.dependencies.every((dependency) =>
        this.steps.some(
          (candidate) =>
            candidate.id === dependency && candidate.status === "completed",
        ),
      );
      step.status = dependenciesComplete ? "ready" : "pending";
    }
  }

  private contractErrors(
    proposal: PlanGraphProposalStep,
    index: number,
    count: number,
  ): string[] {
    const errors: string[] = [];
    if (!proposal.title.trim()) errors.push("title is required");
    if (!proposal.description.trim()) errors.push("description is required");
    if (!proposal.tests.some((test) => test.trim()))
      errors.push("at least one test is required");
    if (!proposal.postconditions.some((condition) => condition.trim()))
      errors.push("at least one postcondition is required");
    for (const dependency of proposal.dependsOn) {
      if (
        !Number.isInteger(dependency) ||
        dependency < 0 ||
        dependency >= count
      )
        errors.push(`dependency index ${dependency} is out of range`);
      if (dependency === index) errors.push("a step cannot depend on itself");
    }
    if (this.wouldCycle(index, proposal.dependsOn, count))
      errors.push("dependencies contain a cycle");
    return [...new Set(errors)].slice(0, 16);
  }

  private wouldCycle(
    index: number,
    dependencies: number[],
    count: number,
  ): boolean {
    if (dependencies.includes(index)) return true;
    return dependencies.some(
      (dependency) => dependency < 0 || dependency >= count,
    );
  }

  private cycleNodes(): Set<number> {
    const visiting = new Set<number>();
    const visited = new Set<number>();
    const cycle = new Set<number>();
    const visit = (index: number, path: number[]): boolean => {
      if (visiting.has(index)) {
        const start = path.indexOf(index);
        for (const node of path.slice(start)) cycle.add(node);
        return true;
      }
      if (visited.has(index)) return false;
      visiting.add(index);
      const step = this.steps[index];
      for (const dependency of step?.dependencies ?? []) {
        const dependencyIndex = this.steps.findIndex(
          (candidate) => candidate.id === dependency,
        );
        if (dependencyIndex >= 0) visit(dependencyIndex, [...path, index]);
      }
      visiting.delete(index);
      visited.add(index);
      return false;
    };
    for (let index = 0; index < this.steps.length; index += 1) visit(index, []);
    return cycle;
  }
}
