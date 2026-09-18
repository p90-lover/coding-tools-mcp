# One-App Tabbed Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CPA, Codex Router, CommandCode Proxy, Paseo, and Anneal operable as persistent tabs inside the Coding Tools main window, with one managed setup and lifecycle authority.

**Architecture:** Add a native Managed Apps workspace with a fixed engine tab strip and bounded embedded content hosts. The Electron main process remains authoritative for installation, process lifecycle, secrets, health, and original-view bridges; the renderer stores only the selected tab and redacted presentation state. Existing surfaces remain reachable for compatibility but route into the tab workspace.

**Tech Stack:** Electron 41, React 19, TypeScript 5.9, Vite 6, Node test runner, Electron `WebContentsView`, existing managed-component and external-service controllers.

**Spec:** `docs/superpowers/specs/2026-09-18-one-app-tabbed-ui-amendment.md`

## Global Constraints

- Work only on `integration/v0.7.0-rc.9-one-app-managed` until the pull request is ready.
- Preserve every existing file, branch, pull request, tag, release, and evidence artifact.
- Put generated or temporary work beneath `aiTemp/`.
- Move superseded or failed runtime material beneath `Trash/`; never add recursive deletion behavior.
- Keep every service loopback-only by default.
- Keep secrets in the Electron main process and return only redacted snapshots to the renderer.
- Do not consume paid provider quota in automated tests.
- Do not launch a second standalone engine application.

---

### Task 1: Introduce the Managed Apps tab shell

**Files:**
- Create: `desktop-electron/src/features/ManagedAppsSurface.tsx`
- Create: `desktop-electron/src/features/managed-apps.css`
- Modify: `desktop-electron/src/App.tsx`
- Modify: `desktop-electron/src/types.ts`
- Modify: `desktop-electron/src/features/ExternalServicesSurface.tsx`
- Test: `desktop-electron/tests/managed-app-tabs.test.cjs`

**Interfaces:**
- Consumes: existing `ProviderCenterSurface`, `ExternalServicesSurface`, `UpstreamToolSurface`, `PaseoOrchestratorSurface`, and `AnnealTasksSurface`.
- Produces: `ManagedAppTabId`, `ManagedAppsSurface({ language, selectedTab, onSelectedTabChange, setError })`.

- [ ] **Step 1: Write the failing renderer contract**

Create a Node contract that requires fixed tabs for `cpa`, `codex-router`, `commandcode-proxy`, `paseo`, and `anneal`; requires one `apps` surface in `App.tsx`; and rejects standalone-window wording in the new tab component.

- [ ] **Step 2: Run the contract and confirm RED**

Run:

```bash
node --test desktop-electron/tests/managed-app-tabs.test.cjs
```

Expected: failure because `ManagedAppsSurface.tsx` and the `apps` surface do not exist.

- [ ] **Step 3: Add the tab component and styles**

Implement a sticky, horizontally scrollable tab strip with localized labels and redacted health indicators. Render the existing CPA Provider Center, focused Codex Router controls, focused CommandCode controls, Paseo original/native surface, and Anneal original/native surface in one full-height panel.

- [ ] **Step 4: Wire the shell to one Managed Apps entry**

Add `apps` to `Surface`. Replace separate primary engine navigation entries with one Managed Apps entry. Keep old surface branches for compatibility, but route user-facing callbacks into the appropriate managed tab.

- [ ] **Step 5: Add focused-service support**

Add an optional `preferredServiceId` to `ExternalServicesSurface` so the Codex Router and CommandCode tabs open their own controls without forcing the user to reselect a service card.

- [ ] **Step 6: Verify Task 1**

Run:

```bash
node --test desktop-electron/tests/managed-app-tabs.test.cjs \
  desktop-electron/tests/external-services-control-plane.test.cjs \
  desktop-electron/tests/renderer-wiring.test.cjs
bun run --cwd desktop-electron typecheck
```

Expected: all tests and typecheck pass.

- [ ] **Step 7: Commit**

