# Unified CPA OAuth Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Provider Center OAuth accounts for Codex, Claude, Antigravity, and future CPA-supported providers use one real CPA management login/session/binding flow, while keeping native BrowserHost accounts and API-key providers explicit and fail-closed.

**Architecture:** Add a data-driven login-adapter descriptor to the provider catalog and a generic CPA OAuth session adapter in `provider-network.cjs`. Provider Center will render login controls from adapter capability, not from the broad `auth` enum. CPA-owned tokens remain in CLIProxyAPI auth files; Coding Tools stores only the selected auth-file identity, account metadata, model inventory, and encrypted CPA management connection secret. Native BrowserHost login remains a selectable account source for Codex/ChatGPT Web. Gemini receives an explicit CPA session-import/dynamic-plugin path rather than a fabricated unsupported core endpoint.

**Tech Stack:** Electron, React/TypeScript, Node.js CommonJS, CLIProxyAPI Management API, Node test runner, Bun, GitHub Actions.

**Spec:** `docs/superpowers/plans/2026-09-18-unified-cpa-oauth-accounts.md`

## Global Constraints

- Base exact source: `v0.7.0-rc.8` / `5aa516e35e8f9824d3309a4016f3f309f33d956c`.
- Preserve Architecture B: CPA/CLIProxyAPI, Codex Router, Paseo, and Anneal remain separately installed loopback services controlled by Coding Tools.
- Never expose CPA management keys or provider OAuth tokens to renderer snapshots, normal logs, release assets, or execution bindings.
- Never report an account connected merely because an external login URL was opened.
- Preserve native BrowserHost Codex and ChatGPT Web login as an explicit account source.
- Core CPA OAuth routes supported in this release: `codex-auth-url`, `anthropic-auth-url`, `antigravity-auth-url`.
- Gemini must fail closed to CPA auth-file import/dynamic plugin discovery when no CPA OAuth route is advertised; do not invent a core `gemini-auth-url` endpoint.
- No project file, branch, release, or evidence deletion. Transient output belongs under `aiTemp/`; replaced transient output belongs under `aiTemp/Trash/`.

---

### Task 1: Provider login-adapter contract

**Files:**
- Modify: `desktop-electron/src/providers/provider-types.ts`
- Test: `desktop-electron/tests/cpa-unified-oauth-catalog.test.cjs`

**Interfaces:**
- Produces: `ProviderLoginAdapterDefinition` and `ProviderDefinition.loginAdapters`.
- Adapter kinds: `native_browser`, `cpa_oauth`, `cpa_auth_file`, `commandcode_oauth`.

- [ ] **Step 1: Write the failing catalog test** proving Codex offers CPA and native BrowserHost sources; Claude offers CPA OAuth; Antigravity offers CPA OAuth; Gemini offers CPA auth-file import without advertising a nonexistent core OAuth route; login capability is adapter-based.
- [ ] **Step 2: Run** `node --test desktop-electron/tests/cpa-unified-oauth-catalog.test.cjs` and confirm failure because `loginAdapters` is absent.
- [ ] **Step 3: Add the minimal typed adapter descriptors** to the provider catalog.
- [ ] **Step 4: Rerun the focused test and confirm pass.**
- [ ] **Step 5: Commit** `feat(rc9): declare provider login adapters`.

### Task 2: Generic CPA OAuth session adapter

**Files:**
- Create: `desktop-electron/electron/cpa-oauth-adapter.cjs`
- Modify: `desktop-electron/electron/provider-network.cjs`
- Test: `desktop-electron/tests/cpa-oauth-adapter.test.cjs`

**Interfaces:**
- Consumes: loopback management endpoint, encrypted management key, provider route descriptor, existing auth-file inventory, `fetchImpl`, `openExternal`, bounded poll settings.
- Produces: `startCpaOAuthLogin(options)` returning the exact newly bound auth-file identity, metadata, models, and terminal state.

- [ ] **Step 1: Write failing tests** for route construction, state polling, exact new-auth-file binding, existing-file exclusion, provider-name normalization, timeout, cancellation, error redaction, and loopback enforcement.
- [ ] **Step 2: Run** `node --test desktop-electron/tests/cpa-oauth-adapter.test.cjs` and confirm the module is missing.
- [ ] **Step 3: Implement the minimal generic adapter** using `/v0/management/<route>`, `/get-auth-status`, `/auth-files`, `/auth-files/models`, and `/oauth-session` cancellation.
- [ ] **Step 4: Rerun tests and confirm pass.**
- [ ] **Step 5: Replace Antigravity's one-off session logic with the generic adapter** without changing stored secret boundaries.
- [ ] **Step 6: Rerun Antigravity and provider-network tests.**
- [ ] **Step 7: Commit** `feat(rc9): generalize CPA OAuth session handling`.

### Task 3: CPA-backed Codex and Claude accounts

