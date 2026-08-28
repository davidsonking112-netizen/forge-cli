import { createHash } from "node:crypto";

export type Capability =
  | "planning"
  | "coding"
  | "debugging"
  | "toolUse"
  | "verification"
  | "instructionFollowing"
  | "contextRetention"
  | "recovery";

export interface CapabilityProfile {
  readonly model: string;
  readonly scores: Readonly<Record<Capability, number>>;
  readonly sampleCount: number;
  readonly assessedAt: string;
}

export interface ReliabilityPolicy {
  readonly planReview: boolean;
  readonly independentReview: boolean;
  readonly maxMutationFiles: number;
  readonly maxConsecutiveFailures: number;
  readonly requireEvidenceForCompletion: boolean;
  readonly escalateAfterFailures: number;
  readonly inspectBeforeMutation: boolean;
}

const CAPABILITIES: readonly Capability[] = [
  "planning",
  "coding",
  "debugging",
  "toolUse",
  "verification",
  "instructionFollowing",
  "contextRetention",
  "recovery",
];

const defaults: Record<Capability, number> = {
  planning: 0.5,
  coding: 0.5,
  debugging: 0.5,
  toolUse: 0.5,
  verification: 0.5,
  instructionFollowing: 0.5,
  contextRetention: 0.5,
  recovery: 0.5,
};

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function createCapabilityProfile(
  model: string,
  overrides: Partial<Record<Capability, number>> = {},
): CapabilityProfile {
  const scores = {} as Record<Capability, number>;
  for (const capability of CAPABILITIES)
    scores[capability] = clamp(overrides[capability] ?? defaults[capability]);
  return {
    model,
    scores,
    sampleCount: 0,
    assessedAt: new Date().toISOString(),
  };
}

export function updateCapability(
  profile: CapabilityProfile,
  capability: Capability,
  observedQuality: number,
): CapabilityProfile {
  const quality = clamp(observedQuality);
  const count = profile.sampleCount + 1;
  const old = profile.scores[capability];
  // Conservative Bayesian-style smoothing: new observations matter, but never erase history.
  const weight = Math.min(0.35, 1 / Math.sqrt(count));
  const scores = { ...profile.scores, [capability]: old * (1 - weight) + quality * weight };
  return { ...profile, scores, sampleCount: count, assessedAt: new Date().toISOString() };
}

export function deriveReliabilityPolicy(profile: CapabilityProfile): ReliabilityPolicy {
  const weakPlanning = profile.scores.planning < 0.65;
  const weakCoding = profile.scores.coding < 0.65;
  const weakDebugging = profile.scores.debugging < 0.65;
  const weakVerification = profile.scores.verification < 0.7;
  const weakRecovery = profile.scores.recovery < 0.65;
  const weakInstructionFollowing = profile.scores.instructionFollowing < 0.75;
  return {
    planReview: weakPlanning || weakInstructionFollowing,
    independentReview: weakVerification || weakDebugging || weakCoding,
    maxMutationFiles: weakCoding ? 2 : 8,
    maxConsecutiveFailures: weakRecovery ? 2 : 4,
    requireEvidenceForCompletion: true,
    escalateAfterFailures: weakRecovery || weakDebugging ? 2 : 3,
    inspectBeforeMutation: weakPlanning || weakCoding,
  };
}

export interface ExecutionObservation {
  readonly capability: Capability;
  readonly quality: number;
  readonly evidence: string[];
}

export function applyObservations(
  profile: CapabilityProfile,
  observations: readonly ExecutionObservation[],
): CapabilityProfile {
  return observations.reduce(
    (current, observation) => updateCapability(current, observation.capability, observation.quality),
    profile,
  );
}

export interface EscalationDecision {
  readonly escalate: boolean;
  readonly reason: string;
  readonly suggestedAction: "inspect" | "replan" | "review" | "stronger-model" | "human";
}

export function decideEscalation(
  profile: CapabilityProfile,
  policy: ReliabilityPolicy,
  failures: number,
  taskRisk: "low" | "medium" | "high" = "medium",
): EscalationDecision {
  if (failures >= policy.maxConsecutiveFailures) {
    return {
      escalate: true,
      reason: "failure budget exhausted",
      suggestedAction: taskRisk === "high" ? "human" : "stronger-model",
    };
  }
  if (failures >= policy.escalateAfterFailures) {
    const action = profile.scores.debugging < 0.55 ? "replan" : "stronger-model";
    return { escalate: true, reason: "repeated execution failure", suggestedAction: action };
  }
  if (taskRisk === "high" && profile.scores.verification < 0.7) {
    return { escalate: true, reason: "high-risk task with weak verification capability", suggestedAction: "review" };
  }
  return { escalate: false, reason: "within reliability envelope", suggestedAction: "inspect" };
}

export interface ClaimCheck {
  readonly claim: string;
  readonly type: "file-changed" | "test-passed" | "symbol-exists" | "command-succeeded";
  readonly subject: string;
}

export interface ClaimResult {
  readonly claim: ClaimCheck;
  readonly verified: boolean;
  readonly evidence: string;
}

export function claimFingerprint(claim: ClaimCheck): string {
  return createHash("sha256")
    .update(JSON.stringify(claim))
    .digest("hex")
    .slice(0, 16);
}

export function summarizeClaimResults(results: readonly ClaimResult[]): {
  verified: number;
  rejected: number;
  complete: boolean;
} {
  const verified = results.filter((result) => result.verified).length;
  const rejected = results.length - verified;
  return { verified, rejected, complete: results.length > 0 && rejected === 0 };
}
