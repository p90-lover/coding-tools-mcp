# External Services Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Coding Tools the unified GUI and lifecycle control plane for separately installed Codex Router, CommandCode Proxy, Paseo, and Anneal while retaining CPA/Provider Hub as the authoritative encrypted account and routing store.

**Architecture:** Add a persistent main-process external-service controller and a localized Integrations surface. Bridge the controller to existing Provider Hub, BrowserHost, upstream-tool, and packaged runtime APIs; preserve strict loopback, secret, process-ownership, and exact-source release boundaries.

**Tech Stack:** Electron 41, CommonJS main/preload runtime, React 19 + TypeScript renderer, Node test runner, Bun/Vite, GitHub Actions Windows packaging.

**Spec:** `docs/superpowers/specs/2026-09-18-external-services-control-plane-design.md`

## Global Constraints

- Architecture B: services stay separately installed; Coding Tools manages them from the GUI.
- Endpoints are loopback-only: `127.0.0.1`, `localhost`, or `[::1]`.
- No shell command strings; executable and argument arrays only.
- Provider and OAuth secrets never enter renderer snapshots, logs, or release assets.
- CPA/Provider Hub remains authoritative for provider accounts, models, fallback, and proxy routing.
- No project file, branch, retained evidence, or user configuration is deleted.
- Temporary and generated material remains under `aiTemp/` or `aiTemp/Trash/`.
- Electron Builder packaging uses `--publish never`; the exact-source publisher remains authoritative.

---

### Task 1: Add external-service contracts and RED tests

**Files:**
- Create: `desktop-electron/tests/external-services-control-plane.test.cjs`
- Modify: `desktop-electron/tests/rc7-full-integration-contract.test.cjs`

**Interfaces:**
- Produces required contracts for `createExternalServicesController`, BrowserHost injection, renderer API, localized Integrations UI, Codex Router sync, and `--publish never`.

- [ ] **Step 1: Write controller contract tests**

Require `../electron/external-services.cjs` and assert exports:

```js
const {
  SERVICE_IDS,
  createExternalServicesController,
  normalizeLoopbackServiceEndpoint,
} = require("../electron/external-services.cjs");
assert.deepEqual(SERVICE_IDS, ["codex-router", "commandcode-proxy", "paseo", "anneal"]);
assert.equal(normalizeLoopbackServiceEndpoint("http://localhost:4202"), "http://localhost:4202/");
assert.throws(() => normalizeLoopbackServiceEndpoint("https://example.com"), /loopback/i);
assert.equal(typeof createExternalServicesController, "function");
```

- [ ] **Step 2: Write integration contract tests**

Read `main.cjs`, `provider-bootstrap.cjs`, `preload.cjs`, `types.ts`, `App.tsx`, `ExternalServicesSurface.tsx`, and `scripts/package.cjs`. Assert:

```js
assert.match(providerBootstrap, /setProviderBrowserHost/);
assert.match(main, /setProviderBrowserHost\(\(\) => browserHost\)/);
assert.match(preload, /externalServicesSnapshot/);
assert.match(types, /ExternalServiceSnapshot/);
assert.match(app, /surface === "integrations"/);
assert.match(surface, /Codex Router/);
assert.match(surface, /CPA Provider Hub/);
assert.match(packageScript, /--publish["',\s]+never/);
```

- [ ] **Step 3: Run tests and record RED**

Run:

```bash
node --test desktop-electron/tests/external-services-control-plane.test.cjs desktop-electron/tests/rc7-full-integration-contract.test.cjs
```

Expected: FAIL because the new controller, surface, and bridge do not yet exist.

- [ ] **Step 4: Commit RED contracts**

```bash
git add desktop-electron/tests/external-services-control-plane.test.cjs desktop-electron/tests/rc7-full-integration-contract.test.cjs
git commit -m "test(rc8): define external services control-plane contracts"
```

### Task 2: Implement persistent external-service controller

**Files:**
- Create: `desktop-electron/electron/external-services.cjs`
- Create: `desktop-electron/vendor/upstream/codex-router.json`
- Create: `desktop-electron/vendor/upstream/commandcode-proxy.json`
- Modify: `desktop-electron/electron/upstream-tools.cjs`

**Interfaces:**
- Produces `createExternalServicesController({ filePath, keyPath, safeStorage, logger, spawnProcess, runRuntimeCommand, getProviderSnapshot })`.
- Produces methods `snapshot()`, `configure(id,input)`, `inspect(id)`, `start(id)`, `stop(id)`, `restart(id)`, `syncCodexRouter()`, `dispose()`.
- Existing `createUpstreamToolController` consumes `externalServices` to resolve Paseo/Anneal configuration.

