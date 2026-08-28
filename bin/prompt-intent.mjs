const APPROVAL_GATED_PATTERNS = [
  /\bwait\s+for\s+(?:the\s+)?(?:my\s+)?approval\b/i,
  /\bawait\s+(?:my\s+)?approval\b/i,
  /\bwithout\s+(?:applying|making|writing|editing|modifying)\b/i,
  /\b(?:do\s+not|don't)\s+(?:modify|change|write|edit|apply|run|execute)\b/i,
  /\b(?:propose|suggest|recommend)\b[\s\S]{0,160}\b(?:change|patch|fix|improvement|implementation)\b[\s\S]{0,160}\b(?:approval|approve)\b/i,
];

export function isApprovalGatedPrompt(prompt) {
  if (!prompt || typeof prompt !== "string") return false;
  const normalized = prompt.trim();
  return normalized.length > 0 && APPROVAL_GATED_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function normalizeExecutionPrompt(prompt) {
  if (!isApprovalGatedPrompt(prompt)) return prompt;
  return `${prompt.trim()}\n\nForge execution contract: this is an approval-gated change. Inspect and prepare the proposed change first. Do not modify, write, edit, apply, run, or execute anything before the required approval. After approval, the proposed change may be applied and verified.`;
}
