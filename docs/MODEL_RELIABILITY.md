# Model reliability layer

Forge should make weaker models safer by shrinking autonomy instead of silently lowering correctness standards.

## Policy model

`apps/forge-cli/src/reliability.ts` turns capability observations into an execution envelope:

- weak planning/instruction following -> require plan review and repository inspection before mutation
- weak coding -> smaller mutation batches
- weak debugging/recovery -> earlier replanning/escalation
- weak verification -> independent review
- every model -> evidence-gated completion

The policy is deliberately conservative: capability scores are observations, not permissions. The supervisor remains the authority for tool execution and completion.

## Capability observations

A caller can update a model profile after verified outcomes. Updates use a bounded moving weight so one lucky or unlucky task cannot rewrite the model's profile.

Recommended observation sources:

- targeted test results for coding/debugging
- accepted/rejected plans for planning
- successful tool contracts for tool use
- independent review for verification
- successful recovery after a classified failure for recovery

Natural-language confidence is not evidence.

## Escalation

`decideEscalation()` prevents blind retry loops. Depending on risk and failure count it requests inspection, replanning, independent review, a stronger model, or human intervention.

## Claims

Important model claims can be represented as typed checks (`file-changed`, `test-passed`, `symbol-exists`, `command-succeeded`) and fingerprinted for evidence records. A claim summary is complete only when at least one claim exists and every claim is independently verified.

## Integration rule

This module is intentionally policy-only. It must not bypass `ForgeSupervisor`, `PolicyEngine`, approval scopes, or verification gates. Runtime integration should feed the derived policy into those existing authorities rather than creating a second execution authority.