**Files:**
- Modify: `desktop-electron/electron/provider-network.cjs`
- Modify: `desktop-electron/electron/ipc-schema.cjs`
- Modify: `desktop-electron/electron/preload.cjs`
- Modify: `desktop-electron/src/api/contracts.ts`
- Modify: `desktop-electron/src/types.ts`
- Test: `desktop-electron/tests/cpa-provider-login-routing.test.cjs`

**Interfaces:**
- Consumes: `openProviderLogin({ accountId, adapterId })`.
- Produces: connected Provider Hub account bound to one CPA auth-file, with source metadata and discovered models; native BrowserHost path remains separate.

- [ ] **Step 1: Write failing routing tests** for CPA Codex, CPA Claude, CPA Antigravity, native Codex, unsupported adapter, and missing CPA management connection.
- [ ] **Step 2: Run the tests and confirm the existing account-id-only API cannot select an adapter.**
- [ ] **Step 3: Add bounded typed `adapterId` input through IPC/preload/API.**
- [ ] **Step 4: Route CPA adapters through `startCpaOAuthLogin`; route native adapters through BrowserHost; never use generic `shell.openExternal` as proof of completion.**
- [ ] **Step 5: Persist `loginAdapterId`, `credentialSource`, `authFileId`, provider identity, and model inventory without persisting OAuth tokens.**
- [ ] **Step 6: Rerun routing, provider-store, secret-redaction, and BrowserHost tests.**
- [ ] **Step 7: Commit** `feat(rc9): connect Codex and Claude through CPA accounts`.

### Task 4: Gemini CPA import and expandable discovery

**Files:**
- Modify: `desktop-electron/electron/cpa-oauth-adapter.cjs`
- Modify: `desktop-electron/electron/provider-network.cjs`
- Modify: `desktop-electron/src/providers/provider-types.ts`
- Test: `desktop-electron/tests/cpa-gemini-account-import.test.cjs`

**Interfaces:**
- Produces: CPA auth-file inventory/import selection for Gemini credentials and dynamic plugin OAuth route discovery when advertised by CPA.

- [ ] **Step 1: Write failing tests** proving Gemini does not call a fabricated `/gemini-auth-url`, can bind an existing Gemini auth file, and can use a dynamically advertised plugin route only after capability discovery.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement CPA auth-file inventory filtering and explicit import binding.**
- [ ] **Step 4: Add optional capability discovery from CPA plugin/management metadata with a strict allowlisted route shape.**
- [ ] **Step 5: Rerun tests and confirm pass.**
- [ ] **Step 6: Commit** `feat(rc9): add fail-closed Gemini CPA account import`.

### Task 5: Provider Center login UX parity

**Files:**
- Modify: `desktop-electron/src/features/ProviderHubSaasSurface.tsx`
- Modify: `desktop-electron/src/features/provider-hub-saas.css`
- Test: `desktop-electron/tests/cpa-provider-login-ui.test.cjs`

**Interfaces:**
- Consumes: provider `loginAdapters`, account `loginAdapterId`, and typed `openProviderLogin(accountId, adapterId)`.
- Produces: source selector, accurate pending/completed status, account counts by source, CPA connection guidance, and import UI.

- [ ] **Step 1: Write failing UI contract tests** for source selector, Codex native/CPA options, Claude CPA login, Gemini import, no false login button, pending/cancel state, and Traditional Chinese copy.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement adapter-driven controls** and remove `supportsProviderLogin()` auth-enum inference.
- [ ] **Step 4: Add CPA account-count/source badges and terminal login feedback.**
- [ ] **Step 5: Build the isolated renderer and rerun UI contracts.**
- [ ] **Step 6: Commit** `feat(rc9): deliver CPA-parity OAuth account UX`.

### Task 6: End-to-end verification and release lane

**Files:**
- Create: `.github/workflows/v0.7-rc9-cpa-unified-oauth.yml`
- Create: `aiTemp/rc9-cpa-oauth/` retained test/evidence helpers
- Modify: release identity and notes only after the integration branch is green

**Interfaces:**
- Produces: exact-head proof for CPA adapter behavior, TypeScript, renderer, Windows package, packaged launcher, no-delete policy, and a candidate rc.9 release branch.

- [ ] **Step 1: Add CI that runs all new tests plus existing provider/Antigravity/CommandCode/BrowserHost/routing/security contracts.**
- [ ] **Step 2: Run syntax checks, strict TypeScript, isolated renderer build, and bundle contract.**
- [ ] **Step 3: Run Windows packaging and packaged-launcher smoke without paid-provider OAuth or quota use.**
- [ ] **Step 4: Enforce exact common-ancestor and working-tree no-delete gates.**
- [ ] **Step 5: Open a PR into the current release line, wait for all exact merge-result checks, and merge only when green.**
- [ ] **Step 6: Materialize and publish rc.9 only from the exact merged SHA, with checksums, provenance, validation evidence, and remote asset readback.**
