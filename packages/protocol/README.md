# Forge protocol v1

Forge protocol v1 is a line-oriented JSON event stream. One complete JSON object is written per line. The Node.js supervisor and Python worker use the same envelope fields: `protocol`, `id`, `sessionId`, `type`, and `timestamp`.

Standard output is reserved for protocol messages. Standard error is reserved for diagnostics and must never be parsed as an event. Every tool proposal has a named tool, risk classification, JSON arguments, and reason. Every tool result reports approval, success, duration, and either bounded output or a structured error.

The canonical event schema is [`schema.json`](./schema.json). The TypeScript implementation is in [`src/index.ts`](./src/index.ts). Future adapters for MCP and ACP should map their wire-level events to this internal contract instead of coupling the supervisor to a vendor-specific message format.
