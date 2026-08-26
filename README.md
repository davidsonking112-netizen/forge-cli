# Forge CLI

Forge is a lightweight, local-first terminal AI coding agent built with **Node.js**, **TypeScript**, and **Python**.

The TypeScript/Node.js supervisor owns the command-line interface, terminal events, workspace policy, approvals, tool execution, and session persistence. The Python worker owns the agent loop, context assembly, and provider boundary. The runtimes communicate through a versioned JSONL protocol over standard input and output.

## Status

Forge v0.9.5 adds explicit, approval-gated GitHub status/login/private-repository creation/clone/push workflows, a bounded persisted model scratchpad, and a model-output optimization prompt for evidence-aware, substantially higher-quality responses. It retains v0.9 protocol validation, reproducible verification evidence digests, deterministic change-set digests, atomic local-index persistence, read-only extension recipe inspection, stronger worker input bounds, and all local-first safety boundaries.

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

Use `forge inspect <session-id>` to view bounded event, timing, approval, delegation, step-journal, fingerprint, recovery, and verification metrics. Use `forge session recovery <session-id>` for a read-only `continue`, `re-plan`, or `manual-intervention` assessment with a reason code and next action. Resuming revalidates the workspace, persists the assessment, and never replays prior writes or commands; changed relevant files require manual inspection. Use `forge verify <session-id>` to inspect structured evidence, its evidence digest, recorded/current fingerprints, and rerun guidance; it never replays commands and marks passed evidence stale if the workspace fingerprint changed. Use `--no-record` for privacy-sensitive runs, and use `forge git prepare-pr` to generate a local review draft without pushing remotely. `forge doctor --repair` prints setup guidance only; it never installs packages or edits the workspace.

Review and apply a unified diff safely:

```bash
forge review change.patch
forge preview-diff change.patch --workspace /path/to/repository --only src/app.ts,tests/app.test.ts
forge apply-diff change.patch --workspace /path/to/repository --only src/app.ts
```

GitHub actions are explicit and approval-gated. Use `forge github status` to inspect local GitHub authentication state, `forge github connect` to launch the user-controlled GitHub web login, `forge github create owner/name` to create a private repository from the approved workspace, `forge github clone owner/name --destination clones/name` to clone inside the approved workspace, and `forge github push [branch]` to explicitly push the selected branch. Forge never asks the model for a token, never prints credentials, and never performs these remote actions implicitly.

MCP is opt-in per command. Configure servers in `~/.config/forge/integrations.json`, validate the JSON and server metadata without launching anything with `forge mcp validate`, and inspect them with `forge mcp list`. Use `forge mcp enable <id>` or `forge mcp disable <id>` only after interactive approval, and use `forge mcp tools <id> --enable` for discovery. Calls use `forge mcp call <id> <tool> '{}' --enable` and require an interactive `YES` confirmation.

Adapt local editor-style events through the ACP boundary with `printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"prompt","params":{"prompt":"inspect"}}' | forge acp serve`; responses preserve request correlation and categorize malformed input without launching anything. Validate a stricter policy pack with `forge policy validate policy.json`, inspect the immutable ceiling with `forge policy effective policy.json`, explain a decision with `forge policy explain local-execution process.run --profile research`, load a pack for a run with `--policy-pack policy.json`, and inspect local extension manifests with `forge extensions list [directory]` or `forge extensions inspect <id> [directory]`. Inspection reports recipes as inert metadata with bounded limits; recipes cannot execute modules or replace built-in tools. Use `forge context "find the relevant tests"` to inspect changed-file prioritization and the verification plan. Use `forge index build|show|query <term>|clear` for an explicit, local metadata-only repository index; relationship records are bounded dependency, test, and configuration edges and contain no file contents. Repeat builds reuse unchanged entries and report refreshed or removed metadata. Local MCP calls remain explicitly enabled, bounded, and cancellable through the client API; remote transports are not supported. Use `forge profiles` to inspect bounded autonomy profiles. Select one per run with `--profile research|reviewed-edit|local-test|maintenance`; the default remains approval-gated `local-test` behavior. The model maintains a compact scratchpad of task, inspection, current step, change, verification, and next action; inspect it with `forge inspect <session-id>`. The scratchpad is bounded planning metadata only and never authorizes a tool.

## Safety model

Forge starts in read-only exploration mode. File writes and command execution are gated, bounded, and visible. Unified-diff changes are path- and context-validated, checkpointed, and approval-gated. Repository instruction files, policy packs, extension manifests, MCP metadata, and provider responses are untrusted data and cannot lower the global safety ceiling. Forge does not persist provider credentials, does not expose common secret files by default, and never performs a GitHub push implicitly; explicit GitHub pushes require a user-confirmed command.

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
