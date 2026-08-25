# Forge architecture

Forge uses a supervised hybrid runtime. The Node.js/TypeScript process is the authority for the workspace, terminal, permissions, tool execution, checkpoints, session state, and terminal UI. The Python process assembles context and proposes provider-driven actions through a versioned JSONL stream; it cannot directly change the workspace.

```text
User terminal
     |
     v
TypeScript CLI supervisor
  |  terminal UI, context, policy, tools, sessions, checkpoints
  |  JSONL over stdin/stdout
  v
Python agent worker
  |  provider adapter, bounded conversation, normalized tool calls
  v
Model provider
```

## Agent turn

A turn starts with a bounded repository context. The context engine detects the project type and package manager, respects standard generated directories and project ignore patterns, loads `FORGE.md` as untrusted guidance, ranks likely relevant files, and reports hashes and truncation. The worker can then ask the supervisor to inspect files, search text, inspect Git state, or perform other registered tools.

The model’s provider response is normalized into text and tool calls. A tool call becomes a structured Forge proposal with a risk class. Forge executes read-only tools automatically inside the approved workspace. Writes and local processes remain visible and approval-gated by default. Multi-file edits validate optional original hashes, create a checkpoint manifest, write the batch, and restore the checkpoint if a write fails partway through.

## Protocol

Every message is one JSON object per line with `protocol`, `id`, `sessionId`, `type`, and `timestamp`. Standard output is reserved for protocol messages; standard error is reserved for diagnostics. Every tool proposal has a named tool, risk classification, JSON arguments, and reason. Every tool result reports approval, success, duration, and either bounded output or a structured error.

The contract is provider-neutral. OpenAI-compatible chat-completion responses are normalized into the same internal events, and future MCP or ACP adapters can use the same boundary without coupling the supervisor to a vendor-specific message format.

## Runtime boundaries

The worker does not receive unrestricted filesystem or process capabilities. The supervisor canonicalizes paths, rejects traversal and sensitive file names, applies output and time limits, and records tool events. Project instruction files can describe coding conventions but cannot change the policy engine. Sessions store bounded event history with restrictive local permissions and redact common command secret patterns.

## Terminal surfaces

Interactive terminals can use the full-screen workspace renderer, which shows conversation, plan steps, tool activity, approvals, and completion state in an alternate screen. `--simple` selects the line-oriented renderer, and JSONL mode remains available for scripts and CI.
