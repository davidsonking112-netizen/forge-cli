export type CapabilityName =
  | "planning"
  | "coding"
  | "debugging"
  | "toolUse"
  | "verification"
  | "instructionFollowing"
  | "contextRetention"
  | "recovery";

export interface CapabilityScores {
  planning: number;
  coding: number;
  debugging: number;
  toolUse: number;
  verification: number;
  instructionFollowing: number;
  contextRetention: number;
  recovery: number;
}

export interface CapabilityProfile {
  model: string;
  scores: CapabilityScores;
  sampleCount: number;
  updatedAt: string;
}

export interface ReliabilityPolicy {
  planReview: boolean;
  independentReview: boolean;
  inspectBeforeMutation: boolean;
  maxMutationFiles: number;
  maxConsecutiveFailures: number;
  requireEvidenceForCompletion: true;
}

export interface EscalationDecision {
  escalate: boolean;
  suggestedAction: "continue" | "review" | "stronger-model" | "replan";
  reason: string;
}

export interface CapabilityObservation {
  capability: CapabilityName;
  quality: number;
  evidence: string[];
}

const DEFAULTS: CapabilityScores = {
  planning: 0.7,
  coding: 0.7,
  debugging: 0.65,
  toolUse: 0.75,
  verification: 0.7,
  instructionFollowing: 0.8,
  contextRetention: 0.7,
  recovery: 0.6,
};

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function createCapabilityProfile(
  model: string,
  overrides: Partial<CapabilityScores> = {},
): CapabilityProfile {
  const scores = { ...DEFAULTS, ...overrides };
  return {
    model,
    scores: Object.fromEntries(
      Object.entries(scores).map(([key, value]) => [key, clamp(value as number)]),
    ) as CapabilityScores,
    sampleCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

export function deriveReliabilityPolicy(profile: CapabilityProfile): ReliabilityPolicy {
  const s = profile.scores;
  const weakPlanning = s.planning < 0.7;
  const weakVerification = s.verification < 0.75;
  const weakRecovery = s.recovery < 0.7;
  const weakInstruction = s.instructionFollowing < 0.75;
  const weakCoding = s.coding < 0.65;

  return {
    planReview: weakPlanning || weakInstruction,
    independentReview: weakVerification || weakCoding,
    inspectBeforeMutation: true,
    maxMutationFiles: weakCoding ? 2 : s.coding < 0.85 ? 4 : 8,
    maxConsecutiveFailures: weakRecovery ? 2 : 3,
    requireEvidenceForCompletion: true,
  };
}

export function decideEscalation(
  profile: CapabilityProfile,
  policy: ReliabilityPolicy,
  consecutiveFailures: number,
  risk: "low" | "medium" | "high",
): EscalationDecision {
  if (risk === "high" && policy.independentReview) {
    return { escalate: true, suggestedAction: "review", reason: "High-risk work requires independent verification." };
  }
  if (consecutiveFailures >= policy.maxConsecutiveFailures) {
    const action = profile.scores.recovery < 0.7 ? "stronger-model" : "replan";
    return { escalate: true, suggestedAction: action, reason: "Failure budget exhausted; avoid blind retries." };
  }
  if (policy.planReview && consecutiveFailures > 0) {
    return { escalate: true, suggestedAction: "replan", reason: "Weak planning capability combined with a failed attempt." };
  }
  return { escalate: false, suggestedAction: "continue", reason: "Execution remains inside the model's reliability envelope." };
}

export function applyObservations(
  profile: CapabilityProfile,
  observations: CapabilityObservation[],
): CapabilityProfile {
  let scores = { ...profile.scores };
  let samples = profile.sampleCount;
  for (const observation of observations) {
    const quality = clamp(observation.quality);
    const previous = scores[observation.capability];
    const weight = 1 / Math.min(10, samples + 2);
    scores = { ...scores, [observation.capability]: clamp(previous + (quality - previous) * weight) };
    samples += 1;
  }
  return { ...profile, scores, sampleCount: samples, updatedAt: new Date().toISOString() };
}

export interface Claim {
  claim: string;
  type: string;
  subject: string;
}

export interface ClaimResult {
  claim: Claim;
  verified: boolean;
  evidence: string;
}

export function claimFingerprint(claim: Claim): string {
  const normalized = `${claim.type}\u0000${claim.subject}\u0000${claim.claim}`.trim().toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function summarizeClaimResults(results: ClaimResult[]): {
  verified: number;
  rejected: number;
  complete: boolean;
} {
  const verified = results.filter((result) => result.verified && result.evidence.trim().length > 0).length;
  const rejected = results.length - verified;
  return { verified, rejected, complete: results.length > 0 && rejected === 0 };
}
