# Multi-provider Codex Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run native Codex V2 subagents through one global Codex Router provider so each agent type can select a different routed model/provider, including CommandCode Proxy and Coding Tools ChatGPT Web.

**Architecture:** Codex 0.154.0 does not apply `model_provider` from user role files, so provider switching happens inside Codex Router, not inside `agent_type`. The whole Codex tree uses `model_provider = "codex-router"`; managed agent definitions lock only a routed model slug. Coding Tools exposes a restricted `openai-responses` back-provider for its ChatGPT-Web models so those models can join the same router catalog without recursive routing.

**Tech Stack:** Bun/TypeScript, Codex Responses protocol, Codex Router authenticated loopback API, Codex V2 agent roles, Bun tests.

**Spec:** `docs/superpowers/specs/2026-09-15-codex-router-multiprovider-subagents-design.md`

## Global Constraints

- Do not delete files; retain temporary/evidence output under `aiTemp/` and preserve obsolete managed state in Trash.
- Never embed/log the Codex Router caller key or CommandCode `user_*` key.
- Global V2 subagents use one Codex Router provider; agent files change model only.
- The Coding Tools Web back-provider accepts only `chatgpt-web/*`; it must never route native or `codex-router/*` models.
- CommandCode Proxy credentials remain owned by Codex Router.

---

### Task 1: Router compatibility contract — COMPLETE

**Files:** `runtime-web/src/routed-providers.ts`, `runtime-web/tests/routed-providers.test.ts`, `runtime-web/src/server.ts`

- [x] Caller connection validation and redaction.
- [x] Direct `codex-router/*` model namespace and streaming forwarding.
- [x] Dynamic router catalog augmentation without breaking native/Web discovery.
- [x] Focused tests + typecheck.

### Task 2: CommandCode Proxy provider — COMPLETE

**Files:** `runtime-web/scripts/commandcode-proxy-provider.ts`, `runtime-web/tests/commandcode-proxy-provider.test.ts`

- [x] Generate Codex Router generic-provider `openai-chat` registration.
- [x] Add `--allow-private` for loopback endpoints.
- [x] Keep `user_*` credential entry in Codex Router's hidden prompt.
- [x] Test command sequence and secret non-disclosure.

### Task 3: Scalable routed agent definitions — COMPLETE

**Files:** `runtime-web/src/routed-agent-catalog.ts`, `runtime-web/tests/routed-agent-catalog.test.ts`

- [x] Deterministic hashed agent names/files.
- [x] Model-only role files compatible with Codex's role whitelist.
- [x] Owner-private permissions.
- [x] Preserve stale/replaced managed files to Trash; never touch user roles.

### Task 4: Official Codex architecture proof — COMPLETE

**Files:** `runtime-web/scripts/smoke-codex-router-agent-types.ts`, `runtime-web/scripts/smoke-codex-router-global-agents.ts`

- [x] Retain the failed per-agent-provider probe as evidence that provider inheritance exists.
- [x] Verify from Codex source that user roles do not apply `model_provider`.
- [x] Prove supported topology using pinned Codex 0.154.0: one global router provider, root `gpt-5.6-sol`, child `commandcode-proxy/claude-sonnet-4-6`.
- [x] Make zero paid/external model calls and preserve smoke state under `aiTemp/Trash`.

### Task 5: Restricted Coding Tools Web router ingress

**Files:**
- Create: `runtime-web/src/router-web-ingress.ts`
- Create: `runtime-web/tests/router-web-ingress.test.ts`
- Modify: `runtime-web/src/server.ts`

**Interfaces:**
- Produce a catalog filter that returns only `chatgpt-web/*` rows.
- Produce a request validator/dispatcher that accepts only `chatgpt-web/*` Responses requests and delegates directly to the existing Web adapter path.

- [ ] Write failing tests for Web-only catalog filtering, invalid/native/router model rejection, and streaming dispatch.
- [ ] Implement pure filtering/validation helpers.
- [ ] Add `GET /router/v1/models` and `POST /router/v1/responses` to the server before ordinary `/v1` routing.
- [ ] Prove the back-provider cannot recurse into `codex-router/*`.
- [ ] Run the focused ingress tests, existing routed-provider/model-catalog tests and typecheck.

### Task 6: Coding Tools Web generic-provider bootstrap

**Files:**
- Create: `runtime-web/scripts/codex-router-coding-tools-web-provider.ts`
- Create: `runtime-web/tests/codex-router-coding-tools-web-provider.test.ts`
- Modify: `runtime-web/package.json`

**Interfaces:**
- Dry-run-first command plan for provider `coding-tools-web`, adapter `openai-responses`, default base `http://127.0.0.1:17841/router/v1`, `--allow-private`, no credential prompt.

- [ ] Write failing command-plan tests.
- [ ] Implement the helper without any credential argument or destructive mutation.
- [ ] Add package scripts for CommandCode Proxy, Coding Tools Web and the global-router smoke.
- [ ] Re-run focused tests + typecheck.

### Task 7: Production integration helper

**Files:**
- Create: `runtime-web/scripts/codex-router-integration.ts`
- Create: `runtime-web/tests/codex-router-integration.test.ts`

**Interfaces:**
- Detect/use an installed Codex Router CLI.
- Register/enable `coding-tools-web` and optionally `commandcode-proxy` through supported router commands.
- Keep Codex Router responsible for global Codex provider config, caller-key lifecycle, provider state, credentials and doctor checks.

- [ ] Write tests for dry-run command ordering and secret-free output.
- [ ] Implement `--dry-run` default and explicit `--apply`.
- [ ] Reject ambiguous/non-loopback local routes and avoid rewriting router state directly.
- [ ] Verify idempotent re-run behavior relies on router CLI rather than deleting/recreating state.

### Task 8: Release boundary and final validation

**Files:**
- Create: `docs/releases/v0.7.0-next.md`
- Update: PR #62 description after final evidence.

- [ ] Document architecture, CommandCode Proxy, Coding Tools Web back-provider, V2 scalability, V1 bounded compatibility, credential boundaries and no-delete policy in English + Traditional Chinese.
- [ ] Run the smallest relevant focused suite and typecheck on the final head.
- [ ] Run the pinned official-Codex global-router smoke on the final head.
- [ ] Confirm branch comparison contains no deleted files.
- [ ] Keep PR draft; do not merge/tag/release without a separate user instruction.
