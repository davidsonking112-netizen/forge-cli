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
  rationale: string;
}

const PROPOSAL_PATTERNS = [
  /\b(?:propose|suggest|recommend|outline)\b[\s\S]{0,240}\b(?:change|patch|fix|implementation|improvement)\b/i,
  /\b(?:wait|await)\b[\s\S]{0,80}\b(?:approval|approve|permission)\b/i,
  /\b(?:do not|don't|without)\b[\s\S]{0,80}\b(?:modify|change|write|edit|apply|run|execute)\b/i,
  /\b(?:what|which)\b[\s\S]{0,80}\b(?:would you change|should be changed|would you fix)\b/i,
];

const PLAN_PATTERNS = [
  /\b(?:plan|design|architect|strategy|approach)\b/i,
  /\bhow\s+should\s+(?:we|i|you)\b/i,
];

const INSPECT_PATTERNS = [
  /\b(?:inspect|review|analy[sz]e|audit|examine|investigate|find|locate|understand)\b/i,
];

const MUTATION_PATTERNS = [
  /\b(?:create|write|edit|modify|change|delete|remove|apply|fix|patch|implement|build|refactor|rename|move|install|migrate|commit|stage)\b/i,
];

const EXECUTION_PATTERNS = [
  /\b(?:run|execute|test|compile|typecheck|lint|start|launch)\b/i,
];

const EXPLICIT_READ_ONLY = /\b(?:read[- ]only|explain|tell me|show me|without changing|without modifying|do not change|don't change)\b/i;

export function classifyTaskIntent(prompt: string): TaskIntent {
  const normalized = prompt.trim();
  if (!normalized) {
    return {
      mode: "answer",
      requiresApproval: false,
      allowsMutation: false,
      allowsLocalExecution: false,
      rationale: "Empty prompt defaults to a non-mutating answer mode.",
    };
  }

  const proposal = PROPOSAL_PATTERNS.some((pattern) => pattern.test(normalized));
  const mutationRequested = MUTATION_PATTERNS.some((pattern) => pattern.test(normalized));
  const explicitReadOnly = EXPLICIT_READ_ONLY.test(normalized);
  if (proposal || (explicitReadOnly && mutationRequested)) {
    return {
      mode: "proposal",
      requiresApproval: true,
      allowsMutation: false,
      allowsLocalExecution: false,
      rationale: "The request asks for recommendations or explicitly limits execution before approval.",
    };
  }

  if (PLAN_PATTERNS.some((pattern) => pattern.test(normalized)) && !mutationRequested) {
    return {
      mode: "plan",
      requiresApproval: false,
      allowsMutation: false,
      allowsLocalExecution: false,
      rationale: "The request asks for planning or design rather than execution.",
    };
  }

  if (mutationRequested) {
    return {
      mode: "mutation",
      requiresApproval: true,
      allowsMutation: true,
      allowsLocalExecution: EXECUTION_PATTERNS.some((pattern) => pattern.test(normalized)),
      rationale: "The request explicitly asks Forge to change or create workspace state.",
    };
  }

  if (INSPECT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      mode: "inspect",
      requiresApproval: false,
      allowsMutation: false,
      allowsLocalExecution: EXECUTION_PATTERNS.some((pattern) => pattern.test(normalized)),
      rationale: "The request is primarily investigative or read-only.",
    };
  }

  return {
    mode: "answer",
    requiresApproval: false,
    allowsMutation: false,
    allowsLocalExecution: false,
    rationale: "The request does not contain an explicit workspace mutation or inspection goal.",
  };
}
