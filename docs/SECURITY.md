# Forge security model

Forge is designed to keep the user in control of local code and system actions. The model proposes operations; the TypeScript supervisor validates and authorizes them. A model response, repository instruction file, provider response, MCP metadata, or tool description cannot weaken the local policy.

## Default policy

Read-only inspection is allowed inside the approved workspace. File mutation and local process execution require approval. Destructive operations, credential-like files, and network access are denied by default. Forge has no unrestricted auto-approval mode. Named autonomy profiles can only make this policy stricter; they cannot permit risks denied by the immutable global safety ceiling.

## Workspace containment

Forge resolves paths against the approved workspace root and rejects absolute paths, parent traversal, and paths that escape after normalization. It also rejects symbolic-link path components to avoid accidental access outside the workspace. Sensitive names such as `.env`, private keys, and common credential files are excluded from normal reads. Repository collection skips standard generated directories and project `.gitignore` patterns. The optional local repository index stores bounded paths, sizes, and symbols only; it does not persist file contents and is created only by an explicit user command.

## Editing and checkpoints

Multi-file edits validate all paths and optional original content hashes before writing. Unified-diff edits additionally validate hunk headers, context lines, line counts, file existence, and rename/delete targets. `forge preview-diff` performs the same bounded read-only analysis and reports intended actions and conflicts without writing. Forge creates a restrictive checkpoint manifest and backups before the batch is applied. If any write fails, the supervisor attempts to restore the checkpoint. Users can restore a recorded checkpoint through the `forge undo` command after confirming the target workspace. v0.7 does not claim a general three-way merge engine. Failed or stale changes are rejected before partial writes, and checkpoints remain the recovery boundary.

## Process execution

Commands run with an explicit working directory, bounded timeout, bounded combined output, and captured exit status. Shell interpretation is an explicit request rather than an implicit default. Project commands receive a minimal environment allowlist rather than the full parent environment, so provider credentials and unrelated secret variables are not inherited. The process result is returned to the agent as data and is never treated as proof that a task succeeded unless the exit status and output support that conclusion. Session completion checks preserve typed status, exit code, bounded output, finish time, truncation state, and the workspace fingerprint used to detect stale evidence. `forge verify` only inspects those records; it does not replay commands.

## Provider and prompt-injection boundaries

Provider credentials are read from environment variables or supported secret stores and are not written to project files or session records. Provider errors are redacted before they are emitted. Repository content is untrusted input. `FORGE.md` can document conventions, but it is not an authority over permissions, network access, secrets, or destructive actions. Forge displays this distinction in its provider prompt and supervisor policy.

## Bounded delegation

The optional multi-agent mode is a bounded sequential analysis workflow. It uses fixed specialist roles, clamps agent and turn budgets, forbids recursive spawning, and gives delegated specialists no tool authority. Specialist output is advisory and visible through typed protocol events; the supervisor remains the only process that can authorize a workspace or terminal action.

## MCP and ACP integrations

MCP servers are untrusted child processes and are disabled by default. `forge mcp validate` checks configuration size and shape without launching any child; a caller must pass `--enable` for a single command to initialize a server. Tool calls also require an interactive `YES` confirmation. Persistent enable/disable changes are also approval-gated. MCP communication is local stdio JSON-RPC with a minimal child environment, request timeouts, response-size limits, stderr draining, and normalized child errors. v0.7 does not implement remote MCP transports or a persistent enablement marketplace. ACP is a bounded local JSON-RPC adapter, not a complete editor plugin or transport; it requires correlated request IDs and bounded request counts.

Policy packs can only add deny rules and are rejected if they contain allowance-style keys, unknown risks, unknown tools, invalid protocol versions, or oversized content. `forge policy explain` reports the policy layers behind a decision. Session approvals are ephemeral, exact-argument scopes with an expiry and cannot authorize a different tool or argument set. Extension loading validates local JSON manifests against a typed metadata contract; v0.7 recipes are inert bounded context and verification metadata only. It does not execute arbitrary extension code, load third-party modules, or replace built-in tools. Changed-file context discovery uses a bounded local Git command and filters traversal and absolute paths.

## Data handling

Session records are written with restrictive local permissions and limited event history. Records track running, completed, failed, cancelled, and interrupted states, retain bounded plan snapshots, step journals, workspace fingerprints, structured verification evidence, and explicit resume counts. A worker exit without completion is not reported as success. Resume revalidates the fingerprint and refuses workspace drift rather than replaying mutations. Tool arguments and outputs should be redacted before logging when they may contain secrets. Context is bounded and relevant-file based; Forge does not send the entire repository automatically. The incremental local index stores bounded metadata and signatures only, not file contents. `--no-record` prevents local session persistence while retaining in-memory protocol correlation for the active run.

## Git contribution workflow

Git status inspection is read-only. Branch creation, staging, and commits remain explicit local operations guarded by approval. `forge git prepare-pr` only creates a local title/body/diff draft from the current workspace; it never commits, pushes, opens a pull request, or contacts a remote service.
