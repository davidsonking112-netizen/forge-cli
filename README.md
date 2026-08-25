# Forge CLI

Forge is a lightweight, local-first terminal AI coding agent built with **Node.js**, **TypeScript**, and **Python**.

The TypeScript/Node.js supervisor owns the command-line interface, terminal events, workspace policy, approvals, tool execution, and session persistence. The Python worker owns the agent loop, context assembly, and provider boundary. The runtimes communicate through a versioned JSONL protocol over standard input and output.

## Status

Forge v0.4 is an active development release. It adds bounded multi-agent analysis, an MCP stdio client, ACP-ready event normalization, local PR-draft preparation, session inspection, privacy mode, verification-command discovery, and stronger provider controls while retaining the local-first safety model.

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

Use `forge inspect <session-id>` to view local event metrics, `--no-record` for privacy-sensitive runs, and `forge git prepare-pr` to generate a local review draft without pushing remotely. `forge doctor --repair` prints setup guidance only; it never installs packages or edits the workspace.

MCP is opt-in per command. Configure servers in `~/.config/forge/integrations.json`, inspect them with `forge mcp list`, and use `forge mcp tools <id> --enable` for discovery. Calls use `forge mcp call <id> <tool> '{}' --enable` and require an interactive `YES` confirmation.

## Safety model

Forge starts in read-only exploration mode. File writes and command execution are gated, bounded, and visible. Repository instruction files are treated as untrusted guidance and cannot override the local policy. Forge does not persist provider credentials, does not expose common secret files by default, and does not include unrestricted auto-approval in v0.4. External servers remain disabled unless explicitly enabled, and remote pushes are never performed by Forge.

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
