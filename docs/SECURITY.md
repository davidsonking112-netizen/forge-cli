# Forge security model

Forge is designed to keep the user in control of local code and system actions. The model proposes operations; the TypeScript supervisor validates and authorizes them. A model response, repository instruction file, provider response, MCP metadata, or tool description cannot weaken the local policy.

## Default policy

Read-only inspection is allowed inside the approved workspace. File mutation and local process execution require approval. Destructive operations, credential-like files, and network access are denied by default. v0.2 does not include an unrestricted auto-approval mode.

## Workspace containment

Forge resolves paths against the approved workspace root and rejects absolute paths, parent traversal, and paths that escape after normalization. It also rejects symbolic-link path components to avoid accidental access outside the workspace. Sensitive names such as `.env`, private keys, and common credential files are excluded from normal reads. Repository collection skips standard generated directories and project `.gitignore` patterns.

## Editing and checkpoints

Multi-file edits validate all paths and optional original content hashes before writing. Forge creates a restrictive checkpoint manifest and backups before the batch is applied. If any write fails, the supervisor attempts to restore the checkpoint. Users can restore a recorded checkpoint through the `forge undo` command after confirming the target workspace.

## Process execution

Commands run with an explicit working directory, bounded timeout, bounded combined output, and captured exit status. Shell interpretation is an explicit request rather than an implicit default. Project commands receive a minimal environment allowlist rather than the full parent environment, so provider credentials and unrelated secret variables are not inherited. The process result is returned to the agent as data and is never treated as proof that a task succeeded unless the exit status and output support that conclusion.

## Provider and prompt-injection boundaries

Provider credentials are read from environment variables or supported secret stores and are not written to project files or session records. Provider errors are redacted before they are emitted. Repository content is untrusted input. `FORGE.md` can document conventions, but it is not an authority over permissions, network access, secrets, or destructive actions. Forge displays this distinction in its provider prompt and supervisor policy.

## Data handling

Session records are written with restrictive local permissions and limited event history. Tool arguments and outputs should be redacted before logging when they may contain secrets. Context is bounded and relevant-file based; Forge does not send the entire repository automatically.

## Future integrations

MCP and ACP integrations will be added only behind the same approval and audit model. External tool metadata is not trusted merely because it is machine-readable. Any integration that expands data access or execution capability must add targeted consent and security tests before release.
