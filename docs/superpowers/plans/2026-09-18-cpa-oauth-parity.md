# CPA OAuth Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Codex, Claude, Gemini CLI, and Antigravity Provider Center accounts the same complete CPA-managed OAuth lifecycle while preserving ChatGPT Web and CommandCode behavior.

**Architecture:** Add CPA/CLIProxyAPI as a first-class encrypted loopback service, inject its internal-only connection into Provider Network, and replace the Antigravity-only implementation with one generic CPA OAuth adapter. The renderer receives account status, binding metadata, and model IDs only; CPA management credentials and OAuth tokens never cross the main-process boundary.

**Tech Stack:** Electron main process, CommonJS Node.js, React/TypeScript, Node test runner, GitHub Actions, CPA/CLIProxyAPI management HTTP API.

**Spec:** `docs/superpowers/specs/2026-09-18-cpa-oauth-parity-design.md`

## Global Constraints

- Preserve Architecture B: CPA, Codex Router, CommandCode Proxy, Paseo, and Anneal remain separately installed loopback services.
- Do not delete files, branches, releases, tags, or retained evidence.
- Put temporary and retained validation material under `aiTemp/` or `aiTemp/Trash/`.
- Preserve ChatGPT Web BrowserHost login and CommandCode OAuth/import behavior.
- Never expose CPA management keys, OAuth tokens, refresh tokens, or auth-file contents to the renderer.
- Gemini OAuth must fail closed when the local CPA build does not expose the `gemini-cli` auth plugin.

---

### Task 1: Add failing CPA OAuth parity contracts

**Files:**
- Create: `desktop-electron/tests/cpa-oauth-parity.test.cjs`
- Modify: none

**Interfaces:**
- Consumes: `createProviderNetworkController()`, `createExternalServicesController()`, provider catalogue source.
- Produces: executable contracts for generic CPA login, exact account binding, unsupported Gemini plugin handling, secret redaction, and service wiring.

- [ ] **Step 1: Write the failing controller contract**

Create fixtures that configure a central CPA connection and exercise `codex-oauth`, `claude-oauth`, `gemini-oauth`, and `cliproxyapi-antigravity`. Require the controller to call each mapped `*-auth-url`, poll `get-auth-status`, bind the newly-created matching auth file, and query models by exact filename.

- [ ] **Step 2: Write the failing missing-plugin contract**

Return HTTP 404 from `gemini-cli-auth-url` and assert the error clearly states that the installed CPA build/plugin does not expose Gemini OAuth. Assert account status is `error`, not `connected`.

- [ ] **Step 3: Write the failing external-service contract**

Require `SERVICE_IDS` to include `cliproxyapi`, require encrypted `managementKey` configuration, require snapshot redaction, and require `providerConnection("cliproxyapi")` to return the decrypted key only inside the main process.

- [ ] **Step 4: Run the focused contracts and verify RED**

Run:

```bash
node --test desktop-electron/tests/cpa-oauth-parity.test.cjs
```

Expected: failures for missing `cliproxyapi` service, missing `cpa_oauth` provider mode, missing `gemini-oauth`, and missing generic CPA controller flow.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron/tests/cpa-oauth-parity.test.cjs
git commit -m "test(rc9): define CPA OAuth parity contracts"
```

### Task 2: Add the encrypted CPA external-service authority

**Files:**
- Modify: `desktop-electron/electron/external-services.cjs`
- Modify: `desktop-electron/electron/main.cjs`
- Modify: `desktop-electron/electron/provider-bootstrap.cjs`
- Modify: `desktop-electron/src/types.ts`
- Modify: `desktop-electron/src/features/ExternalServicesSurface.tsx`
- Create: `desktop-electron/vendor/upstream/cliproxyapi.json`
- Test: `desktop-electron/tests/cpa-oauth-parity.test.cjs`
- Test: `desktop-electron/tests/external-services-control-plane.test.cjs`

**Interfaces:**
- Produces: `ExternalServiceId = "cliproxyapi"`, `setProviderCpaConnection(getter)`, and `externalServicesController.providerConnection("cliproxyapi") -> { baseUrl, managementKey }`.
- Consumes: Electron `safeStorage`, existing encrypted external-service state, provider network controller.

- [ ] **Step 1: Add `cliproxyapi` service defaults**

Use endpoint `http://127.0.0.1:8317/`, empty executable/home by default, enabled true, autoStart false.

- [ ] **Step 2: Encrypt the management key**

Accept `managementKey?: string` only for `cliproxyapi`. Store it in the existing encrypted service-secret envelope. Expose only `secretConfigured: true|false` in snapshots.

