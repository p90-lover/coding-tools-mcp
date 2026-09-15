# Multi-provider Codex subagent routing design

## Goal

Make Coding Tools' native Codex V2 subagents usable with many model providers while preserving Codex's real `spawn_agent`, `wait_agent`, follow-up and interrupt semantics. CommandCode Proxy is a first-class provider, and existing Coding Tools ChatGPT-Web models remain available through the same routed tree.

## Verified Codex constraint

Official Codex 0.154.0 applies a bounded whitelist from user `agent_type` files: model, reasoning, personality/service-tier settings, capability reductions and skills. `model_provider` is intentionally not applied from a role file. A model-free CI probe proved the consequence: the child accepted the role's model but inherited the parent's provider.

Therefore a scalable multi-provider tree cannot switch Codex provider per child. The supported topology is one global Codex Router provider for the entire tree; each `agent_type` changes only its model slug, and Codex Router selects the real upstream provider behind that slug.

A pinned Codex 0.154.0 model-free smoke verified this topology:

```text
root:  gpt-5.6-sol
child: commandcode-proxy/claude-sonnet-4-6
provider for both: codex-router
```

No external model endpoint was contacted during that proof.

## Architecture

### Global native V2 provider

Codex runs with one provider:

```toml
[model_providers.codex-router]
name = "Codex Router (external models)"
base_url = "http://127.0.0.1:4202/v1"
env_key = "CODING_TOOLS_CODEX_ROUTER_CALLER_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
```

The caller capability is supplied through the environment and is never embedded in `config.toml` or an agent file.

Managed routed `agent_type` files contain only the selected routed model plus bounded instructions. A deterministic name includes a short hash of the complete slug so provider/model names cannot collide after filename normalization.

Compatibility V1 remains available for the existing bounded roster; the scalable next-generation path is native V2 agent types behind the single Codex Router provider.

### Coding Tools Web back-provider

To preserve the existing authenticated ChatGPT-Web adapter without causing a routing loop, Coding Tools exposes a dedicated restricted loopback ingress separate from its ordinary `/v1` surface:

- `GET /router/v1/models` — returns only eligible `chatgpt-web/*` models;
- `POST /router/v1/responses` — accepts only `chatgpt-web/*` and delegates directly to the existing Web adapter;
- native OpenAI models, `codex-router/*`, missing models and unknown namespaces fail closed.

Codex Router registers this ingress as a credentialless private generic provider:

```text
id: coding-tools-web
adapter: openai-responses
base URL: http://127.0.0.1:17841/router/v1
private endpoint: explicitly allowed
```

This yields the supported flow:

```text
Codex root/child
  -> single Codex Router provider
    -> DeepSeek / Anthropic / Kimi / Gemini / Grok / CommandCode Proxy / ...
    -> coding-tools-web
       -> Coding Tools restricted Web ingress
          -> authenticated ChatGPT Web adapter
```

Codex Router owns provider translation, selection, health and upstream credentials. Coding Tools does not duplicate that registry or credential store.

### Direct compatibility path

The existing Coding Tools endpoint may still import router models as `codex-router/<router-slug>` and forward those direct requests after removing exactly one prefix. This compatibility path is useful outside global-router mode but is not the mechanism used for scalable V2 subagents.

## Codex Router connection

Runtime configuration is opt-in and local-only:

- `CODING_TOOLS_CODEX_ROUTER_URL` — router origin, default `http://127.0.0.1:4202` when a caller key is present;
- `CODING_TOOLS_CODEX_ROUTER_CALLER_KEY` — URL-safe caller capability of at least 32 characters.

Internal compatibility forwarding may use Codex Router's authenticated caller path. Persistent Codex configuration uses the plain loopback `/v1` base plus the environment key, keeping the capability out of files and logs.

## Routed agent catalog

Coding Tools generates owner-private managed agent definitions from eligible routed model slugs. Each file contains a model lock and bounded developer instructions; it does not contain provider credentials or a `model_provider` override.

Coding Tools owns only files with its dedicated managed prefix. Stale or replaced managed definitions are moved to retention Trash, never deleted. User-authored agent definitions are untouched.

## CommandCode Proxy provider

`MAXeaglet/commandcode-proxy` is registered through Codex Router's generic-provider API:

- id: `commandcode-proxy`
- adapter: `openai-chat`
- default local base URL: `http://127.0.0.1:3050/v1`
- model discovery: provider `/models`
- authentication: CommandCode `user_*` key stored by Codex Router

Loopback registration uses `--allow-private`. The key is entered only through Codex Router's hidden credential prompt and is never accepted as a Coding Tools command-line argument. After enable + curation, its models participate in the same global routed tree as every other eligible provider.

## Failure behavior

No silent cross-provider substitution is performed by Coding Tools. An unavailable router, invalid catalog, unsupported Web-ingress model or upstream rejection fails closed with sanitized errors. The restricted Web ingress cannot route back into Codex Router and therefore cannot form a loop.

Caller capabilities and CommandCode credentials must never appear in generated files, errors, evidence or documentation output.

## Testing

Focused verification covers:

1. caller connection construction and secret redaction;
2. direct router catalog namespace/forwarding compatibility;
3. CommandCode Proxy generic-provider bootstrap without credential leakage;
4. deterministic routed agent definitions with Trash preservation;
5. negative proof that Codex role files cannot switch provider;
6. official Codex 0.154.0 model-free proof that one global router provider can run a native root model and a different routed child model;
7. restricted Coding Tools Web catalog filtering and Responses dispatch;
8. Coding Tools Web generic-provider bootstrap;
9. typecheck and the smallest relevant regression set.

## Safety and repository constraints

No files are deleted. Temporary/evidence paths remain under `aiTemp/`; recoverable obsolete managed artifacts move to `aiTemp/Trash` or the corresponding user retention Trash. Existing OAuth, browser, native Codex, release and active Electron migration behavior are preserved.