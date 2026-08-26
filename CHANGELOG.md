# Changelog

## 0.8.0 — 2026-08-26

Forge v0.8 adds deterministic step-aware recovery assessment through `forge session recovery`, persisted recovery decisions, and safe resume metadata. Resume never replays prior writes or commands; unchanged interrupted work can continue from its recorded step, completed or legacy records re-plan, and workspace drift requires manual intervention.

Unified-diff review now supports bounded file-level change-set selection with `--only`; selected files are previewed and applied through the same stale-validated, checkpointed, all-or-rollback transaction. Structured verification remains evidence-only and never silently re-runs commands. The opt-in local index now records bounded dependency, test, and configuration relationships and supports metadata-only queries.

Session approval scopes expose bounded path metadata and can be revoked during an interactive run; exact argument matching, expiry, approval gates, and the immutable safety ceiling remain unchanged. Local MCP calls support cancellation and categorized lifecycle errors, while ACP responses include stable request correlation and categorized validation errors. Extension recipes remain declarative inert metadata.

## 0.7.0 — 2026-08-26

Forge v0.7 adds bounded durable step journals and workspace fingerprints to recorded sessions. `forge inspect` exposes step state, journal activity, and verification evidence; `forge session resume` re-collects context, refuses workspace drift, and never replays a prior mutation automatically. Legacy v0.6 records remain readable with conservative defaults.

Structured verification records now retain typed status, exit code, bounded output, completion time, truncation state, and the workspace fingerprint used for stale detection. `forge verify` is a read-only evidence-inspection command and does not re-run commands. `forge preview-diff` reports planned file actions, current hashes, byte changes, and conflicts without writing; stale or invalid changes remain rejected by the existing transactional apply path.

The local metadata index is now incremental, reusing unchanged entries and reporting refreshed and removed files without persisting file contents. `forge policy explain` reports the global ceiling, profile and policy-pack restrictions, approval requirements, and final decision. Session approvals carry expiring exact-argument scopes rather than blanket session authority.

Extension manifests may now declare bounded context-glob and verification recipes as inert metadata. Recipes cannot execute code, load third-party modules, replace built-in tools, or lower policy. MCP and ACP remain local, bounded, explicitly enabled integration boundaries.

## 0.6.1 — 2026-08-26

The v0.6 audit patch isolates the Python worker from workspace-controlled module paths, validates workspace startup before spawning, reports unavailable interpreters without uncaught child-process errors, rejects session-ID traversal, writes session records atomically, and redacts secrets in process arguments as well as commands.

The patch also fixes numeric bound parsing, rejects malformed MCP configuration roots and NUL-containing commands, bounds MCP stdout while draining stderr, honors unified-diff trailing-newline markers, and adds regression coverage for these cases. The global safety ceiling, supervisor authority, approval gates, and local-first defaults are unchanged.

## 0.6.0 — 2026-08-26

Forge v0.6 adds bounded repository intelligence with explainable context-selection reasons and an explicit local metadata-only repository index. Index files contain paths, sizes, and bounded symbols rather than file contents, and are stored under Forge local state only when the user requests `forge index build`.

Sessions now track lifecycle status, resumable plan snapshots, and resume counts. Interrupted sessions are marked distinctly, `forge session resume` records continuation activity, and `forge inspect` reports status, profile, plan state, resume count, approval decisions, tool metrics, delegation, and verification evidence.

Verification results now reflect the actual supervisor command outcome, including nonzero exit codes and bounded output. Named autonomy profiles (`research`, `reviewed-edit`, `local-test`, and `maintenance`) can only restrict risk classes below Forge’s immutable safety ceiling; the default preserves approval-gated local testing behavior.

The v0.6 release remains local-first. It does not add remote execution, hidden background agents, automatic pushes or pull requests, unrestricted autonomy, cloud-default execution, web browsing, non-local telemetry, remote MCP transports, or executable third-party extensions.

## 0.5.5 — 2026-08-26

Forge v0.5.5 hardens the unified-diff engine against binary patches, duplicate file entries, oversized hunk coordinates, stale context, unsafe paths, and mixed file operations. Review and application remain separate workflows, with transactional checkpoints and reversible changes.

Approval events now identify automatic, user, and policy decisions. The TUI and session inspection surface these categories alongside tool timing, failures, delegation, and verification data. MCP lifecycle handling is hardened for repeated close and post-shutdown requests, while ACP and local interoperability boundaries remain bounded and explicit.