- [ ] **Step 3: Add authenticated health inspection**

Inspect `/v0/management/auth-files` with both `Authorization: Bearer <key>` and `X-Management-Key: <key>`. Keep endpoint loopback/HTTPS validation and redact the key from errors.

- [ ] **Step 4: Add the internal connection accessor**

Implement:

```js
function providerConnection(idValue) {
  const id = requiredServiceId(idValue);
  if (id !== "cliproxyapi") throw new Error("Service is not a provider authority");
  const managementKey = secretFor(id).managementKey;
  if (!managementKey) throw new Error("CPA management key is not configured");
  return {
    baseUrl: state.services[id].endpoint.replace(/\/$/, ""),
    managementKey,
  };
}
```

Do not expose this method through renderer IPC.

- [ ] **Step 5: Wire CPA connection into Provider Network**

Add `setProviderCpaConnection()` in `provider-bootstrap.cjs`; pass a getter into `createProviderNetworkController()`. In `main.cjs`, call it after constructing `externalServicesController`.

- [ ] **Step 6: Add GUI and type support**

Add `cliproxyapi` to service names/types. Add a password input labelled `CPA / CLIProxyAPI management key` and Traditional Chinese equivalent. Save it through `managementKey`; clear the field after save or service selection.

- [ ] **Step 7: Add the pinned manifest**

Create `desktop-electron/vendor/upstream/cliproxyapi.json` recording repository `router-for-me/CLIProxyAPI`, pinned commit `b773607e3e7756dc6020a291825e4eb08899595a`, management API role, and license.

- [ ] **Step 8: Run focused tests**

```bash
node --test \
  desktop-electron/tests/cpa-oauth-parity.test.cjs \
  desktop-electron/tests/external-services-control-plane.test.cjs
```

Expected: external-service portions pass; OAuth portions remain RED.

- [ ] **Step 9: Commit**

```bash
git add desktop-electron/electron desktop-electron/src desktop-electron/vendor/upstream desktop-electron/tests
git commit -m "feat(rc9): add encrypted CPA service authority"
```

### Task 3: Implement the generic CPA OAuth adapter

**Files:**
- Create: `desktop-electron/electron/cpa-oauth.cjs`
- Modify: `desktop-electron/electron/provider-network.cjs`
- Test: `desktop-electron/tests/cpa-oauth-parity.test.cjs`
- Test: `desktop-electron/tests/antigravity-provider-session.test.cjs`
- Test: `desktop-electron/tests/antigravity-session-binding.test.cjs`

**Interfaces:**
- Produces: `CPA_OAUTH_PROVIDERS`, `cpaProviderDefinition(providerId)`, auth-file selection/status helpers.
- Consumes: central `getCpaConnection()`, legacy encrypted Antigravity account credential fallback, provider store binding metadata.

- [ ] **Step 1: Define the mapping**

```js
const CPA_OAUTH_PROVIDERS = Object.freeze({
  "codex-oauth": { provider: "codex", authPath: "codex-auth-url", label: "Codex" },
  "claude-oauth": { provider: "anthropic", authPath: "anthropic-auth-url", label: "Claude" },
  "gemini-oauth": { provider: "gemini-cli", authPath: "gemini-cli-auth-url", label: "Gemini CLI", plugin: true },
  "cliproxyapi-antigravity": { provider: "antigravity", authPath: "antigravity-auth-url", label: "Antigravity" },
});
```

- [ ] **Step 2: Generalize encrypted binding metadata**

Allow `mergeAccountSecret()` to persist `cpaProvider`, `cpaAuthName`, and `cpaAuthIndex`. Read legacy `antigravityAuthName` and `antigravityAuthIndex` as a migration fallback.

- [ ] **Step 3: Resolve the CPA connection**

Prefer the central `getCpaConnection()` result. For existing Antigravity accounts only, fall back to their stored management key and endpoint. Normalize the base URL and never write the central key into an account record.

- [ ] **Step 4: Implement generic start/poll/bind**

Capture baseline matching auth files, call `/v0/management/<authPath>?is_webui=true`, open the validated URL, poll bounded status, and inspect the exact provider auth files.

- [ ] **Step 5: Implement exact account selection**

Selection precedence:

1. exact stored `auth_index`;
2. exact stored filename;
3. exact identity/email match;
4. newly-created filename/index since baseline;
5. one healthy unambiguous candidate;
6. fail closed when multiple ambiguous candidates remain.

- [ ] **Step 6: Implement health and model refresh**

Map disabled, expired, unavailable/error, and connected states. Query models by exact bound filename. Missing bound files become pending with a login-again message.

- [ ] **Step 7: Implement unsupported Gemini plugin handling**

