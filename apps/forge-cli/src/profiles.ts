import type { RiskClass } from "../../../packages/protocol/src/index.js";

export type AutonomyProfileName =
  "research" | "reviewed-edit" | "local-test" | "maintenance";

export interface AutonomyProfile {
  name: AutonomyProfileName;
  description: string;
  allowedRisks: RiskClass[];
  requiresApproval: boolean;
}

const profiles: Record<AutonomyProfileName, AutonomyProfile> = {
  research: {
    name: "research",
    description: "Read-only repository research and planning.",
    allowedRisks: ["read-only"],
    requiresApproval: false,
  },
  "reviewed-edit": {
    name: "reviewed-edit",
    description: "Read-only work plus approval-gated reversible edits.",
    allowedRisks: ["read-only", "reversible-write"],
    requiresApproval: true,
  },
  "local-test": {
    name: "local-test",
    description: "Reviewed edits plus explicitly approved local verification.",
    allowedRisks: ["read-only", "reversible-write", "local-execution"],
    requiresApproval: true,
  },
  maintenance: {
    name: "maintenance",
    description:
      "Strictly bounded local maintenance with all mutations reviewed.",
    allowedRisks: ["read-only", "reversible-write", "local-execution"],
    requiresApproval: true,
  },
};

export function getAutonomyProfile(name: string | undefined): AutonomyProfile {
  const selected = name ?? "local-test";
  const profile = profiles[selected as AutonomyProfileName];
  if (!profile) throw new Error(`Unknown autonomy profile: ${selected}`);
  return { ...profile, allowedRisks: [...profile.allowedRisks] };
}

export function listAutonomyProfiles(): AutonomyProfile[] {
  return Object.values(profiles).map((profile) => ({
    ...profile,
    allowedRisks: [...profile.allowedRisks],
  }));
}
