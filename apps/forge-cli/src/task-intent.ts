export type TaskIntentMode =
  | "answer"
  | "inspect"
  | "plan"
  | "proposal"
  | "mutation";

export interface TaskIntent {
  mode: TaskIntentMode;
  requiresApproval: boolean;
  allowsMutation: boolean;
  allowsLocalExecution: boolean;
  confidence: "explicit" | "inferred" | "default";
  signals: string[];
  rationale: string;
}

const MUTATION_WORDS = /\b(?:create|write|edit|modify|change|delete|remove|apply|fix|patch|implement|build|refactor|rename|move|install|migrate|commit|stage)\b/i;
const EXECUTION_WORDS = /\b(?:run|execute|test|compile|typecheck|lint|start|launch)\b/i;
const INSPECTION_WORDS = /\b(?:inspect|review|analy[sz]e|audit|examine|investigate|find|locate|understand|show|tell|explain)\b/i;
const PLAN_WORDS = /\b(?:plan|design|architect|strategy|approach|outline)\b/i;

const PROPOSAL_PHRASES = [
  /\b(?:propose|suggest|recommend)\b[\s\S]{0,240}\b(?:change|patch|fix|implementation|improvement)\b/i,
  /\b(?:wait|await)\b[\s\S]{0,120}\b(?:approval|approve|permission)\b/i,
  /\b(?:what|which)\b[\s\S]{0,120}\b(?:would you change|should be changed|would you fix)\b/i,
  /\b(?:show|give|provide)\b[\s\S]{0,120}\b(?:a patch|the changes|the diff)\b[\s\S]{0,120}\b(?:before|without)\b/i,
];

const READ_ONLY_PHRASES = [
  /\b(?:read[- ]only)\b/i,
  /\b(?:without|before)\b[\s\S]{0,80}\b(?:changing|modifying|editing|writing|applying|executing|running)\b/i,
  /\b(?:do not|don't|never)\b[\s\S]{0,60}\b(?:change|modify|edit|write|apply|execute|run|create|delete)\b/i,
  /\b(?:just|only)\b[\s\S]{0,40}\b(?:explain|inspect|review|analy[sz]e|show|tell)\b/i,
];

const POSITIVE_MUTATION_PHRASES = [
  /\b(?:go ahead|proceed|make|apply|implement|fix|create|delete|edit|modify|write)\b/i,
  /\b(?:you can|please)\b[\s\S]{0,40}\b(?:change|modify|edit|write|apply|implement|fix|create|delete)\b/i,
];

function result(
  mode: TaskIntentMode,
  confidence: TaskIntent["confidence"],
  signals: string[],
  rationale: string,
  overrides: Partial<TaskIntent> = {},
): TaskIntent {
  const allowsMutation = mode === "mutation";
  return {
    mode,
    requiresApproval: allowsMutation || mode === "proposal",
    allowsMutation,
    allowsLocalExecution: false,
    confidence,
    signals,
    rationale,
    ...overrides,
  };
}

export function classifyTaskIntent(prompt: string): TaskIntent {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return result(
      "answer",
      "default",
      ["empty-prompt"],
      "Empty prompt defaults to a non-mutating answer mode.",
    );
  }

  const signals: string[] = [];
  const hasMutation = MUTATION_WORDS.test(normalized);
  const hasExecution = EXECUTION_WORDS.test(normalized);
  const hasInspection = INSPECTION_WORDS.test(normalized);
  const hasPlan = PLAN_WORDS.test(normalized);
  const hasProposal = PROPOSAL_PHRASES.some((pattern) => pattern.test(normalized));
  const hasReadOnly = READ_ONLY_PHRASES.some((pattern) => pattern.test(normalized));
  const hasPositiveMutation = POSITIVE_MUTATION_PHRASES.some((pattern) => pattern.test(normalized));

  if (hasProposal) signals.push("proposal-language");
  if (hasReadOnly) signals.push("explicit-read-only");
  if (hasMutation) signals.push("mutation-language");
  if (hasPositiveMutation) signals.push("explicit-mutation");
  if (hasExecution) signals.push("execution-language");
  if (hasInspection) signals.push("inspection-language");
  if (hasPlan) signals.push("planning-language");

  // Precedence is intentional: explicit restrictions beat incidental vocabulary;
  // explicit proposal requests beat both; explicit execution authority comes next.
  if (hasReadOnly && !hasPositiveMutation) {
    return result(
      hasProposal ? "proposal" : hasPlan ? "plan" : "inspect",
      "explicit",
      signals,
      hasProposal
        ? "The request asks for a proposal while explicitly withholding mutation authority."
        : "Explicit read-only language overrides incidental mutation or execution vocabulary.",
      { allowsLocalExecution: hasProposal ? false : hasExecution },
    );
  }

  if (hasProposal) {
    return result(
      "proposal",
      "explicit",
      signals,
      "The request asks for a recommendation or proposed change rather than authorizing mutation.",
    );
  }

  if (hasPositiveMutation && hasMutation) {
    return result(
      "mutation",
      "explicit",
      signals,
      "The request explicitly authorizes Forge to change workspace state.",
      { allowsLocalExecution: hasExecution },
    );
  }

  if (hasPlan && !hasMutation) {
    return result(
      "plan",
      "explicit",
      signals,
      "The request asks for planning or design rather than workspace mutation.",
    );
  }

  if (hasInspection && !hasMutation) {
    return result(
      "inspect",
      "inferred",
      signals,
      "The request is primarily investigative or read-only.",
      { allowsLocalExecution: hasExecution },
    );
  }

  if (hasMutation) {
    return result(
      "mutation",
      "inferred",
      signals,
      "Mutation vocabulary is present without an explicit restriction, so Forge treats it as a requested change and still approval-gates execution.",
      { allowsLocalExecution: hasExecution },
    );
  }

  return result(
    "answer",
    "default",
    signals.length ? signals : ["no-action-signal"],
    "No explicit workspace mutation or inspection intent was detected.",
  );
}