```bash
git add desktop-electron/src desktop-electron/tests/managed-app-tabs.test.cjs
git commit -m "feat(rc9): add one-window managed app tabs"
```

---

### Task 2: Persist active engine-tab state

**Files:**
- Modify: `desktop-electron/electron/state.cjs`
- Modify: `desktop-electron/electron/main.cjs`
- Modify: `desktop-electron/electron/preload.cjs`
- Modify: `desktop-electron/src/types.ts`
- Modify: `desktop-electron/src/App.tsx`
- Test: `desktop-electron/tests/managed-app-tab-state.test.cjs`

**Interfaces:**
- Consumes: `ManagedAppTabId` from Task 1.
- Produces: `setManagedAppTab(tab: ManagedAppTabId): Promise<LauncherState>` and `LauncherState.managedAppTab`.

- [ ] **Step 1: Write failing state and IPC contracts**
- [ ] **Step 2: Verify RED**
- [ ] **Step 3: Add schema validation and persisted default `cpa`**
- [ ] **Step 4: Add focused-window IPC and preload method**
- [ ] **Step 5: Bind renderer state without storing secrets**
- [ ] **Step 6: Run state, preload, and typecheck suites**
- [ ] **Step 7: Commit**

---

### Task 3: Consolidate CPA as the first managed app tab

**Files:**
- Reconcile from PR #179: `desktop-electron/electron/cpa-managed.cjs`, managed manifest, controller wiring, tests.
- Reconcile from PR #180: CPA original UI host and bounded clipboard action.
- Modify: `desktop-electron/src/features/ManagedAppsSurface.tsx`
- Test: `desktop-electron/tests/rc9-managed-cpa-runtime.test.cjs`
- Test: `desktop-electron/tests/managed-cpa-tab.test.cjs`

**Interfaces:**
- Consumes: managed component controller and tab shell.
- Produces: app-managed CPA install/start/stop/repair and embedded original `management.html` inside the CPA tab.

- [ ] **Step 1: Add failing contracts for managed CPA and embedded UI**
- [ ] **Step 2: Port the verified checksum-pinned CPA runtime without duplicate account storage**
- [ ] **Step 3: Add the original management UI host inside the tab**
- [ ] **Step 4: Gate management-key copy through focused-window IPC**
- [ ] **Step 5: Run real loopback CPA smoke and secret-redaction tests**
- [ ] **Step 6: Commit**

---

### Task 4: Embed Codex Router Control Center in the tab

**Files:**
- Modify: `desktop-electron/electron/codex-router-managed.cjs`
- Create: `desktop-electron/electron/codex-router-tab-host.cjs`
- Create: `desktop-electron/electron/codex-router-tab-preload.cjs`
- Modify: `desktop-electron/electron/main.cjs`
- Modify: `desktop-electron/electron/preload.cjs`
- Modify: `desktop-electron/src/features/ManagedAppsSurface.tsx`
- Test: `desktop-electron/tests/codex-router-tab-host.test.cjs`

**Interfaces:**
- Produces: bounded `show`, `hide`, `bounds`, `navigate`, and `dispose` operations for a main-window `WebContentsView`.

- [ ] **Step 1: Write a failing contract that forbids spawning a second Electron application**
- [ ] **Step 2: Build the pinned original Control Center during managed installation**
- [ ] **Step 3: Attach an isolated `WebContentsView` to the main window**
- [ ] **Step 4: Expose the minimum `routerControl` bridge through a dedicated preload**
- [ ] **Step 5: Synchronize visibility and bounds with the active tab**
- [ ] **Step 6: Verify stop/restart disposes child views and router-owned processes safely**
- [ ] **Step 7: Commit**

---

### Task 5: Complete CommandCode, Paseo, and Anneal tabs

**Files:**
- Reconcile selected changes from PR #178.
- Modify: `desktop-electron/src/features/ManagedAppsSurface.tsx`
- Modify: `desktop-electron/src/features/UpstreamToolSurface.tsx`
- Modify: `desktop-electron/electron/upstream-tools.cjs`
- Test: `desktop-electron/tests/original-upstream-panels.test.cjs`
- Test: `desktop-electron/tests/managed-engine-tabs.test.cjs`

