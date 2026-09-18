# Integrated App UI Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put CPA, Codex Router, CommandCode Proxy, Paseo, and Anneal into one accessible Coding Tools Apps workspace with one dedicated tab per application.

**Architecture:** Add a renderer-only tab coordinator that composes existing provider, service, and upstream-tool surfaces. Extend the existing service control surface with a focused mode instead of duplicating lifecycle logic. Preserve legacy surfaces for compatibility while making Apps the only primary navigation entry for the five integrated apps.

**Tech Stack:** Electron 41, React 19, TypeScript 5.9, Vite 6, Node test runner, existing `codexWebLauncher` IPC.

**Spec:** `docs/superpowers/specs/2026-09-18-integrated-app-ui-tabs-design.md`

## Global Constraints

- Base all work on `release/codex-router-multiprovider-0.7.0-rc.9` through `integration/v0.7.0-rc.10-app-ui-tabs`.
- Do not delete project files, branches, releases, user data, or retained evidence.
- Temporary validation output belongs under `aiTemp/` or `aiTemp/Trash/`.
- Do not persist credentials or tokens in renderer storage.
- Preserve existing provider, proxy, lifecycle, and execution-routing behavior.
- New controls require English and Traditional Chinese labels.

---

### Task 1: Add failing app-tab contracts

**Files:**
- Create: `desktop-electron/tests/integrated-app-tabs.test.cjs`
- Test: `desktop-electron/tests/integrated-app-tabs.test.cjs`

**Interfaces:**
- Consumes: renderer source files as text contracts.
- Produces: a focused regression gate for the five tab IDs, shell Apps wiring, focused service mode, and upstream route correctness.

- [ ] **Step 1: Write the failing contract**

Create a Node test that reads `src/features/IntegratedAppsSurface.tsx`, `src/App.tsx`, `src/types.ts`, `src/features/ExternalServicesSurface.tsx`, and both upstream manifests. Assert:

```js
const expectedTabs = ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"];
for (const tab of expectedTabs) assert.match(appsSource, new RegExp(`\\"${tab}\\"`));
assert.match(typesSource, /Surface = .*"apps"/s);
assert.match(shellSource, /surface === "apps"/);
assert.match(serviceSource, /focusServiceId\?: ExternalServiceId/);
assert.match(paseoManifest, /"sessions": "\/sessions"/);
assert.match(annealManifest, /"tasks": "#\/tasks"/);
```

- [ ] **Step 2: Run the contract and confirm RED**

Run:

```bash
node --test desktop-electron/tests/integrated-app-tabs.test.cjs
```

Expected: failure because `IntegratedAppsSurface.tsx` and the `apps` surface do not exist.

- [ ] **Step 3: Commit the RED test**

```bash
git add desktop-electron/tests/integrated-app-tabs.test.cjs
git commit -m "test(rc10): define integrated app tab contract"
```

---

### Task 2: Add the tab coordinator and focused service mode

**Files:**
- Create: `desktop-electron/src/features/IntegratedAppsSurface.tsx`
- Create: `desktop-electron/src/features/integrated-apps.css`
- Modify: `desktop-electron/src/features/ExternalServicesSurface.tsx`
- Test: `desktop-electron/tests/integrated-app-tabs.test.cjs`

**Interfaces:**
- Consumes: `ProviderCenterSurface`, `ExternalServicesSurface`, `UpstreamToolSurface`, `PaseoOrchestratorSurface`, `AnnealTasksSurface`.
- Produces: `IntegratedAppsSurface({ language, setError })` and `ExternalServicesSurface.focusServiceId?: ExternalServiceId`.

- [ ] **Step 1: Add focused service mode**

Extend the props:

```ts
interface ExternalServicesSurfaceProps {
  language: Language;
  setError: (error: string | null) => void;
  openProviders: () => void;
  openPaseo: () => void;
  openAnneal: () => void;
  focusServiceId?: ExternalServiceId;
}
```

Initialize `selectedId` from `focusServiceId`, update it when the prop changes, filter `serviceRows` to the focused service, and omit the all-service summary when focused.

- [ ] **Step 2: Implement the Apps tab coordinator**

Create these exact IDs and persistence key:

```ts
export type IntegratedAppTab = "cpa" | "codex-router" | "commandcode-proxy" | "paseo" | "anneal";
const STORAGE_KEY = "coding-tools-integrated-app-tab-v1";
```

Render the current tab as follows:

```tsx
{activeTab === "cpa" ? <ProviderCenterSurface language={language} setError={setError} /> : null}
{activeTab === "codex-router" ? <ExternalServicesSurface focusServiceId="codex-router" ... /> : null}
{activeTab === "commandcode-proxy" ? <ExternalServicesSurface focusServiceId="commandcode-proxy" ... /> : null}
{activeTab === "paseo" ? <UpstreamToolSurface toolId="paseo" nativeControl={<PaseoOrchestratorSurface ... />} ... /> : null}
{activeTab === "anneal" ? <UpstreamToolSurface toolId="anneal" nativeControl={<AnnealTasksSurface ... />} ... /> : null}
```

Use `role="tablist"`, `role="tab"`, `role="tabpanel"`, arrow-key navigation, Home/End handling, and a horizontally scrollable tab strip.

- [ ] **Step 3: Add tab workspace styles**

The new stylesheet must provide:

