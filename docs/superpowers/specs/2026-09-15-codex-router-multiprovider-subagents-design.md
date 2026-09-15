# Multi-provider Codex subagent routing design

## Goal

Make Coding Tools' native Codex subagent surface provider-agnostic. A root agent keeps Codex's real `spawn_agent`, `wait_agent`, follow-up and interrupt semantics while routed children can run through many Codex Router providers, including CommandCode Proxy, without collapsing the system into one hard-coded provider or a small model-override roster.

## Architecture

The next version uses two complementary routed surfaces.

### Direct routed model path

Coding Tools remains the root Codex route and exposes its existing local Responses endpoint. It augments the native model catalog with `codex-router/<router-slug>` rows and forwards those requests to Codex Router after removing exactly one namespace prefix. This path is useful for direct/root model selection and preserves the existing ChatGPT Web/native routing split:

- `chatgpt-web/*` -> existing browser bridge;
- native OpenAI rows -> existing native passthrough;
- `codex-router/*` -> authenticated local Codex Router Responses endpoint.

### Scalable routed subagent path

Native V2 subagents do not depend on the bounded model override roster. Coding Tools creates a managed `agent_type` definition for each eligible routed model. Each agent definition has a stable generated name and contains:

```toml
model_provider = "codex-router"
model = "<router-slug>"
```

The root remains on Coding Tools while the child switches provider through the agent definition. This matches Codex Router's own V2 architecture and scales across a large catalog of providers/models.

Compatibility V1 remains supported for the existing bounded surface, but Coding Tools does not displace native/ChatGPT Web entries just to expose hundreds of routed models through V1. The multi-provider next-generation path is native V2 `agent_type` delegation.

## Codex Router connection

The integration is opt-in and local-only. Runtime configuration is supplied by environment variables and never committed:

- `CODING_TOOLS_CODEX_ROUTER_URL` — router origin, default `http://127.0.0.1:4202` when a caller key is present.
- `CODING_TOOLS_CODEX_ROUTER_CALLER_KEY` — router caller capability; it must never appear in logs, errors, model IDs, generated agent files or documentation output.

Coding Tools' internal forwarding client may use Codex Router's authenticated path capability. Persistent native subagent provider configuration uses the safer bearer form: the provider base URL is plain loopback `/v1` and Codex obtains the caller key from `CODING_TOOLS_CODEX_ROUTER_CALLER_KEY` through its environment-key mechanism. The caller key therefore does not need to be embedded in `config.toml`.

The managed provider contract is equivalent to:

```toml
[model_providers.codex-router]
name = "Codex Router (external models)"
base_url = "http://127.0.0.1:4202/v1"
env_key = "CODING_TOOLS_CODEX_ROUTER_CALLER_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
```

The exact table is installed transactionally with Coding Tools' Codex integration and must not overwrite a user-owned provider of the same name unless it matches the managed contract.

## Model catalog and agent definitions

Router models are exposed for direct selection as `codex-router/<router-slug>`. The underlying router slug remains unchanged when forwarded. This permits DeepSeek, Kimi, Anthropic, Gemini, Grok, OpenRouter, local runtimes and future Codex Router providers without adding provider-specific routing code to Coding Tools.

For V2 subagents, Coding Tools generates deterministic managed agent definitions from the router's eligible routed catalog. A generated name is derived from the complete router slug so models from different providers cannot collide. Agent files are owner-private and contain no credentials.

Coding Tools owns only files carrying its dedicated routed-agent filename prefix. When a routed model is no longer eligible, the old managed definition is moved into repository/user retention Trash rather than deleted. User-authored agent definitions are never read, modified, replaced or moved by this synchronizer.

## CommandCode Proxy provider

`MAXeaglet/commandcode-proxy` is a first-class Codex Router generic-provider profile:

- id: `commandcode-proxy`
- adapter: `openai-chat`
- base URL: configurable; recommended local default `http://127.0.0.1:3050/v1`
- dynamic model discovery: `GET /v1/models`
- authentication: CommandCode `user_*` key, stored by Codex Router rather than Coding Tools

The bootstrap sequence uses Codex Router's supported generic-provider CLI. Loopback/private endpoints add `--allow-private`; the key is entered only through Codex Router's hidden credential prompt and is never accepted as a Coding Tools command-line argument. After enable + curation, eligible models automatically become direct routed rows and V2 routed agent types.

## Failure behavior

No silent cross-provider substitution is performed by Coding Tools. If Codex Router is absent, unauthenticated, returns an invalid catalog or rejects a request, routed models/agents are unavailable or the routed request fails with a sanitized upstream error. Native and ChatGPT Web paths remain usable.

Caller-key-bearing URLs are never emitted. Unknown routed namespaces are not guessed. A `codex-router/*` request cannot silently fall back to native OpenAI or ChatGPT Web. A routed `agent_type` cannot silently switch to a different provider/model.

## Testing

Focused verification covers:

1. caller connection construction and caller-key redaction;
2. router catalog rows becoming namespaced direct models;
3. collision/idempotency behavior;
4. outgoing model de-namespacing and streaming Responses forwarding;
5. CommandCode Proxy generic-provider bootstrap without credential leakage;
6. deterministic V2 routed-agent definitions and owner-only file behavior;
7. model-free native Codex lifecycle proof where the root stays on Coding Tools and a named child runs through a separate local `codex-router` provider;
8. retained/no-delete cleanup for lifecycle evidence.

The existing model-catalog and native subagent lifecycle tests remain regression gates. No live paid provider call is required for the model-free architecture proof.

## Safety and repository constraints

No files are deleted. Temporary/evidence files stay under `aiTemp/`; recoverable obsolete managed artifacts move to `aiTemp/Trash` or the corresponding user retention Trash. Existing OAuth, browser, native Codex, release and active Electron migration behavior are not replaced by this slice.