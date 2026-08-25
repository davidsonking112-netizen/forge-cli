# Changelog

## 0.2.0 — In development

Forge v0.2 upgrades the v0.1 foundation into a more capable coding-agent runtime. It adds an opt-in OpenAI-compatible provider boundary with streaming and normalized tool calls, a context engine with project ignore handling and ranked relevant files, transactional multi-file edits with stale-hash detection, checkpoint manifests and undo restoration, a bounded verification proposal flow, session continuation from recorded prompts, and a full-screen terminal workspace with a plain-terminal fallback.

The default provider remains the deterministic mock provider so local tests and demonstrations stay offline and reproducible. All mutations and local execution remain visible and approval-gated by default. Destructive, network, and credential-sensitive risk classes remain denied unless an explicit future policy supports them.

The release deliberately does not include cloud sandboxes, background agents, automatic commits or pull requests, broad MCP marketplace support, ACP editor integration, or a guaranteed single-file installer.
