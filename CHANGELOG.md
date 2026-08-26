# Changelog

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
