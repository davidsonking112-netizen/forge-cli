# PR #3 execution-contract and runtime hardening

This workstream targets the remaining architectural issues identified during the Forge review.

## Implemented in this follow-up

1. Canonical task-intent classification now uses explicit precedence and typed signals for proposal, read-only, planning, inspection, execution, and mutation language.
2. Explicit non-mutating language overrides incidental mutation vocabulary unless the same request clearly grants positive mutation authority.
3. Adversarial task-intent regression coverage is expanded substantially.
4. Long-horizon compaction ranks task-critical evidence semantically: immutable system constraints and current task anchors first, then verification/mutation/failure evidence, then ordinary history.
5. Historical summaries remain explicitly non-authoritative and preserve stable safety markers across repeated compaction.
6. Long-task regression coverage checks that the current task, failures, verification evidence, and safety marker survive aggressive compaction.
7. Clean Python package installation and dependency auditing are part of CI.

## Remaining follow-up

The Python worker still contains legacy local prompt heuristics (`high_risk_goal` / `_requires_mutation`) used for specialist routing and text-only recovery. Removing those requires a whole-file refactor of the large worker module; this is intentionally left as a separate change so the execution contract is not duplicated or partially removed in an unsafe way.

## Release rule

No PR is considered complete solely because static tests pass. Provider/MCP/ACP behavior that cannot be exercised without external services is documented as integration-gated and must have bounded fixtures/refusal-path tests.

## Success criteria

- Proposal-only requests cannot pass the supervisor mutation gate.
- Simple rendering consumes structured protocol events.
- Historical summaries are clearly marked non-authoritative.
- Error/verification evidence survives compaction ahead of ordinary historical chatter.
- Intent decisions expose explicit signals and precedence.
- Clean package-install smoke tests cover the published file set.
