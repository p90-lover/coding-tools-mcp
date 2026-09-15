# Multi-provider Codex Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route native Codex subagents through a shared Coding Tools endpoint to many Codex Router providers, including a first-class CommandCode Proxy profile.

**Architecture:** Keep Coding Tools as the only Codex model provider. Add a focused router client that discovers authenticated local Codex Router models, namespaces them into the existing native model catalog, and forwards `codex-router/*` Responses requests back to Codex Router after removing exactly one namespace prefix. CommandCode Proxy is registered with Codex Router as an `openai-chat` generic provider so Coding Tools never stores its `user_*` credential or implements a second tool-protocol translator.

**Tech Stack:** Bun/TypeScript, Codex Responses protocol, Codex Router authenticated loopback API, Bun tests.

**Spec:** `docs/superpowers/specs/2026-09-15-codex-router-multiprovider-subagents-design.md`

## Global Constraints

- Do not delete files; retain temporary/evidence output under `aiTemp/`.
- Do not mutate native OpenAI or `chatgpt-web/*` routing behavior.
- Never log or return the Codex Router caller key or CommandCode Proxy API key.
- Unknown external namespaces fail closed; no silent provider fallback in Coding Tools.
- CommandCode Proxy credentials remain owned by Codex Router.

---

### Task 1: Router contract and provider profile

**Files:**
- Create: `runtime-web/src/routed-providers.ts`
- Create: `runtime-web/tests/routed-providers.test.ts`

**Interfaces:**
- Produces: `resolveCodexRouterConnection(env)`, `codexRouterModelId(slug)`, `parseCodexRouterModelId(model)`, `commandCodeProxyProviderProfile(baseUrl)`, `redactRouterError(text, connection)`.

- [ ] **Step 1: Write failing tests** for caller-path construction, namespace round trips, caller-key redaction, and the `commandcode-proxy`/`openai-chat` profile.
- [ ] **Step 2: Run** `bun test --cwd runtime-web tests/routed-providers.test.ts` and require failures caused by the missing module/exports.
- [ ] **Step 3: Implement the minimal pure contract**. Accept only loopback `http:` router origins, require a caller key of at least 32 URL-safe characters, normalize the CommandCode Proxy base URL, and never include secrets in thrown messages.
- [ ] **Step 4: Re-run** the focused test and require `0 fail`.

### Task 2: Dynamic routed model catalog

**Files:**
- Modify: `runtime-web/src/routed-providers.ts`
- Modify: `runtime-web/src/server.ts`
- Modify: `runtime-web/tests/routed-providers.test.ts`

**Interfaces:**
- Produces: `augmentWithCodexRouterModels(catalog, config, connection, fetchImpl)` returning a cloned Codex catalog.

- [ ] **Step 1: Add failing tests** proving router model IDs become `codex-router/<slug>`, native/Web rows remain unchanged, duplicate imported rows are ignored deterministically, and a malformed/failed external catalog leaves the base catalog intact.
- [ ] **Step 2: Run the focused test** and require failures on the missing augmentation behavior.
- [ ] **Step 3: Implement catalog fetch/augmentation** using authenticated `GET <caller-base>/models`. Synthesize routed rows from a list-visible, tool-capable native template, clear service tiers/compaction hash, set `tool_mode: null`, preserve the configured v1/v2 subagent surface, and append rows without mutating the source catalog.
- [ ] **Step 4: Wire `modelsRequest()`** to augment the existing native + ChatGPT Web result only when router configuration is valid; router discovery failure must not break native model discovery.
- [ ] **Step 5: Run** `bun test --cwd runtime-web tests/routed-providers.test.ts tests/model-catalog.test.ts`.

### Task 3: Routed Responses forwarding

**Files:**
- Modify: `runtime-web/src/routed-providers.ts`
- Modify: `runtime-web/src/server.ts`
- Modify: `runtime-web/tests/routed-providers.test.ts`

**Interfaces:**
- Produces: `forwardCodexRouterResponse(req, rawBody, connection, fetchImpl)`.

- [ ] **Step 1: Add failing tests** proving `codex-router/deepseek/deepseek-v4-pro` is forwarded as `deepseek/deepseek-v4-pro`, the caller capability authenticates the local request, streaming headers/body are preserved, and connection/error text is sanitized.
- [ ] **Step 2: Run the focused test** and require failures on missing forwarding.
- [ ] **Step 3: Implement forwarding** by cloning the parsed raw body, replacing only `model`, POSTing to `<caller-base>/responses`, and returning the upstream body/status/headers without buffering SSE.
- [ ] **Step 4: Update `responseRequest()`** so `codex-router/*` routes before native passthrough. Native and ChatGPT Web branches remain byte-for-byte behaviorally unchanged.
- [ ] **Step 5: Run focused tests plus the existing server/subagent tests selected by repository scripts.**

### Task 4: CommandCode Proxy bootstrap contract

**Files:**
- Create: `runtime-web/scripts/commandcode-proxy-provider.ts`
- Create: `runtime-web/tests/commandcode-proxy-provider.test.ts`
- Modify: `runtime-web/package.json`

**Interfaces:**
- Produces: a dry-run-first helper that prints/executes the exact Codex Router generic-provider registration sequence for provider id `commandcode-proxy` with adapter `openai-chat`; raw credentials are read from environment/stdin and never emitted.

- [ ] **Step 1: Add failing tests** for the generated argv: `providers generic add commandcode-proxy --name "CommandCode Proxy" --base-url <url> --adapter openai-chat`, followed by enable/curation guidance; ensure credential values never occur in output.
- [ ] **Step 2: Run the focused test** and require the missing helper failure.
- [ ] **Step 3: Implement the helper** with `--dry-run` as the default and an explicit `--apply` mode. It must not delete/replace provider state and must reject non-loopback HTTP CommandCode Proxy URLs unless the user explicitly supplies an HTTPS URL.
- [ ] **Step 4: Add package script** `provider:commandcode-proxy` and re-run focused tests.

### Task 5: Native subagent lifecycle proof and release boundary

**Files:**
- Modify: `runtime-web/scripts/smoke-codex-subagents.ts`
- Create: `runtime-web/tests/routed-subagent-lifecycle.test.ts`
- Create: `docs/releases/v0.7.0-next.md`

**Interfaces:**
- Extends the existing local scripted lifecycle smoke so a parent selects one routed child slug while the root remains native/Web.

- [ ] **Step 1: Add a focused model-free lifecycle fixture** whose fake router records root/child/grandchild model IDs and returns the existing collaboration tool sequence.
- [ ] **Step 2: Verify the fixture fails before routed catalog/forwarding integration.**
- [ ] **Step 3: Run the lifecycle after Tasks 1-4 and require child requests to reach the fake router with de-namespaced model IDs while `spawn_agent`/`wait_agent`/follow-up complete.**
- [ ] **Step 4: Run `bun run --cwd runtime-web typecheck` and the smallest relevant existing test set; then use hosted CI for the full platform matrix.**
- [ ] **Step 5: Document the `v0.7.0-next` boundary in English and Traditional Chinese, including that CommandCode Proxy is transported through Codex Router generic-provider support and no credentials are bundled.**
