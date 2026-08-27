# Forge CLI

Forge is a lightweight, local-first terminal AI coding agent built with **Node.js**, **TypeScript**, and **Python**.

The TypeScript/Node.js supervisor owns the command-line interface, terminal events, workspace policy, approvals, tool execution, and session persistence. The Python worker owns the agent loop, context assembly, and provider boundary. The runtimes communicate through a versioned JSONL protocol over standard input and output.

## Status

Forge is in **v1.0 release-candidate preparation**. The v1 work adds named provider presets, generic OpenAI-compatible configuration, adaptive token-parameter handling, bounded MCP/ACP connectivity, improved terminal status visibility, a formal Constitution, and a documented readiness review. The v0.99 baseline remains the published release until the final release gates and publication decision are completed; this wording does not claim that every provider, platform, or possible zero-day has been exhaustively tested.

Read the [Forge Constitution](docs/FORGE_CONSTITUTION.md), [v1.0 readiness report](docs/V1.0_READINESS_REPORT.md), [model-audit notes](docs/V1.0_MODEL_AUDIT_NOTES.md), [security patch register](docs/V1.0_SECURITY_AUDIT_NOTES.md), and [exit/error-code reference](docs/ERROR_CODES.md) for the governing principles, remaining recommendations, model-attributed findings, implemented patches, automation contract, and evidence limitations.

Use `forge status` for a compact read-only summary of the current workspace, provider configuration state, safe policy/profile, latest session, MCP configuration, and verification freshness. Use `forge status --output json` for scripts and CI; it never prints credential values or launches external actions.

For scripts and CI, run `forge errors` for the versioned machine-readable contract.
Exit code `0` means success, `1` means an attempted operation failed, `2` means usage or safety preconditions blocked execution, and `130` means the operator cancelled a run with Ctrl-C. Forge aborts active worker, subprocess, MCP, and Daytona boundaries where supported; it does not replay pending mutations. Do not parse human-readable messages as a stable API.

## Install with npm from GitHub

The public repository can be installed globally through npm without first cloning it. This installs the repository package, runs its safe build preparation step, and exposes the `forge` executable:

```powershell
npm install --global git+https://github.com/davidsonking112-netizen/forge-cli.git
$env:FORGE_PYTHON = "python"
forge init --workspace .
forge status --workspace .
```

The GitHub source package is currently a development/release-candidate package rather than a registry-published `1.0.0` package. It still requires Node.js 22+ and Python 3.11+. API credentials remain environment-only; npm does not receive or store provider secrets. When a final registry package is approved, the package name, version, lockfile, and cross-platform distribution checks should be finalized before publishing.

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

Run the read-only first-run onboarding checks. This inspects Node.js, Python, the approved workspace, provider configuration, and optional MCP, GitHub, and Daytona integrations. It does not install packages, store credentials, launch MCP servers, contact providers, or perform remote actions.

```bash
node dist/apps/forge-cli/src/main.js init --workspace .
node dist/apps/forge-cli/src/main.js init --workspace . --output json
```

Run diagnostics:

```bash
node dist/apps/forge-cli/src/main.js doctor
```

Run the deterministic plan flow:

```bash
node dist/apps/forge-cli/src/main.js plan "Explain this repository"
```

Start an interactive session. When Forge is attached to a TTY, it opens a full-screen terminal workspace by default:

```bash
node dist/apps/forge-cli/src/main.js
```

The full-screen UI shows the current session status, workspace/provider/policy, checklist progress, live activity, plan, scratchpad, tool results, specialist activity, verification evidence, and pending approvals. Use `1`–`5` to switch between Overview, Plan, Activity, Evidence, and Agents; `Tab` or left/right arrows to move between tabs; `j`/`k` or up/down arrows to scroll activity; and `q` or `Ctrl-C` to request cancellation. The Agents tab shows built-in and supervisor-created specialists, artifact validity, read-only mode, and bounded delegation budget telemetry. Approval prompts remain explicit and are handled through the normal readline approval flow; the TUI cannot approve an action by itself. The alternate screen and raw keyboard mode are restored when the session exits.

Use the line renderer when terminal interaction is unavailable or when plain output is preferred:

```bash
node dist/apps/forge-cli/src/main.js --simple
```

`--output json` remains machine-readable JSONL and never activates the full-screen renderer.

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

See [docs/PROVIDERS.md](docs/PROVIDERS.md) for provider behavior and credential handling. Run `forge providers` for an offline configuration overview. Forge also provides presets for OpenRouter (`OPENROUTER_API_KEY`), Groq (`GROQ_API_KEY`), Gemini/Google AI Studio (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, or `GOOGLE_AI_STUDIO_API_KEY`), and xAI (`XAI_API_KEY`); set `FORGE_PROVIDER` to `openrouter`, `groq`, `google-ai-studio`, or `xai`. Any additional OpenAI-compatible service can use the generic `FORGE_BASE_URL` and `FORGE_MODEL` path. `FORGE_TOKEN_PARAMETER=auto|max_tokens|max_completion_tokens` controls the compatibility field used for token budgets.

