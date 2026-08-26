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

A turn starts with a bounded repository context. The context engine detects the project type and package manager, respects standard generated directories and project ignore patterns, loads `FORGE.md` as untrusted guidance, ranks likely relevant files, records explainable selection reasons, and reports hashes and truncation. An opt-in local repository index stores only bounded metadata and symbols under Forge state; it does not persist file contents. The worker can then ask the supervisor to inspect files, search text, inspect Git state, or perform other registered tools.

The model’s provider response is normalized into text and tool calls. A tool call becomes a structured Forge proposal with a risk class. Forge executes read-only tools automatically inside the approved workspace. Writes and local processes remain visible and approval-gated by default. Named autonomy profiles can further restrict risk classes but cannot expand the global safety ceiling. Multi-file edits validate optional original hashes, create a checkpoint manifest, write the batch, and restore the checkpoint if a write fails partway through.

## Bounded specialist orchestration

`--multi-agent` enables a fixed sequential sequence of `explorer`, `implementer`, `tester`, and `reviewer` roles for provider analysis. The supervisor passes explicit limits for the number of specialists and total provider turns; the worker clamps those values to bounded ranges. Delegated calls receive no tools, cannot spawn further agents, and return structured `agent.delegation` events. The final summary is merged by the bounded orchestrator and is advisory; ordinary supervisor approval remains necessary for any actual workspace mutation.

This design is intentionally not unrestricted autonomous delegation. It is a bounded analysis pipeline that makes specialist activity visible while preserving one authority for filesystem and process actions.

## Session lifecycle and recovery

Session records track `running`, `completed`, `failed`, `cancelled`, and `interrupted` states. Each `agent.plan` event updates a bounded plan snapshot and a step journal in the record. The journal records stable step IDs, state, bounded proposal IDs, tool-result counts, the last tool, and the last approval decision. If a worker exits without a completion event, the supervisor marks the recorded session interrupted rather than presenting a false success.

New sessions retain a bounded workspace fingerprint derived from file paths, sizes, changed-file metadata, and relevant-file content already collected for context. `forge session resume` re-collects context and refuses to continue when the fingerprint has drifted; it increments the source session’s resume count only after a valid prompt and successful freshness check. Recovery starts a new supervised run and never replays a previous mutation automatically. `forge inspect` exposes the journal and fingerprint, while `forge verify` inspects stored evidence without replaying commands.

## Protocol

Every message is one JSON object per line with `protocol`, `id`, `sessionId`, `type`, and `timestamp`. Standard output is reserved for protocol messages; standard error is reserved for diagnostics. Every tool proposal has a named tool, risk classification, JSON arguments, and reason. Every tool result reports approval, success, duration, and either bounded output or a structured error. Session starts may include a bounded workspace fingerprint, approval-session results may include an expiring exact-argument scope, and completion checks may include typed verification status, finish time, truncation state, and evidence fingerprint. The protocol includes delegation events so the line renderer, TUI, session records, and inspection command can account for specialist work.

The contract is provider-neutral. OpenAI-compatible chat-completion responses are normalized into the same internal events. MCP is a local stdio JSON-RPC client used from explicit CLI commands, while ACP is a bounded local JSON-RPC adapter rather than a complete editor plugin or remote transport. Verification results are generated from supervisor tool results, including actual exit codes, bounded output, and failure state rather than model assertions.

## Editing and policy extension boundaries

Unified diffs are parsed into bounded file patches and hunks before they reach the supervisor. The applier validates paths, context lines, declared line counts, file existence, and optional original hashes. It supports modifications, additions, deletions, and renames through the existing checkpoint transaction. `forge review` is read-only, and `forge preview-diff` additionally reports intended actions, current hashes, byte changes, and stale conflicts without writing; `forge apply-diff` requires interactive approval.

Policy packs may only add deny rules for risk classes or built-in tools. `forge policy explain` reports the global ceiling, profile restrictions, policy-pack restrictions, approval requirement, and final decision. Extension loading validates local JSON manifests against a typed metadata contract; v0.7 recipes may declare bounded context globs and verification command arguments as inert metadata, but no recipe executes, loads third-party modules, or replaces built-in tools. Both surfaces remain below the global safety ceiling.

## MCP boundary

MCP servers are loaded from the local integrations configuration, remain disabled by default, and are represented as untrusted external processes. `forge mcp validate` checks configuration size, shape, identifiers, arguments, and duplicate IDs without launching a server. `forge mcp tools <id> --enable` may initialize an explicitly enabled stdio server for tool discovery. `forge mcp call <id> <tool> [json] --enable` additionally requires an interactive `YES` approval before invocation. The child receives a minimal environment, communication is JSON-RPC over stdio, requests have timeouts, response lines have size limits, stderr is drained, and child stream errors are normalized. Forge does not support remote MCP transports or a remote server marketplace in v0.7.

## Runtime boundaries

The worker does not receive unrestricted filesystem or process capabilities. The supervisor canonicalizes paths, rejects traversal and sensitive file names, applies output and time limits, and records tool events. Project instruction files can describe coding conventions but cannot change the policy engine. Sessions store bounded event history with restrictive local permissions and redact common command secret patterns. `--no-record` keeps the generated session identifier for protocol correlation but skips local session persistence.

## Terminal and Git surfaces

Interactive terminals can use the full-screen workspace renderer, which shows conversation, plan steps, specialist activity, tool activity, approvals, and completion state in an alternate screen. `--simple` selects the line-oriented renderer, and JSONL mode remains available for scripts and CI.

Local Git status, branch, stage, and commit operations remain approval-gated. `forge git prepare-pr` is read-only: it packages the current local diff into a title/body draft and explicitly performs no commit, network operation, push, or remote pull-request submission.
