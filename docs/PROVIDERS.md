# Providers in Forge v1.0

Forge defaults to the offline mock provider. This keeps tests and demonstrations deterministic and requires no credentials. For provider-backed sessions, Forge uses a normalized OpenAI-compatible chat-completions adapter. The TypeScript supervisor supplies only the explicitly allow-listed provider environment variables to the isolated Python worker; credentials never enter prompts, protocol events, session records, or command arguments.

## Supported provider paths

Forge includes named presets for common OpenAI-compatible endpoints. A preset selects a documented endpoint and credential variable, while `FORGE_MODEL` can override the preset model. Model availability changes over time, so users should confirm the selected model with the provider before running a task.

| `FORGE_PROVIDER`                          | Credential variable                                               | Default base URL                                          | Default model             | Notes                                                           |
| ----------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- | ------------------------- | --------------------------------------------------------------- |
| `openai` or `openai-compatible`           | `FORGE_API_KEY` or `OPENAI_API_KEY`                               | `https://api.openai.com/v1`                               | `gpt-4.1-mini`            | Generic OpenAI-compatible path                                  |
| `openrouter`                              | `OPENROUTER_API_KEY`                                              | `https://openrouter.ai/api/v1`                            | `openai/gpt-4o-mini`      | Use a model ID available through OpenRouter                     |
| `groq`                                    | `GROQ_API_KEY`                                                    | `https://api.groq.com/openai/v1`                          | `llama-3.3-70b-versatile` | Use a currently supported Groq model                            |
| `gemini`, `google`, or `google-ai-studio` | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or `GOOGLE_AI_STUDIO_API_KEY` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash`        | Google AI Studio keys use the Gemini OpenAI-compatible endpoint |
| `xai`                                     | `XAI_API_KEY`                                                     | `https://api.x.ai/v1`                                     | `grok-3-mini`             | Use a currently supported xAI model                             |

The generic path is intentionally extensible. Any service that implements the OpenAI-compatible `/chat/completions` contract can be used by setting `FORGE_PROVIDER=openai-compatible`, `FORGE_API_KEY`, `FORGE_BASE_URL`, and `FORGE_MODEL`. This gives users a route for additional providers without requiring Forge to embed provider-specific logic or trust remote instructions.

## Examples

```bash
# OpenRouter
export FORGE_PROVIDER=openrouter
export OPENROUTER_API_KEY='your-key'
export FORGE_MODEL='openai/gpt-4o-mini'
forge run --prompt 'Review the repository and propose safe improvements'
```

```bash
# Groq
export FORGE_PROVIDER=groq
export GROQ_API_KEY='your-key'
export FORGE_MODEL='llama-3.3-70b-versatile'
forge
```

```bash
# Google AI Studio / Gemini
export FORGE_PROVIDER=google-ai-studio
export GOOGLE_AI_STUDIO_API_KEY='your-key'
export FORGE_MODEL='gemini-2.0-flash'
forge
```

```bash
# Any compatible endpoint, including a self-hosted gateway
export FORGE_PROVIDER=openai-compatible
export FORGE_API_KEY='your-key'
export FORGE_BASE_URL='https://api.example.com/v1'
export FORGE_MODEL='your-model'
forge
```

Do not commit these values to a repository. Prefer the shell’s secret store, a process manager’s environment configuration, or another secret-management facility. `FORGE_HTTP_REFERER` and `FORGE_APP_NAME` are optional non-secret headers for providers such as OpenRouter and are bounded before transmission.

## Bounded runtime controls

`FORGE_MAX_TOKENS` is clamped to a safe upper bound, and `FORGE_PROVIDER_RETRIES` is clamped to five retries. `FORGE_TOKEN_PARAMETER=auto` selects `max_completion_tokens` for GPT-5 model names and `max_tokens` for other providers; set it explicitly to `max_tokens` or `max_completion_tokens` for a compatible gateway that requires a particular field. Provider requests have bounded context through Forge’s relevance selection and long-horizon compaction.

