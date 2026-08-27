# Forge architecture

Forge uses a supervised hybrid runtime. The Node.js/TypeScript process is the authority for the workspace, terminal, permissions, tool execution, checkpoints, session state, integrations, and terminal UI. The Python process assembles context and proposes provider-driven actions through a versioned JSONL stream; it cannot directly change the workspace.

```text
User terminal
     |
     v
TypeScript CLI supervisor
  |  terminal UI, context, policy, tools, sessions, checkpoints, MCP client
  |  JSONL over stdin/stdout
  v
Python agent worker
  |  provider adapter, bounded conversation, optional bounded specialist analysis
  v
Model provider
```

## Agent turn

A turn starts with a bounded repository context. The context engine detects the project type and package manager, respects standard generated directories and project ignore patterns, loads `FORGE.md` as untrusted guidance, ranks likely relevant files, records explainable selection reasons, and reports hashes, included/truncated/pruned counts, and character usage. An opt-in local repository index stores only bounded metadata, symbols, and conservative relationship edges under Forge state; it does not persist file contents and is written atomically. The worker can then ask the supervisor to inspect files, search text, inspect Git state, or perform other registered tools. Provider sessions use a bounded rolling conversation buffer that preserves system/task anchors and recent evidence while compacting older messages into a deterministic summary; turn and message ceilings remain enforced.

The model’s provider response is normalized into text and tool calls. A tool call becomes a structured Forge proposal with a risk class. Forge executes read-only tools automatically inside the approved workspace. Writes and local processes remain visible and approval-gated by default. Named autonomy profiles can further restrict risk classes but cannot expand the global safety ceiling. Multi-file edits validate optional original hashes, create a checkpoint manifest, write the batch, and restore the checkpoint if a write fails partway through.

## Supervisor-enforced implementation state machine

Every run also has a supervisor-owned implementation state machine. It emits persisted `agent.state` events for `intake → inspect → plan → milestone → implement → targeted-verify → evidence → repair/full-verify → summarize`. Each phase carries entry conditions, a required artifact, an exit condition, a failure transition, and bounded provider/tool/repair budgets. The worker and provider can propose evidence, but they cannot emit an authoritative state transition.

Mutation proposals are rejected until the supervisor has observed an execution plan. A successful mutation must return changed-file evidence before the run can enter verification. For mutation tasks, completion requires a passing targeted check followed by a distinct broad project check, along with the final changed-file list and structured exit-code records. A provider response that says “done” without those artifacts is intercepted; the supervisor sends bounded gate feedback to the active provider session and refuses to accept completion after the bounded rejection ceiling. Read-only tasks use a narrower gate based on inspection or plan evidence.

The state machine improves control and evidence quality, not model reasoning. Provider intelligence remains provider-dependent, while the supervisor prevents unsupported success claims, duplicate replay, and unbounded recovery.

## Bounded specialist orchestration

`--multi-agent` enables a fixed sequential sequence of `explorer`, `implementer`, `tester`, and `reviewer` roles for provider analysis. Each role has a detailed contract covering objective, admissible evidence, uncertainty, required deliverables, quality checks, bounded output, and explicit non-authority. The supervisor passes explicit limits for the number of specialists and total provider turns; the worker clamps those values to bounded ranges. Delegated calls receive no tools, cannot spawn further agents, and return structured `agent.delegation` events. A single bounded repository context is reused across the sequence, with bounded prior-role handoff text for later review. Empty specialist output is rejected as a failed quality gate, provider failures are redacted, and the final summary is merged only from usable specialist results. The summary is advisory; ordinary supervisor approval remains necessary for any actual workspace mutation.

Cost profiles are generic execution budgets rather than model-selection directives. `balanced` preserves all four roles by default; `economy` can scope routine read-only work to fewer roles; `quality` permits larger bounded context/output and turn ceilings. A conservative goal classifier escalates mutation-oriented goals back to all four roles, including tester and reviewer. Delegation events carry non-secret profile, planned/used role and turn counts, context/output character counts, and skipped-role reasons for `forge inspect`.

This design is intentionally not unrestricted autonomous delegation. It is a bounded analysis pipeline that makes specialist activity visible while preserving one authority for filesystem and process actions.

## Session lifecycle and recovery

Session records track `running`, `completed`, `failed`, `cancelled`, and `interrupted` states. The latest supervisor-owned execution phase, artifact, contract, and budget are persisted with the record. Each `agent.plan` event updates a bounded plan snapshot and a step journal in the record. `agent.checklist` events maintain a bounded, user-facing list of expected outcomes for inspection, planning, approval, change, verification, and summary; the simple renderer and full-screen TUI display the latest checklist, while `forge inspect` exposes it for scripts and recovery review. Checklist and scratchpad entries are informational state only and cannot approve actions. The journal records stable step IDs, state, bounded proposal IDs, tool-result counts, the last tool, and the last approval decision. If a worker exits without a completion event, the supervisor marks the recorded session interrupted rather than presenting a false success.

New sessions retain a bounded workspace fingerprint derived from file paths, sizes, changed-file metadata, and relevant-file content already collected for context. `forge session recovery` classifies a source session as `continue`, `re-plan`, or `manual-intervention` using the last safe journal step, legacy-record availability, completion state, and current fingerprint. `forge session resume` persists that assessment, re-collects context, refuses drift, and starts a new supervised run without replaying a previous mutation or command. `forge inspect` exposes the journal, fingerprint, and assessment, while `forge verify` inspects stored evidence without replaying commands.

## Protocol