**Interfaces:**
- CommandCode tab uses managed lifecycle and dedicated account/session adapter.
- Paseo tab uses real routes `/sessions`, `/open-project`, and `/settings`.
- Anneal tab uses real hash routes such as `#/tasks`, `#/projects`, and `#/inbox`.

- [ ] **Step 1: Write failing real-route and no-external-window contracts**
- [ ] **Step 2: Port CommandCode CLI identity, authenticated health, models, and lifecycle actions**
- [ ] **Step 3: Port Paseo real-route embedding and native orchestration panel**
- [ ] **Step 4: Port Anneal hash-route embedding while retaining app-managed WSL2 topology**
- [ ] **Step 5: Run focused tab, routing, and execution tests**
- [ ] **Step 6: Commit**

---

### Task 6: Add unified Install and start all orchestration

**Files:**
- Create: `desktop-electron/electron/managed-setup-orchestrator.cjs`
- Modify: `desktop-electron/electron/main.cjs`
- Modify: `desktop-electron/electron/preload.cjs`
- Modify: `desktop-electron/src/features/ManagedAppsSurface.tsx`
- Modify: `desktop-electron/src/types.ts`
- Test: `desktop-electron/tests/managed-setup-orchestrator.test.cjs`

**Interfaces:**
- Produces: `installAndStartAll()`, `retryManagedSetup()`, redacted progress snapshots, and partial-failure recovery.

- [ ] **Step 1: Write failing dependency-graph and retry tests**
- [ ] **Step 2: Implement prerequisite inspection and deterministic component order**
- [ ] **Step 3: Implement bounded parallelism and partial-failure behavior**
- [ ] **Step 4: Add one setup action and per-tab progress badges**
- [ ] **Step 5: Run orchestration, lifecycle, and no-delete tests**
- [ ] **Step 6: Commit**

---

### Task 7: Finish beta update channels and install-location preservation

**Files:**
- Reconcile PR #174.
- Modify: `desktop-electron/electron/update.cjs`
- Modify: `desktop-electron/electron/update-worker.cjs`
- Modify: `desktop-electron/electron/main.cjs`
- Modify: `desktop-electron/build/installer.nsh`
- Modify: settings renderer/types/state.
- Test: `desktop-electron/tests/install-location-beta-update-prompt.test.cjs`
- Test: `desktop-electron/tests/update-channel.test.cjs`

**Interfaces:**
- Produces update channels `stable`, `beta`, and `automatic`.

- [ ] **Step 1: Write update-channel RED tests**
- [ ] **Step 2: Port the verified prompt and `/D=<current directory>` changes**
- [ ] **Step 3: Persist update channel with rc.8 prerelease defaulting to `automatic`**
- [ ] **Step 4: Verify prerelease discovery and exact checksum behavior**
- [ ] **Step 5: Commit**

---

### Task 8: Repair Windows smoke retention and run the release gate

**Files:**
- Modify: `desktop-electron/scripts/preservation.cjs`
- Modify: `desktop-electron/scripts/smoke-package.cjs`
- Modify: rc.9 release workflows.
- Test: preservation and packaged launcher tests.

**Interfaces:**
- A locked smoke directory is retained in place or copied after bounded shutdown/retry; it is never deleted.

- [ ] **Step 1: Reproduce the Windows `EPERM` preservation failure in a contract**
- [ ] **Step 2: Add bounded process shutdown and rename retry**
- [ ] **Step 3: Fall back to retained in-place evidence without deletion**
- [ ] **Step 4: Run Windows package, installer migration, launcher smoke, tab UI, CPA, and managed-component gates on one SHA**
- [ ] **Step 5: Publish only after immutable-source and remote asset readback succeed**
- [ ] **Step 6: Commit and prepare PR #182 for final review**
