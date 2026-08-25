# Forge architecture

Forge uses a supervised hybrid runtime. The Node.js/TypeScript process is the authority for the workspace, terminal, permissions, tool execution, and session state. The Python process proposes context and tool actions through a versioned JSONL stream; it cannot directly change the workspace.

```text
User terminal
     |
     v
TypeScript CLI supervisor
  |  terminal UI, policy, tools, sessions
  |  JSONL over stdin/stdout
  v
Python agent worker
  |  mock provider in v0.1; provider adapters later
  v
Model provider
```

## Agent turn

A turn starts with bounded workspace context. The worker can propose reads and searches. Forge executes read-only tools automatically inside the workspace, then the worker emits a structured plan. Writes, process execution, network operations, and destructive operations are classified by risk and require the corresponding policy decision. Results return to the worker as structured success or error events. The loop is bounded and ends with a completion event, failure, or cancellation.

## Protocol

Every message is one JSON object per line with `protocol`, `id`, `sessionId`, `type`, and `timestamp`. Stderr is diagnostic output and is never part of the protocol. The contract is intentionally provider-neutral so OpenAI-style function calls, Anthropic-style tool use, MCP tools, or a future ACP adapter can map into the same internal proposal/result events.

## Runtime boundaries

The worker does not receive unrestricted filesystem or process capabilities. The supervisor canonicalizes paths, rejects traversal and sensitive file names, applies output and time limits, and records tool events. Project instruction files can describe coding conventions but cannot change the policy engine.
