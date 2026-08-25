# Forge security model

Forge is designed to keep the user in control of local code and system actions. The model proposes operations; the TypeScript supervisor validates and authorizes them. A model response, repository instruction file, MCP metadata, or tool description cannot weaken the local policy.

## Default policy

Read-only inspection is allowed inside the approved workspace. File mutation and local process execution require approval. Destructive operations, credential-like files, and network access are denied by default. v0.1 does not include an unrestricted auto-approval mode.

## Workspace containment

Forge resolves paths against the approved workspace root and rejects absolute paths, parent traversal, and paths that escape after normalization. Sensitive names such as `.env`, private keys, and common credential files are excluded from normal reads. Symlink behavior must be treated conservatively; future releases should add explicit symlink policy tests.

## Process execution

Commands run with an explicit working directory, bounded timeout, bounded combined output, and captured exit status. Shell interpretation is an explicit request rather than an implicit default. The process result is returned to the agent as data and is never treated as proof that a task succeeded unless the exit status and output support that conclusion.

## Data handling

Session records are written with restrictive local permissions and limited event history. Provider credentials must come from environment variables or a supported secret store and must not be written into project configuration, transcripts, or error reports. Tool arguments and outputs should be redacted before logging when they may contain secrets.

## Prompt injection

Repository content is untrusted input. `FORGE.md` can document conventions, but it is not an authority over permissions, network access, secrets, or destructive actions. Forge should display this distinction in its documentation and preserve it in the policy engine.

## Future integrations

MCP and ACP integrations will be added only behind the same approval and audit model. External tool metadata is not trusted merely because it is machine-readable. Any integration that expands data access or execution capability must add targeted consent and security tests before release.