Streaming is enabled when the CLI receives a text callback. Set `FORGE_STREAM=0` (or `false`, `no`, or `off`) for OpenAI-compatible gateways that do not implement streaming; Forge still parses the normal chat-completion response and preserves tool calls. Forge also encodes internal dotted tool names to the provider’s portable `[A-Za-z0-9_-]` function-name contract and restores the original names before supervisor validation.
Provider tool calls remain proposals: the supervisor validates tool names, arguments, paths, risks, approval scope, and the immutable global deny ceiling before any local action.

Streaming output is normalized into `agent.text` events. Function calls are normalized into Forge `tool.proposal` events; the Node supervisor validates their risk and arguments, applies policy, executes approved operations, and returns `tool.result` events. Empty or malformed provider output fails closed. Provider errors are bounded and redacted before they reach protocol events or audit projections.

The named presets are configuration conveniences, not guarantees that a particular model, capability, price, or availability remains unchanged. Forge does not silently downgrade a requested provider or model. If a provider rejects the selected endpoint or model, the run reports the failure and the user can choose a different documented configuration.

## References

1. [Google Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
2. [OpenRouter Quickstart](https://openrouter.ai/docs/quickstart)
3. [Groq OpenAI compatibility](https://console.groq.com/docs/openai)
4. [xAI Inference REST API](https://docs.x.ai/developers/rest-api-reference/inference)

## Long-horizon implementation loop

Provider-backed coding sessions now advance through a bounded continuation loop rather than relying only on the model to decide when to stop. Forge emits checklist and scratchpad checkpoints around provider turns and supervisor results, so the CLI can show whether the session is inspecting, planning, changing, or verifying.

Forge computes a stable signature for each proposed tool name and argument object. Successful read-only results for `workspace.list`, `workspace.search`, `workspace.read`, `workspace.diff`, and `git.status` are cached for the session. If a provider asks for the exact same read again, Forge replays the approved result into the provider history without asking the supervisor to execute the read again. Exact repeats of non-cacheable successful actions, including process execution and writes, fail closed instead of silently looping. A failed action is removed from the repetition guard only for the existing bounded repair policy, allowing up to four explicitly recorded alternate/deep-thinking attempts.

When a task clearly requests a mutation but the provider returns text without a tool call, Forge makes at most two additional continuation requests. Each request explicitly asks for one bounded implementation action and warns against repeating completed reads. If the provider still does not propose a tool, the session ends as failed rather than claiming that the implementation happened. The existing maximum horizon-turn bound remains authoritative.

Long-horizon compaction also treats an assistant message containing multiple tool calls and all matching tool results as one atomic history group. Compaction may summarize or remove the complete group, but it does not leave an assistant tool call without its results or a stray tool result without its matching assistant call. These controls improve reliability without changing the supervisor’s authority: the worker still proposes, and only the TypeScript supervisor validates, approves, and executes local operations.

The following optional controls tune the bounded behavior. Values are clamped by the worker and should be increased only when the task genuinely requires more model turns.

| Variable                         |  Default | Purpose                                                                      |
| -------------------------------- | -------: | ---------------------------------------------------------------------------- |
| `FORGE_MAX_HORIZON_TURNS`        |     `24` | Maximum provider turns in one session.                                       |
| `FORGE_MAX_TEXT_ONLY_RECOVERIES` |      `2` | Maximum continuation requests after text-only output during a mutation task. |
| `FORGE_MAX_HORIZON_CHARS`        | `60,000` | Maximum retained conversation context before compaction.                     |
| `FORGE_MAX_HORIZON_MESSAGES`     |     `96` | Maximum retained conversation messages before compaction.                    |

These mechanisms are reliability boundaries, not a guarantee of autonomous success. A provider can still misunderstand a task, produce an invalid patch, hit a quota limit, or stop after a legitimate explanation. Forge reports those conditions and does not convert them into a false success.