```css
.integrated-apps-surface { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.integrated-app-tabs { flex: 0 0 auto; overflow-x: auto; }
.integrated-app-panel { min-height: 0; flex: 1; overflow: hidden; }
.integrated-app-tab { min-height: 42px; white-space: nowrap; }
```

The active tab must have a visible border/background and `:focus-visible` state.

- [ ] **Step 4: Run the focused contract**

```bash
node --test desktop-electron/tests/integrated-app-tabs.test.cjs
```

Expected: remaining failures only for shell and manifest wiring.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron/src/features/IntegratedAppsSurface.tsx \
  desktop-electron/src/features/integrated-apps.css \
  desktop-electron/src/features/ExternalServicesSurface.tsx
git commit -m "feat(rc10): add integrated app tab workspace"
```

---

### Task 3: Wire Apps into the shell and correct upstream routes

**Files:**
- Modify: `desktop-electron/src/types.ts`
- Modify: `desktop-electron/src/App.tsx`
- Modify: `desktop-electron/vendor/upstream/paseo.json`
- Modify: `desktop-electron/vendor/upstream/anneal.json`
- Modify: `desktop-electron/src/features/UpstreamToolSurface.tsx`
- Test: `desktop-electron/tests/integrated-app-tabs.test.cjs`

**Interfaces:**
- Consumes: `IntegratedAppsSurface` from Task 2.
- Produces: primary `apps` navigation and working embedded upstream routes.

- [ ] **Step 1: Add the Apps surface type**

Add `"apps"` to the `Surface` union without removing legacy values.

- [ ] **Step 2: Replace fragmented primary navigation**

Import `IntegratedAppsSurface`. Add one sidebar item:

```tsx
<SidebarItem
  active={surface === "apps"}
  icon="orchestrator"
  label={language === "zh-TW" ? "應用程式" : "Apps"}
  onClick={() => navigateSurface("apps")}
/>
```

Remove the separate Providers, Integrations, Paseo, and Anneal sidebar items, but leave their render branches for compatibility.

Render:

```tsx
{surface === "apps" ? <IntegratedAppsSurface language={language} setError={setError} /> : null}
```

- [ ] **Step 3: Correct Paseo routes**

Set:

```json
{
  "agents": "/sessions",
  "sessions": "/sessions",
  "workspaces": "/open-project",
  "providers": "/settings",
  "plugins": "/settings",
  "voice": "/settings",
  "settings": "/settings"
}
```

- [ ] **Step 4: Correct Anneal hash routes**

Convert each section path to `#/...`, including `#/tasks`, `#/projects`, and `#/settings`.

- [ ] **Step 5: Auto-open ready upstream tools**

On initial snapshot, call `inspectUpstreamTool(toolId)`. When status is `ready`, open the first section and set its frame URL. Guard cancellation and surface changes so a stale async result cannot update another tab.

- [ ] **Step 6: Run focused and existing contracts**

```bash
node --test \
  desktop-electron/tests/integrated-app-tabs.test.cjs \
  desktop-electron/tests/upstream-tools.test.cjs \
  desktop-electron/tests/upstream-tool-runtime.test.cjs \
  desktop-electron/tests/external-services-control-plane.test.cjs
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add desktop-electron/src/types.ts desktop-electron/src/App.tsx \
  desktop-electron/vendor/upstream/paseo.json \
  desktop-electron/vendor/upstream/anneal.json \
  desktop-electron/src/features/UpstreamToolSurface.tsx
git commit -m "feat(rc10): expose all integrated apps as tabs"
```

---

### Task 4: Verify renderer, add CI, and open the PR

**Files:**
- Create: `.github/workflows/rc10-integrated-app-tabs.yml`
- Modify only if verification requires a focused correction: files from Tasks 1–3.

**Interfaces:**
- Consumes: completed source and focused tests.
- Produces: exact-head CI evidence and a reviewable PR into the rc.9 release line.

- [ ] **Step 1: Add exact-head CI**

The workflow must run on the integration branch and PRs targeting `release/codex-router-multiprovider-0.7.0-rc.9`. It must:

```bash
bun install --cwd desktop-electron --frozen-lockfile
bun run --cwd desktop-electron typecheck
bun run --cwd desktop-electron build:renderer
node --test desktop-electron/tests/integrated-app-tabs.test.cjs \
  desktop-electron/tests/upstream-tools.test.cjs \
  desktop-electron/tests/upstream-tool-runtime.test.cjs \
  desktop-electron/tests/external-services-control-plane.test.cjs \
  desktop-electron/tests/provider-hub-ui-contract.test.cjs
```

Then enforce:

```bash
git diff --check
test -z "$(git diff --diff-filter=D --name-only)"
```

Retain evidence under `aiTemp/evidence/` and generated renderer material under `aiTemp/Trash/` before restoring tracked output.

- [ ] **Step 2: Run final verification**

Expected results:

```text
TypeScript: pass
Production renderer: pass
Focused contracts: 0 failures
Deleted project paths: none
```

- [ ] **Step 3: Review the branch diff**

Verify no credential is written to local storage and no service lifecycle logic is duplicated in `IntegratedAppsSurface`.

- [ ] **Step 4: Open a draft PR**

Open:

```text
integration/v0.7.0-rc.10-app-ui-tabs
→ release/codex-router-multiprovider-0.7.0-rc.9
```

The PR body must list the five tabs, upstream route fixes, focused-service reuse, tests, and no-delete guarantees.