Enable bounded specialist analysis with an explicit quality-preserving budget. Forge retains five built-in typed roles—Explorer, Architect, Implementer, Tester, and Reviewer—and the supervisor can create up to three additional task-specific, read-only specialists from bounded role templates when the requested task signals security, dependencies, accessibility, UX/browser behavior, backend integration, data integrity, performance, release readiness, or complex cross-cutting work. The Explorer returns files, symbols, conventions, risks, unknowns, and evidence; the Architect returns an advisory milestone graph and acceptance mapping; the Implementer returns a proposed diff, affected files, preconditions, and rollback notes; the Tester returns a test matrix and explicitly unverified checks; the Reviewer returns blockers, contradictions, and a go/no-go decision; and a custom specialist returns a mission, findings, evidence, risks, recommended checks, and unknowns. Profiles never select a provider model or lower approval requirements. Dynamic specialists receive no tools and cannot authorize, edit, execute, or contact networks.

```bash
FORGE_PROVIDER=openai-compatible \
FORGE_API_KEY=your-key \
node dist/apps/forge-cli/src/main.js run --multi-agent --cost-profile balanced --prompt "review this repository"
```

Use `--cost-profile economy|balanced|quality`, `--max-agents <n>` (hard maximum 8), and `--max-total-turns <n>` to set bounded analysis limits. The balanced profile retains a five-agent default; the quality profile permits up to eight when the task warrants broader coverage. Add `--parallel-readonly` only when controlled concurrency is desired; it runs eligible read-only specialists concurrently, keeps implementation-oriented handoffs sequential, passes no tools to any specialist, and remains disabled by default. Forge reuses one bounded repository context and reports planned/used roles and turns, context/output character counts, skipped-role reasons, artifact kinds, and parallel mode in delegation events, `forge inspect`, and the full-screen TUI’s Agents tab. Every completed specialist result must be a bounded role-matching JSON artifact; empty, prose-only, malformed, or mismatched output fails closed rather than being presented as successful analysis.

Forge takes an atomic per-workspace lock for every active run. A second Forge process targeting the same approved workspace fails closed with `WORKSPACE_LOCKED` and exit code `2`; runs in different workspaces remain independent. A lock whose recorded process is no longer alive can be reclaimed safely. Use `forge inspect <session-id>` to view the visible checklist and expected outcomes, bounded event/timing/approval/delegation metrics, repair attempts, delegation budget telemetry, step journal, fingerprint, recovery, and verification evidence.
Use `forge audit <session-id>` for a redacted safety event log covering proposals, approval decisions, tool outcomes, retries, and completion checks. The checklist is a guide, not an authority: it does not approve writes, commands, GitHub actions, Daytona operations, or MCP calls. Use `forge session recovery <session-id>` for a read-only `continue`, `re-plan`, or `manual-intervention` assessment with a reason code and next action. Resuming revalidates the workspace, persists the assessment, and never replays prior writes or commands; changed relevant files require manual inspection. Use `forge verify <session-id>` to inspect structured evidence, its evidence digest, recorded/current fingerprints, and rerun guidance; it never replays commands and marks passed evidence stale if the workspace fingerprint changed. Use `--no-record` for privacy-sensitive runs, and use `forge git prepare-pr` to generate a local review draft without pushing remotely. `forge doctor --repair` prints setup guidance only; it never installs packages or edits the workspace.

Review and apply a unified diff safely:

```bash
forge review change.patch
forge preview-diff change.patch --workspace /path/to/repository --only src/app.ts,tests/app.test.ts
forge apply-diff change.patch --workspace /path/to/repository --only src/app.ts
```

GitHub actions are explicit and approval-gated. Use `forge github status` to inspect local GitHub authentication state, `forge github connect` to launch the user-controlled GitHub web login, `forge github create owner/name` to create a private repository from the approved workspace, `forge github clone owner/name --destination clones/name` to clone inside the approved workspace, and `forge github push [branch]` to explicitly push the selected branch. Forge never asks the model for a token, never prints credentials, and never performs these remote actions implicitly.

MCP is opt-in per command. Configure servers in `~/.config/forge/integrations.json`, validate the JSON and server metadata without launching anything with `forge mcp validate`, and inspect them with `forge mcp list`. Use `forge mcp enable <id>` or `forge mcp disable <id>` only after interactive approval, and use `forge mcp tools <id> --enable` for discovery. Calls use `forge mcp call <id> <tool> '{}' --enable` and require an interactive `YES` confirmation. MCP and ACP inputs, child output, request counts, timeouts, cancellation, and subprocess environments are bounded; remote MCP transports are intentionally not enabled by default.