Every message is one JSON object per line with `protocol`, `id`, `sessionId`, `type`, and `timestamp`. Standard output is reserved for protocol messages; standard error is reserved for diagnostics. Every tool proposal has a named tool, risk classification, JSON arguments, and reason. Every tool result reports approval, success, duration, and either bounded output or a structured error. Session starts may include a bounded workspace fingerprint and recovery assessment, approval-session results may include an expiring exact-argument scope with bounded path metadata, and completion checks may include typed verification status, finish time, truncation state, evidence fingerprint, command digest, and Forge tool version. Event-specific validation rejects unknown event types, unknown tools, invalid enums, NUL bytes, and oversized fields before they enter supervisor state. The protocol includes supervisor-owned `agent.state` events with phase contracts and bounded budgets, plus bounded `agent.scratchpad` events for task, inspection, current-step, change, verification, and next-action summaries; scratchpad entries are planning metadata and never authorize tools. It also includes bounded `agent.checklist` events with item IDs, labels, user expectations, status, and optional notes. Delegation events remain available so the line renderer, TUI, session records, and inspection command can account for specialist work and non-secret budget telemetry.

The contract is provider-neutral. OpenAI-compatible chat-completion responses are normalized into the same internal events. MCP is a local stdio JSON-RPC client used from explicit CLI commands; its API supports abort signals and categorized configuration, transport, timeout, cancellation, protocol, and server failures. ACP is a bounded local JSON-RPC adapter that preserves request correlation and categorizes validation failures rather than acting as a complete editor plugin or remote transport. Verification results are generated from supervisor tool results, including actual exit codes, bounded output, and failure state rather than model assertions.

## Editing and policy extension boundaries

Unified diffs are parsed into bounded file patches and hunks before they reach the supervisor. The applier validates paths, context lines, declared line counts, file existence, and optional original hashes. It supports modifications, additions, deletions, and renames through the existing checkpoint transaction. `forge review` is read-only, and `forge preview-diff` additionally reports intended actions, current hashes, byte changes, selected files, stale conflicts, and a deterministic change-set digest without writing. `forge apply-diff` accepts an explicit bounded `--only` selection, reuses the preview preflight and digest, requires interactive approval, and applies the selected set all-or-rollback; it does not perform an automatic merge.

Policy packs may only add deny rules for risk classes or built-in tools. `forge policy explain` reports the global ceiling, profile restrictions, policy-pack restrictions, approval requirement, stable decision category, next safe action, and final decision. Exact-argument session scopes include bounded path descriptions and can be revoked during interactive approval; expiry and matching still prevent blanket authority. Extension loading validates local JSON manifests against a typed metadata contract; v0.9 adds read-only `forge extensions inspect` output for inert bounded recipes, but no recipe executes, loads third-party modules, or replaces built-in tools. Both surfaces remain below the global safety ceiling.

## MCP boundary

MCP servers are loaded from the local integrations configuration, remain disabled by default, and are represented as untrusted external processes. `forge mcp validate` checks configuration size, shape, identifiers, command safety, bounded argument count and length, NUL rejection, and duplicate IDs without launching a server. `forge mcp tools <id> --enable` may initialize an explicitly enabled stdio server for tool discovery. `forge mcp call <id> <tool> [json] --enable` additionally requires an interactive `YES` approval before invocation. The child receives a minimal environment, communication is JSON-RPC over stdio, requests have timeouts and abort cancellation, response lines have size limits, stderr is drained, and child stream errors are categorized. ACP similarly streams local JSONL input under aggregate byte and request-count caps. Forge does not support remote MCP transports or a remote server marketplace.

## Runtime boundaries

The worker does not receive unrestricted filesystem or process capabilities. The supervisor canonicalizes paths, rejects traversal and sensitive file names, applies output and time limits, and records tool events. The worker also rejects oversized or non-object input lines and redacts bounded provider/worker error messages. Project instruction files and the optional user system prompt can describe preferences but cannot change the policy engine. User prompts are bounded, stored outside the repository, and passed only to the isolated worker. Sessions store bounded event history with restrictive local permissions and redact common command secret patterns. `forge audit <session-id>` projects a redacted safety log of plans, checklists, proposals, approvals, tool results, repair attempts, and completion evidence. `--no-record` keeps the generated session identifier for protocol correlation but skips local session persistence.

## GitHub boundary

GitHub actions are separate from ordinary local Git tools and are never initiated implicitly by a model response. `forge github status` performs a bounded authentication-status inspection. `forge github connect` starts the user-controlled `gh auth login --web` handoff. `forge github create` creates a private repository from the approved workspace, `forge github clone` clones a named repository only into a bounded destination inside the approved workspace, and `forge github push` explicitly pushes a selected branch. All non-status actions require an interactive `YES` confirmation, use argument arrays rather than shell interpretation, minimize the child environment, bound output and time, and redact credential-bearing output. Forge does not request, store, or display GitHub tokens.

## Daytona boundary

Daytona is an optional supervisor-side REST integration. The worker never receives the Daytona API key or lifecycle capability. When configured with `DAYTONA_API_KEY`, `forge daytona status` performs a bounded read-only request; create, stop, and delete operations use the official API paths, bounded response sizes, and interactive `YES` confirmation. A task may associate an existing sandbox with `--daytona-sandbox`; post-task cleanup is opt-in through `--daytona-cleanup stop|delete`, and deletion is never automatic. Daytona failures are visible and are not converted into successful cleanup claims. The API key is read from the environment and is not persisted in prompts, sessions, or repository files.

## Terminal and Git surfaces

Interactive terminals can use the full-screen workspace renderer, which shows conversation, the latest checklist and expectations, plan steps, specialist activity, tool activity, approvals, and completion state in an alternate screen. `--simple` selects the line-oriented renderer, and JSONL mode remains available for scripts and CI.

Local Git status, branch, stage, and commit operations remain approval-gated. `forge git prepare-pr` is read-only: it packages the current local diff into a title/body draft and explicitly performs no commit, network operation, push, or remote pull-request submission.
