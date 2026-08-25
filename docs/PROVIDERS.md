# Providers in Forge v0.2

Forge v0.2 defaults to the offline mock provider. This makes tests and demonstrations deterministic and does not require credentials. To use an OpenAI-compatible endpoint, set `FORGE_PROVIDER=openai-compatible`, provide `FORGE_API_KEY` or `OPENAI_API_KEY`, and optionally set `FORGE_BASE_URL` and `FORGE_MODEL`.

```bash
export FORGE_PROVIDER=openai-compatible
export FORGE_API_KEY=your-key
export FORGE_BASE_URL=https://api.example.com/v1
export FORGE_MODEL=your-model
forge
```

The Python provider adapter sends a bounded conversation and the Forge tool schemas to the endpoint. Streaming text is normalized into `agent.text` events. Function calls are normalized into Forge `tool.proposal` events; the Node supervisor validates their risk and arguments, applies policy, executes approved operations, and returns `tool.result` events.

Forge does not treat a provider response as authorization. A model can propose a write, command, network operation, or other tool, but the supervisor policy and user approval remain authoritative. Provider credentials are read from the environment and are not written to sessions or project files.

The current adapter targets the common OpenAI-compatible chat-completions shape. Provider-specific adapters for Anthropic and xAI can be added behind the same normalized `ProviderReply` interface without changing the supervisor or terminal UX.
