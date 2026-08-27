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