- [ ] **Step 1: Implement strict validators and state schema**

Use `normalizeLoopbackServiceEndpoint` to reject non-HTTP(S), non-loopback, credential-bearing, query, and fragment URLs. Persist versioned records with endpoint, home, executable, arguments, enabled, and autoStart. Encrypt `callerKey` via `safeStorage`; use a private AES-256-GCM fallback key file when unavailable.

- [ ] **Step 2: Implement bounded process ownership**

Spawn only configured executable/argument arrays, with `shell: false`, configured `cwd`, hidden Windows windows, and piped logs. Mark only child processes spawned by the controller as owned. Stop sends `SIGTERM`, waits five seconds, then `SIGKILL` only for an owned process.

- [ ] **Step 3: Implement health inspection**

- Codex Router: request `/_codex-router/<callerKey>/v1/models` when the key is configured.
- CommandCode Proxy: request `/v1/models`; HTTP authentication errors still prove endpoint reachability while recording the status code.
- Paseo and Anneal: request the configured root endpoint.

- [ ] **Step 4: Implement explicit Codex Router sync**

Call `runRuntimeCommand` with:

```js
[
  "router", "integrate", "--apply", "--with-commandcode-proxy",
  "--router-cli", routerCli,
  "--curate-cli", curateCli,
  "--web-base-url", webBaseUrl,
  "--commandcode-base-url", commandCodeBaseUrl,
]
```

Redact the caller key and provider credentials from errors and logs.

- [ ] **Step 5: Adapt Paseo/Anneal upstream controller**

Resolve endpoint, home, executable, and arguments from the external-service snapshot before environment/manifest defaults. Existing embedded-section and loopback rules remain unchanged.

- [ ] **Step 6: Run focused tests**

```bash
node --test desktop-electron/tests/external-services-control-plane.test.cjs desktop-electron/tests/upstream-tool-runtime.test.cjs
node --check desktop-electron/electron/external-services.cjs
node --check desktop-electron/electron/upstream-tools.cjs
```

Expected: PASS.

- [ ] **Step 7: Commit controller**

```bash
git add desktop-electron/electron/external-services.cjs desktop-electron/electron/upstream-tools.cjs desktop-electron/vendor/upstream/codex-router.json desktop-electron/vendor/upstream/commandcode-proxy.json desktop-electron/tests/external-services-control-plane.test.cjs
git commit -m "feat(rc8): add persistent external services controller"
```

### Task 3: Wire BrowserHost, IPC, and packaged runtime integration

**Files:**
- Modify: `desktop-electron/electron/provider-bootstrap.cjs`
- Modify: `desktop-electron/electron/main.cjs`
- Modify: `desktop-electron/electron/preload.cjs`
- Modify: `desktop-electron/src/types.ts`

**Interfaces:**
- Produces `setProviderBrowserHost(getter)`.
- Produces renderer methods `externalServicesSnapshot`, `configureExternalService`, `inspectExternalService`, `startExternalService`, `stopExternalService`, `restartExternalService`, and `syncCodexRouter`.

- [ ] **Step 1: Fix BrowserHost injection**

Replace the hard-coded null browser getter with a mutable getter in `provider-bootstrap.cjs`. After `await browserHost.ready()` in `main.cjs`, call:

```js
setProviderBrowserHost(() => browserHost);
```

- [ ] **Step 2: Initialize service controller**

Construct it after `app.whenReady()` using files under `app.getPath("userData")`; supply `safeStorage`, logger, Provider Hub snapshot access, and a runtime-command runner backed by `runtimeSupervisor.runtimeCommand`.

- [ ] **Step 3: Register focused IPC**

Every mutation requires `assertFocusedMainWindow(event, true)`. Reads require the visible controller. Publish `launcher:external-services-changed` after configuration and lifecycle mutations.

- [ ] **Step 4: Extend preload and TypeScript contracts**

Expose exact typed methods and event subscription. Snapshots expose only `secretConfigured`, never the caller key.

- [ ] **Step 5: Verify**

```bash
node --check desktop-electron/electron/provider-bootstrap.cjs
node --check desktop-electron/electron/main.cjs
node --check desktop-electron/electron/preload.cjs
bun run --cwd desktop-electron typecheck
node --test desktop-electron/tests/external-services-control-plane.test.cjs desktop-electron/tests/provider-center-account-wiring.test.cjs
```

Expected: PASS.

- [ ] **Step 6: Commit bridge**