Translate 404/unsupported responses from `gemini-cli-auth-url` into an actionable error naming the required CPA Gemini CLI auth plugin/version. Do not fall back to opening a generic Gemini webpage.

- [ ] **Step 8: Route login and probe operations**

`openProviderLogin()` and `probeProviderAccount()` use the generic adapter for every mapped CPA provider. Keep ChatGPT Web BrowserHost and CommandCode branches unchanged.

- [ ] **Step 9: Run focused tests**

```bash
node --test \
  desktop-electron/tests/cpa-oauth-parity.test.cjs \
  desktop-electron/tests/antigravity-provider-session.test.cjs \
  desktop-electron/tests/antigravity-session-binding.test.cjs \
  desktop-electron/tests/commandcode-provider-session.test.cjs
```

Expected: all pass, with zero token/key leakage.

- [ ] **Step 10: Commit**

```bash
git add desktop-electron/electron desktop-electron/tests
git commit -m "feat(rc9): generalize CPA OAuth account lifecycle"
```

### Task 4: Align provider catalogue and Provider Center UX

**Files:**
- Modify: `desktop-electron/src/providers/provider-types.ts`
- Modify: `desktop-electron/src/features/ProviderHubSaasSurface.tsx`
- Modify: `desktop-electron/src/types.ts`
- Test: `desktop-electron/tests/cpa-oauth-parity.test.cjs`
- Test: `desktop-electron/tests/provider-center-account-wiring.test.cjs`

**Interfaces:**
- Produces: `ProviderLoginMode = ... | "cpa_oauth"` and a new `gemini-oauth` provider.
- Consumes: generic main-process CPA adapter and external-service status snapshots.

- [ ] **Step 1: Add catalogue definitions**

Set Codex, Claude, Gemini OAuth, and Antigravity to `loginMode: "cpa_oauth"`. Add `gemini-oauth` without removing `gemini-api` or `gemini-reverse-proxy`.

- [ ] **Step 2: Stop treating CPA OAuth as a generic credential account**

For `cpa_oauth`, do not ask for provider API/OAuth tokens. Show the central CPA service requirement and retain optional legacy Antigravity migration input only when a central CPA key is unavailable.

- [ ] **Step 3: Add bilingual login controls**

Use `Login with CPA`, `Refresh CPA session`, `Test CPA session`, and Traditional Chinese equivalents. Explain that CPA stores the OAuth account and Coding Tools stores only the encrypted auth-file binding metadata.

- [ ] **Step 4: Add capability-aware Gemini guidance**

Before login, permit the attempt; on unsupported plugin errors, surface the precise main-process error. Do not mark the account connected optimistically.

- [ ] **Step 5: Run renderer and account contracts**

```bash
bun run --cwd desktop-electron typecheck
node --test \
  desktop-electron/tests/cpa-oauth-parity.test.cjs \
  desktop-electron/tests/provider-center-account-wiring.test.cjs
```

- [ ] **Step 6: Commit**

```bash
git add desktop-electron/src desktop-electron/tests
git commit -m "feat(rc9): expose CPA OAuth multi-account login in Provider Center"
```

### Task 5: Full integration and packaged-app verification

**Files:**
- Create: `.github/workflows/rc9-cpa-oauth-parity.yml`
- Modify: applicable package and integration contracts only when required by the new CPA manifest/service.
- Retain evidence: `aiTemp/rc9-cpa-oauth-parity/`

**Interfaces:**
- Consumes: all Task 1–4 production interfaces.
- Produces: exact-head CI evidence and a merge-ready PR to the rc.8 release line or next rc.9 release branch.

- [ ] **Step 1: Run the focused Linux gate**

Run CPA OAuth, Antigravity, CommandCode, external-service, provider routing, credential-boundary, and BrowserHost contracts; run runtime syntax, strict TypeScript, and an isolated renderer production build.

- [ ] **Step 2: Run the Windows package gate**

Build Rust headless service and Electron installer, verify package resources, run packaged-launcher smoke, and retain generated renderer output under `aiTemp/Trash/` before restoring tracked source.

- [ ] **Step 3: Enforce no-delete and secret scans**

Require zero deleted project paths and scan renderer/package/evidence for CPA management keys, OAuth tokens, refresh tokens, and known secret patterns.

- [ ] **Step 4: Open and verify the PR**

Target the active release line. Require all exact-head checks to be green before merge. Preserve every branch and evidence artifact.

- [ ] **Step 5: Merge and materialize rc.9**

After merge-result verification, create the rc.9 release identity/workflow, publish the Windows prerelease, verify tag SHA and installer digest, and keep the rc.8 tag immutable.