Adapt local editor-style events through the ACP boundary with `printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"prompt","params":{"prompt":"inspect"}}' | forge acp serve`; responses preserve request correlation and categorize malformed input without launching anything. Validate a stricter policy pack with `forge policy validate policy.json`, inspect the immutable ceiling with `forge policy effective policy.json`, explain a decision with `forge policy explain local-execution process.run --profile research`, load a pack for a run with `--policy-pack policy.json`, and inspect local extension manifests with `forge extensions list [directory]` or `forge extensions inspect <id> [directory]`. Inspection reports recipes as inert metadata with bounded limits; recipes cannot execute modules or replace built-in tools. Use `forge context "find the relevant tests"` to inspect changed-file prioritization and the verification plan. Use `forge index build|show|query <term>|clear` for an explicit, local metadata-only repository index; relationship records are bounded dependency, test, and configuration edges and contain no file contents. Repeat builds reuse unchanged entries and report refreshed or removed metadata. Local MCP calls remain explicitly enabled, bounded, and cancellable through the client API; remote transports are not supported. Use `forge profiles` to inspect bounded autonomy profiles. Select one per run with `--profile research|reviewed-edit|local-test|maintenance`; the default remains approval-gated `local-test` behavior. The model maintains a compact scratchpad of task, inspection, current step, change, verification, and next action; inspect it with `forge inspect <session-id>`. Typed specialist artifacts are preserved in JSONL, session records, `forge inspect`, simple output, and the TUI; the display summarizes artifact validity and role while retaining bounded structured fields for automation. The scratchpad is bounded planning metadata only and never authorizes a tool. Before major work, Forge emits a checklist with stage status and a user-facing expectation for inspection, planning, approval, change, verification, and summary. Simple mode prints updates inline; the full-screen TUI keeps a bounded live checklist section. Context assembly ranks relevant files and enforces a total character budget; `forge context` reports scanned, included, truncated, and pruned counts. It also exposes a hierarchical context pack containing the project contract, architecture map, acceptance-to-file/test mappings, relevant symbol slices, structured failure context, and prior repair strategies. Provider prompts receive these bounded relevance layers instead of relying on maximum token volume. Provider sessions use a bounded rolling summary to continue across longer tasks without allowing unbounded history or turns. A failed provider tool step may receive up to three alternate repair attempts and a fourth deep-thinking attempt; failed exhaustion is reported rather than presented as success.

Every run is also governed by a supervisor-owned implementation state machine: `intake → inspect → plan → milestone → implement → targeted-verify → evidence → repair/full-verify → summarize`. Each phase exposes its entry conditions, required artifact, exit condition, failure transition, and bounded budget in `agent.state` events. For large tasks, the plan may include a dependency graph. Each proposed checkpoint declares expected files, dependencies, risks, tests, and postconditions; Forge assigns stable step IDs and exposes readiness in `agent.graph` events. A downstream step cannot run while a prerequisite contract is invalid, blocked, or incomplete, and known mutation paths outside the active step’s expected-file contract are rejected before approval. After each successful workspace mutation, the supervisor derives the changed-file set and schedules the smallest useful verification: a sibling focused unit test for a pure source change, a project typecheck for TypeScript, a Python focused test or syntax check, or a loopback static-server/headless-browser smoke check for browser UI changes. The scheduled check is emitted as a normal approval-visible `tool.proposal`, never hidden from the user, and its `tool.result` carries the stable milestone ID and verification kind. The provider receives the mutation result only once, enriched with the bounded verification evidence, so supervisor-owned checks cannot be mistaken for a second response to a pending provider call. Every failed check records the exact command, exit code when available, redacted bounded output, changed files, workspace fingerprint, failure category, recovery strategy, and prior attempts. Syntax errors, provider-history errors, stale patches, timeouts, browser regressions, and generic command failures route to different repair strategies. A mutation milestone cannot complete until its scheduled check passes; a separate broad check is still required before final completion. Context assembly prioritizes changed, staged, and untracked files, project metadata, prompt matches, symbols, test/configuration surfaces, package scripts, conventions, untrusted instruction excerpts, acceptance mappings, and prior failures within explicit budgets rather than treating larger text as better context. Workspace patches are transactional and are rejected before writes when they contain duplicate targets, more than eight file entries, or more than one million bytes. Provider intelligence remains provider-dependent; this machine prevents unsupported success claims and unbounded recovery. The latest state is available in the full-screen TUI, `forge inspect`, JSONL output, and the redacted audit log.

Configure a non-authoritative user preference for provider sessions with `forge prompt set "Use concise explanations and include test evidence."`, `forge prompt set --file ./prompt.txt`, `forge prompt show`, or `forge prompt clear`. The prompt is bounded, stored outside the repository with restrictive permissions, passed only to the isolated worker, and cannot alter Forge policy or approvals.

Daytona support is optional and credential-free by default. Set `DAYTONA_API_KEY` in the execution environment without committing it, then use `forge daytona status`, `forge daytona create`, or `forge daytona cleanup <sandbox-id> --action stop|delete`. Creation and cleanup require an interactive `YES`; `delete` is never automatic. For an existing sandbox associated with a run, use `--daytona-sandbox <id> --daytona-cleanup stop|delete`; the cleanup action remains explicit and is logged by the command output. Set `DAYTONA_API_URL` only when using a compatible Daytona API endpoint.

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