```bash
git add desktop-electron/electron/provider-bootstrap.cjs desktop-electron/electron/main.cjs desktop-electron/electron/preload.cjs desktop-electron/src/types.ts
git commit -m "feat(rc8): bridge services, Provider Hub, and BrowserHost"
```

### Task 4: Add localized Integrations GUI

**Files:**
- Create: `desktop-electron/src/features/ExternalServicesSurface.tsx`
- Create: `desktop-electron/src/features/external-services.css`
- Modify: `desktop-electron/src/App.tsx`
- Modify: `desktop-electron/src/types.ts`

**Interfaces:**
- Consumes external-service and Provider Hub renderer APIs.
- Produces a new `integrations` surface and navigation item.

- [ ] **Step 1: Build the service overview**

Render CPA Provider Hub, Codex Router, CommandCode Proxy, Paseo, and Anneal cards with status, endpoint, ownership, PID, last check, error, account count, and model count. CPA and CommandCode cards link to Provider Center; Paseo and Anneal cards link to their existing tabs.

- [ ] **Step 2: Build configuration editor**

For external services expose endpoint, home, executable, newline-delimited arguments, enabled, and auto-start. For Codex Router additionally expose caller key as a write-only password, router CLI, curate CLI, and explicit Sync button.

- [ ] **Step 3: Add lifecycle actions**

Add Check, Start, Stop, Restart, and Open controls. Disable Stop/Restart when the endpoint is externally managed and no owned PID exists. Keep all errors in the existing app toast path.

- [ ] **Step 4: Add English and Traditional Chinese copy**

No visible control may use an untranslated hard-coded label when the launcher language is Traditional Chinese.

- [ ] **Step 5: Wire navigation and browser isolation**

Add `integrations` to `Surface`; hide the native ChatGPT browser before navigation, as for Provider Center/Paseo/Anneal.

- [ ] **Step 6: Verify renderer**

```bash
bun run --cwd desktop-electron typecheck
bun x --cwd desktop-electron vite build --outDir ../aiTemp/rc8-services/renderer-dist --emptyOutDir false
CODING_TOOLS_RENDERER_DIST=aiTemp/rc8-services/renderer-dist node --test desktop-electron/tests/renderer-provider-bundle.test.cjs desktop-electron/tests/external-services-control-plane.test.cjs
```

Expected: PASS.

- [ ] **Step 7: Commit GUI**

```bash
git add desktop-electron/src/App.tsx desktop-electron/src/types.ts desktop-electron/src/features/ExternalServicesSurface.tsx desktop-electron/src/features/external-services.css desktop-electron/tests/external-services-control-plane.test.cjs
git commit -m "feat(rc8): add unified external integrations console"
```

### Task 5: Make packaging deterministic and verify end to end

**Files:**
- Modify: `desktop-electron/scripts/package.cjs`
- Modify: `desktop-electron/tests/external-services-control-plane.test.cjs`
- Create: `.github/workflows/rc8-external-services-control-plane.yml`

**Interfaces:**
- Produces exact-head CI and Windows packaging proof without electron-builder publication side effects.

- [ ] **Step 1: Force package-only Electron Builder mode**

Append `--publish never` to the Electron Builder invocation in `scripts/package.cjs`. Keep the existing exact-source publisher unchanged.

- [ ] **Step 2: Add exact-head workflow**

Run syntax, focused contracts, strict TypeScript, isolated renderer build, Rust headless compile, `package:win`, package verification, and packaged smoke. Place dependencies, generated output, and retained evidence under `aiTemp/` and `aiTemp/Trash/`.

- [ ] **Step 3: Run full focused suite**

```bash
node --test \
  desktop-electron/tests/external-services-control-plane.test.cjs \
  desktop-electron/tests/provider-center-account-wiring.test.cjs \
  desktop-electron/tests/provider-multiaccount-global-proxy.test.cjs \
  desktop-electron/tests/commandcode-provider-session.test.cjs \
  desktop-electron/tests/upstream-tool-runtime.test.cjs \
  desktop-electron/tests/rc7-full-integration-contract.test.cjs
bun run --cwd desktop-electron typecheck
```

Expected: all tests and typecheck PASS.

- [ ] **Step 4: Commit release gate**

```bash
git add desktop-electron/scripts/package.cjs desktop-electron/tests/external-services-control-plane.test.cjs .github/workflows/rc8-external-services-control-plane.yml
git commit -m "fix(rc8): package integrations without builder publication"
```

- [ ] **Step 5: Open PR and require green exact-head checks**

Open the PR from `integration/v0.7.0-rc.8-external-services-control-plane` to `release/codex-router-multiprovider-0.7.0-rc.7`. Merge only after the branch and pull-request workflows are green and no deletion is reported.
