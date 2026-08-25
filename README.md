# Forge CLI

Forge is a lightweight, local-first terminal AI coding agent built with **Node.js**, **TypeScript**, and **Python**.

The TypeScript/Node.js supervisor owns the command-line interface, terminal events, workspace policy, approvals, tool execution, and session persistence. The Python worker owns the agent loop, context assembly, and provider boundary. The runtimes communicate through a versioned JSONL protocol over standard input and output.

## Status

Forge v0.2 is an active development release. It includes a deterministic mock provider for offline tests and an opt-in OpenAI-compatible provider boundary with streaming and normalized tool calls. The supervisor adds ranked repository context, transactional multi-file edits, checkpoint recovery, undo support, and a full-screen terminal workspace with a plain-terminal fallback.

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
node dist/apps/forge-cli/src/main.js "inspect this repository"
```

See [docs/PROVIDERS.md](docs/PROVIDERS.md) for provider behavior and credential handling.

## Safety model

Forge starts in read-only exploration mode. File writes and command execution are gated, bounded, and visible. Repository instruction files are treated as untrusted guidance and cannot override the local policy. Forge does not persist provider credentials, does not expose common secret files by default, and does not include unrestricted auto-approval in v0.2.

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
