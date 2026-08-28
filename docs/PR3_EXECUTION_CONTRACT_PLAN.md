# PR #3 execution-contract and runtime hardening

This workstream targets the remaining architectural issues identified during the Forge review.

## Goals

1. Keep one canonical task-intent/execution contract at the supervisor boundary.
2. Remove duplicated mutation/risk heuristics from the Python worker where the supervisor already has authority.
3. Make rendering event-driven rather than parsing presentation text.
4. Keep historical context explicitly non-authoritative and prioritize failure/verification evidence.
5. Add adversarial intent, horizon, provider, integration, packaging, and clean-environment regression coverage.
6. Incrementally split oversized runtime modules without changing the public CLI/protocol contract.

## Release rule

No PR is considered complete solely because static tests pass. Provider/MCP/ACP behavior that cannot be exercised without external services is documented as integration-gated and must have bounded fixtures/refusal-path tests.

## Success criteria

- A proposal-only request cannot trigger a mutation proposal through any supported entrypoint.
- The simple renderer consumes structured protocol events.
- Historical summaries are clearly marked non-authoritative.
- Error/verification evidence survives compaction ahead of ordinary historical chatter.
- The same task intent is visible to supervisor, worker, inspection, and protocol telemetry.
- Clean packed-install smoke tests cover the published file set.
