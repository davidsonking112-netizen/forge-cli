# Forge CLI

Forge is a lightweight, local-first terminal AI coding agent built with **Node.js**, **TypeScript**, and **Python**.

The TypeScript/Node.js supervisor owns the command-line interface, terminal events, workspace policy, approvals, tool execution, and session persistence. The Python worker owns the agent loop, context assembly, and provider boundary. The runtimes communicate through a versioned JSONL protocol over standard input and output.

## Status

Forge v0.5.0 is an active development release. It adds production-oriented unified-diff review and application, a local ACP JSON-RPC adapter, MCP trust-management commands, changed-file context prioritization, deny-only policy packs, extension-manifest validation, richer inspection reports, and structured local Git contribution drafts while retaining the local-first safety model.

## Development requirements

- Node.js 22 or newer
- Python 3.11 or newer
- npm

## Development setup

```bash
npm install
npm run build
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e ./python
```

Run diagnostics:

```bash
node dist/apps/forge-cli/src/main.js doctor
```

Run the deterministic plan flow:

```bash
node dist/apps/forge-cli/src/main.js plan "Explain this repository"
```

Start an interactive session:

```bash
node dist/apps/forge-cli/src/main.js
```

Use the offline mock provider by default, or configure an OpenAI-compatible provider:

```bash
FORGE_PROVIDER=openai-compatible \
FORGE_API_KEY=your-key \
FORGE_BASE_URL=https://api.example.com/v1 \
FORGE_MODEL=your-model \
FORGE_MAX_TOKENS=8192 \
FORGE_REASONING_EFFORT=medium \
node dist/apps/forge-cli/src/main.js "inspect this repository"
```

See [docs/PROVIDERS.md](docs/PROVIDERS.md) for provider behavior and credential handling.

Enable bounded specialist analysis with explicit budgets:

```bash
FORGE_PROVIDER=openai-compatible \
FORGE_API_KEY=your-key \
node dist/apps/forge-cli/src/main.js run --multi-agent --max-agents 4 --max-total-turns 8 --prompt "review this repository"
```

Use `forge inspect <session-id>` to view bounded event, timing, approval, delegation, and verification metrics. Use `--no-record` for privacy-sensitive runs, and use `forge git prepare-pr` to generate a local review draft without pushing remotely. `forge doctor --repair` prints setup guidance only; it never installs packages or edits the workspace.

Review and apply a unified diff safely:

```bash
forge review change.patch
forge apply-diff change.patch --workspace /path/to/repository
```

MCP is opt-in per command. Configure servers in `~/.config/forge/integrations.json`, inspect them with `forge mcp list`, use `forge mcp enable <id>` or `forge mcp disable <id>` only after interactive approval, and use `forge mcp tools <id> --enable` for discovery. Calls use `forge mcp call <id> <tool> '{}' --enable` and require an interactive `YES` confirmation.

Adapt local editor-style events through the ACP boundary with `printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"prompt","params":{"prompt":"inspect"}}' | forge acp serve`. Validate a stricter policy pack with `forge policy validate policy.json`, load it for a run with `--policy-pack policy.json`, and inspect local extension manifests with `forge extensions list [directory]`.

## Safety model

Forge starts in read-only exploration mode. File writes and command execution are gated, bounded, and visible. Unified-diff changes are path- and context-validated, checkpointed, and approval-gated. Repository instruction files, policy packs, extension manifests, MCP metadata, and provider responses are untrusted data and cannot lower the global safety ceiling. Forge does not persist provider credentials, does not expose common secret files by default, and remote pushes are never performed by Forge.

## Repository layout

| Path                 | Responsibility                                                             |
| -------------------- | -------------------------------------------------------------------------- |
| `apps/forge-cli`     | TypeScript CLI supervisor, tools, policy, sessions, and terminal rendering |
| `python/forge_agent` | Python worker, mock agent loop, context helpers, and provider boundary     |
| `packages/protocol`  | Versioned JSONL event contract and protocol fixtures                       |
| `tests`              | Cross-runtime and fixture-based tests                                      |
| `docs`               | Architecture and security documentation                                    |

## License

MIT. See [LICENSE](LICENSE).
