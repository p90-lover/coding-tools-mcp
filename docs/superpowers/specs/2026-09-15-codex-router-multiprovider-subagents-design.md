# Multi-provider Codex subagent routing design

## Goal

Make Coding Tools' existing native Codex subagent surface provider-agnostic. A root/child/grandchild keeps using Codex `spawn_agent`, `wait_agent`, follow-up and interrupt semantics while each spawned child may select a different routed model.

## Architecture

Coding Tools remains the single Codex `model_provider`. The runtime exposes one local Responses endpoint and augments the native Codex model catalog with namespaced routed rows. Requests for `chatgpt-web/*` keep the existing browser bridge; native OpenAI rows keep the existing native passthrough; `codex-router/*` and registered provider rows are forwarded to the authenticated loopback Codex Router Responses surface.

This avoids changing the provider for an already-running Codex process. Provider selection happens behind the Coding Tools endpoint by model slug, which is compatible with Codex subagent model overrides.

## Codex Router integration

The integration is opt-in and local-only. Runtime configuration is supplied by environment variables and never committed:

- `CODING_TOOLS_CODEX_ROUTER_URL` — router origin, default `http://127.0.0.1:4202` when a caller key is present.
- `CODING_TOOLS_CODEX_ROUTER_CALLER_KEY` — router caller capability. It is used only to construct the authenticated local path and must never appear in logs, errors, model IDs or generated documentation.

The runtime calls the router's authenticated `GET /v1/models` and `POST /v1/responses` surfaces. The external catalog is not trusted to overwrite native or ChatGPT Web rows. Every imported row is namespaced and collisions fail closed.

## Model namespace

Router models are exposed as `codex-router/<router-slug>`. The outgoing router request removes exactly one `codex-router/` prefix and sends the router slug unchanged. This permits models from DeepSeek, Kimi, Anthropic, Gemini, Grok, OpenRouter, local runtimes and other providers supported by Codex Router without adding provider-specific code to Coding Tools.

Routed model rows copy the official native Codex model template only for Codex protocol metadata. Provider identity, model slug and display name come from the router catalog. Service tiers are cleared. Routed rows advertise the current subagent protocol (`v1` compatibility or the native template's v2 surface) and remain selectable by `spawn_agent`.

## CommandCode Proxy provider

`MAXeaglet/commandcode-proxy` is treated as a first-class provider profile routed through Codex Router's generic-provider adapter. The profile is:

- id: `commandcode-proxy`
- adapter: `openai-chat`
- base URL: configurable, recommended local default `http://127.0.0.1:3050/v1`
- dynamic model discovery: `GET /v1/models`
- authentication: the proxy's `user_*` key, stored by Codex Router rather than Coding Tools

After the provider is registered/curated in Codex Router, its models automatically enter Coding Tools through the router catalog and can be selected by subagents without a separate protocol converter in Coding Tools. This deliberately keeps CommandCode's API key out of Coding Tools config and lets Codex Router own Responses-to-Chat translation, tool compatibility and routing health.

## Failure behavior

No silent provider substitution is performed by Coding Tools. If the router is absent, unauthenticated, returns an invalid catalog, or rejects a request, routed models are omitted from model discovery or the routed request returns a sanitized upstream error. Native and ChatGPT Web paths continue to work.

Caller-key-bearing URLs are never emitted. Unknown routed namespaces are not guessed. A `codex-router/*` request cannot fall back to native OpenAI or ChatGPT Web.

## Testing

Focused tests cover:

1. caller URL construction and caller-key redaction boundaries;
2. router catalog rows becoming namespaced Codex subagent models;
3. collision/idempotency behavior;
4. outgoing model de-namespacing and authenticated local forwarding;
5. a CommandCode Proxy provider profile using the Codex Router `openai-chat` generic-provider contract.

The existing model-catalog and subagent lifecycle tests remain regression gates.

## Safety and repository constraints

No files are deleted. Temporary/evidence files stay under `aiTemp/`. Existing OAuth, browser, native Codex, release and active Electron migration behavior are not replaced by this slice.