The release adds regression coverage for diff edge cases and categorized approvals, updates the v0.5.5 version across Node.js, TypeScript, Python, and lockfile metadata, and retains the guidance-only doctor and deterministic release checks. Remote MCP transports, automatic pushes or pull requests, hidden background work, unrestricted autonomy, and executable third-party extensions remain deferred.

## 0.5.0 — 2026-08-26

Forge v0.5 adds a bounded unified-diff editing and review engine. It validates diff headers, hunk counts, context lines, file existence, path containment, and stale content before applying changes. Modifications, additions, deletions, and renames use the existing checkpoint transaction and rollback boundary. `forge review` is read-only, while `forge apply-diff` requires an interactive approval.

The release adds a practical local ACP JSON-RPC line adapter with bounded payloads, normalized workspace/prompt/edit/verification/cancellation events, structured protocol errors, and explicit approval metadata. It is an adapter boundary, not a complete editor plugin or remote transport.

MCP trust management now supports approval-gated local enable/disable configuration changes, while server use remains explicitly opt-in and local stdio-only. The CLI also adds policy-pack validation and per-run loading, metadata-only extension-manifest validation, changed-file context prioritization, richer local Git contribution drafts, and inspection reports with tool timing, failures, approvals, delegation activity, provider, and verification metrics.

The release synchronizes Node.js, TypeScript, and Python package metadata at 0.5.0 and expands deterministic cross-runtime coverage. The supervisor remains the sole filesystem and process authority. Policy packs can only add restrictions; extensions cannot replace built-in tools or execute arbitrary code through the manifest loader. Remote pushes, automatic pull requests, hidden background agents, unrestricted autonomy, cloud-default execution, web browsing, non-local telemetry, marketplace/accounts/billing, and credential-sensitive network operations remain outside the release.

## 0.4.0 — 2026-08-26

Forge v0.4 adds a bounded multi-agent analysis workflow with fixed explorer, implementer, tester, and reviewer roles. Delegated specialists are sequential, budget-limited, non-recursive, tool-less, and represented by typed `agent.delegation` events; workspace and process authority remains with the TypeScript supervisor.

The release adds an MCP stdio JSON-RPC client and CLI workflows for listing configured servers, discovering tools, and calling a tool. MCP remains disabled by default: each command requires explicit `--enable`, tool calls require an interactive `YES` approval, child environments are minimized, requests are timed out, and response lines are size-limited. Remote transports and persistent enablement are intentionally deferred.

The CLI now supports `forge inspect <session-id>`, `--no-record`, bounded orchestration flags, a v0.4 TUI title and delegation rendering, and `forge git prepare-pr`. The Git preparation command is read-only and produces a local title/body/diff draft without committing, pushing, opening a pull request, or contacting a remote service.

Version metadata is synchronized across the root package, CLI package, Python package, worker metadata, and terminal UI. The release preserves workspace containment, symlink denial, sensitive-file protection, provider redaction, approval-gated writes and commands, minimal child environments, bounded output, transactional checkpoints, and deterministic offline tests.

ACP remains an adapter boundary with normalized local events rather than a complete editor plugin or remote transport. Loadable extension and policy-pack marketplace behavior, unrestricted autonomy, cloud execution, background agents, remote pushes, and non-local telemetry remain outside this release.

## 0.3.0 — 2026-08-26

Forge v0.3 adds configurable provider token and reasoning controls, bounded retry backoff, lightweight symbol-aware repository context, verification-command discovery, secure MCP/ACP-ready boundaries, a typed extension registry, and approval-gated local Git status, branch, stage, and commit operations. External servers remain disabled by default and remote pushes are not performed.

The release strengthens diagnostics by redacting provider credential values, preserves symlink and workspace containment protections, and expands deterministic tests across provider streaming, context ranking, integration registration, Git validation, and security behavior.

## 0.2.0 — In development

Forge v0.2 upgrades the v0.1 foundation into a more capable coding-agent runtime. It adds an opt-in OpenAI-compatible provider boundary with streaming and normalized tool calls, a context engine with project ignore handling and ranked relevant files, transactional multi-file edits with stale-hash detection, checkpoint manifests and undo restoration, a bounded verification proposal flow, session continuation from recorded prompts, and a full-screen terminal workspace with a plain-terminal fallback.

The default provider remains the deterministic mock provider so local tests and demonstrations stay offline and reproducible. All mutations and local execution remain visible and approval-gated by default. Destructive, network, and credential-sensitive risk classes remain denied unless an explicit future policy supports them.

The release deliberately does not include cloud sandboxes, background agents, automatic commits or pull requests, broad MCP marketplace support, ACP editor integration, or a guaranteed single-file installer.
