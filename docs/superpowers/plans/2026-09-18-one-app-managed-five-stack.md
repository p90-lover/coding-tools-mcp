# One-App Managed Five-Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the merged rc.9 five-stack initialize, repair, start, and report itself automatically from one Coding Tools application, then carry the beta updater/install-location repair into the same release line.

**Architecture:** Add a dependency-injected main-process bootstrap coordinator above the existing managed component and external-services controllers. It reconciles component state without blocking the launcher, publishes one aggregate status to the renderer, resumes targeted components after credential writes, and preserves the existing loopback, encryption, routing, and Trash-retention boundaries. The existing component processes remain isolated internal children; no separate component UI or manual repository setup is required.

**Tech Stack:** Electron 41, CommonJS main process, React 19/TypeScript renderer, Node test runner, Bun build tooling, GitHub Actions, NSIS Windows packaging.

**Spec:** `docs/superpowers/specs/2026-09-18-one-app-managed-five-stack-design.md`

## Global Constraints

- Base all work on `release/codex-router-multiprovider-0.7.0-rc.8` after merged PR #175, commit `ca21275aee04289657f8a585d30590504058d311` or its fast-forward descendants.
- Keep product version `0.7.0-rc.9` until an rc.9 release is published.
- Do not delete files, branches, releases, user data, runtime evidence, or superseded component installations.
- Put temporary build and validation output under `aiTemp/`; move superseded material under `Trash/`.
- Keep every managed listener on loopback.
- Never return provider or managed-component credential values to the renderer.
- Automatic validation must not consume paid provider quota or real OAuth credentials.
- Anneal may retain its Windows WSL2/Docker platform boundary, but setup and diagnostics must remain inside Coding Tools.
- Every behavior change follows RED -> GREEN -> refactor and receives a focused regression test.

---

### Task 1: Add the automatic bootstrap state machine

**Files:**
- Create: `desktop-electron/tests/managed-bootstrap.test.cjs`
- Create: `desktop-electron/electron/managed-bootstrap.cjs`

**Interfaces:**
- Consumes: callbacks `snapshot()`, `install(id)`, `repair(id)`, `start(id)`, `inspect(id)`.
- Produces: `createManagedBootstrap(options)` returning `reconcile({ reason, componentIds? })`, `getSnapshot()`, and `dispose()`.
- Snapshot shape:

```ts
interface ManagedBootstrapSnapshot {
  status: "idle" | "running" | "ready" | "blocked" | "error";
  reason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  components: Array<{
    id: string;
    status: "pending" | "installing" | "repairing" | "starting" | "ready" | "blocked" | "error";
    action: "install" | "repair" | "start" | "inspect" | null;
    missingCredentials: string[];
    message: string | null;
  }>;
}
```

- [ ] **Step 1: Write the failing coordinator tests**

Create tests with a small mutable fake component snapshot. Cover these independent behaviors:

```js
test("bootstrap installs missing, repairs damaged, starts installed, and inspects external components", async () => {
  // codex-router: not-installed
  // commandcode-proxy: repair-required
  // paseo: installed
  // anneal: external
  // Assert exact operation order and final ready statuses.
});

test("bootstrap blocks only the component with missing credentials", async () => {
  // Anneal has missingCredentials: ["githubReadToken"].
  // Paseo still starts and the aggregate state is blocked, not error.
});

test("bootstrap keeps reconciling after one component fails", async () => {
  // CommandCode install rejects; Paseo still starts.
  // Aggregate state is error and both per-component outcomes are retained.
});

test("concurrent reconcile calls share one active run and queue one targeted follow-up", async () => {
  // Hold the first install with a deferred promise.
  // Call reconcile twice and assert no duplicate install.
  // Target Anneal during the active run and assert one follow-up pass.
});

test("dispose prevents future reconciliation", async () => {
  // dispose(), then reconcile() rejects with a stable error.
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd desktop-electron
node --test tests/managed-bootstrap.test.cjs
```

Expected: failure because `../electron/managed-bootstrap.cjs` does not exist.

- [ ] **Step 3: Implement the minimal coordinator**

Implement `createManagedBootstrap` with:

```js
const DEFAULT_COMPONENT_IDS = Object.freeze([
  "codex-router",
  "commandcode-proxy",
  "paseo",
  "anneal",
]);
```

Use one active promise and one `Set` of queued targeted IDs. Derive the operation from `managedInstall.state`, `managedInstall.home`, and `managedInstall.missingCredentials`. Catch each component operation independently and continue. Publish immutable-cloned snapshots after every transition. Do not import Electron or filesystem modules.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
cd desktop-electron
node --test tests/managed-bootstrap.test.cjs
node --check electron/managed-bootstrap.cjs
```

Expected: all tests pass and syntax check exits 0.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron/electron/managed-bootstrap.cjs desktop-electron/tests/managed-bootstrap.test.cjs
git commit -m "feat(rc9): add automatic managed integration bootstrap"
```

---

### Task 2: Wire bootstrap into the managed external-services controller

**Files:**
- Modify: `desktop-electron/electron/managed-external-services.cjs`
- Modify: `desktop-electron/tests/external-services-control-plane.test.cjs`

**Interfaces:**
- Consumes: `createManagedBootstrap` from Task 1.
- Produces controller methods:

```js
reconcileManagedComponents(options)
managedBootstrapSnapshot()
```

- `setManagedComponentCredential(serviceId, key, value)` must queue targeted reconciliation after the encrypted write succeeds.

- [ ] **Step 1: Add failing controller integration tests**

Add tests proving:

```js
test("managed controller startup reconciliation delegates through install repair start and inspect", async () => {
  // Inject a bootstrap factory or narrow fake dependencies.
  // Assert controller exposes reconcileManagedComponents and snapshot.
});

test("saving a managed credential queues targeted reconciliation without exposing the value", async () => {
  // Save Anneal githubReadToken.
  // Assert target is ["anneal"].
  // Assert combined snapshots do not contain the token string.
});
```

Use dependency injection rather than mocking module internals globally.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
cd desktop-electron
node --test tests/external-services-control-plane.test.cjs
```

Expected: failures for missing reconciliation methods/targeted credential behavior.

- [ ] **Step 3: Implement controller wiring**

Instantiate the bootstrap after both base and managed controllers exist:

```js
bootstrap = createManagedBootstrap({
  snapshot: combinedSnapshot,
  install: installManagedComponent,
  repair: repairManagedComponent,
  start,
  inspect,
  publish: publishCombined,
  logger: options.logger,
});
```

Avoid recursion by passing internal lifecycle functions that do not call bootstrap. After `setComponentCredential`, call:

```js
void bootstrap.reconcile({
  reason: "credential-saved",
  componentIds: [serviceId],
});
```

Expose the two new methods and dispose the bootstrap before the underlying controllers.

- [ ] **Step 4: Verify GREEN and regression coverage**

```bash
cd desktop-electron
node --test tests/managed-bootstrap.test.cjs tests/external-services-control-plane.test.cjs tests/managed-components-runtime.test.cjs
node --check electron/managed-external-services.cjs
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron/electron/managed-external-services.cjs desktop-electron/tests/external-services-control-plane.test.cjs
git commit -m "feat(rc9): reconcile managed services automatically"
```

---

### Task 3: Start reconciliation from the launcher and expose retry IPC

**Files:**
- Modify: `desktop-electron/electron/main.cjs`
- Modify: `desktop-electron/electron/preload.cjs`
- Modify: `desktop-electron/src/types.ts`
- Create: `desktop-electron/tests/managed-bootstrap-ipc-contract.test.cjs`

**Interfaces:**
- New IPC invoke channel: `launcher:managed-components-retry-all`.
- New renderer API method:

```ts
retryManagedComponents(): Promise<ExternalServicesSnapshot>
```

- Bootstrap status is embedded into `ExternalServicesSnapshot` as `managedBootstrap` so the existing snapshot event remains the single live stream.

- [ ] **Step 1: Write the failing IPC/static contract tests**

Test source contracts for:

```js
assert.match(mainSource, /launcher:managed-components-retry-all/);
assert.match(mainSource, /reconcileManagedComponents\(\{\s*reason:\s*"startup"/s);
assert.match(preloadSource, /retryManagedComponents/);
assert.match(typesSource, /managedBootstrap: ManagedBootstrapSnapshot/);
```

Also assert startup reconciliation is fire-and-observe rather than awaited before window creation.

- [ ] **Step 2: Run and verify RED**

```bash
cd desktop-electron
node --test tests/managed-bootstrap-ipc-contract.test.cjs
```

Expected: missing channel/API/type failures.

- [ ] **Step 3: Implement startup and IPC wiring**

After the managed external-services controller is initialized and runtime resolution is available, start:

```js
void externalServicesController.reconcileManagedComponents({ reason: "startup" })
  .catch((error) => logger.warn("managed-bootstrap.startup-failed", {
    message: error instanceof Error ? error.message : String(error),
  }));
```

Register focused-window retry IPC and expose it through the preload. Extend renderer types with the exact Task 1 snapshot union.

- [ ] **Step 4: Run tests, typecheck, and syntax checks**

```bash
cd desktop-electron
node --test tests/managed-bootstrap-ipc-contract.test.cjs tests/external-services-control-plane.test.cjs
node --check electron/main.cjs
node --check electron/preload.cjs
bun run typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron/electron/main.cjs desktop-electron/electron/preload.cjs desktop-electron/src/types.ts desktop-electron/tests/managed-bootstrap-ipc-contract.test.cjs
git commit -m "feat(rc9): bootstrap integrations on launcher startup"
```

---

### Task 4: Add the aggregate one-app setup surface

**Files:**
- Modify: `desktop-electron/src/features/ExternalServicesSurface.tsx`
- Modify: `desktop-electron/src/features/external-services.css`
- Create: `desktop-electron/tests/managed-bootstrap-renderer-contract.test.cjs`

**Interfaces:**
- Consumes: `snapshot.managedBootstrap` and `api.retryManagedComponents()`.
- Produces: one aggregate status card and Retry all action.

- [ ] **Step 1: Write failing renderer contract tests**

Assert the source includes English and Traditional Chinese strings for:

```text
Preparing integrations / 正在準備整合功能
All integrations are ready / 所有整合功能已就緒
Setup is blocked / 設定暫時受阻
Retry all / 全部重試
```

Assert the button invokes `retryManagedComponents` and per-component advanced controls remain present.

- [ ] **Step 2: Run and verify RED**

```bash
cd desktop-electron
node --test tests/managed-bootstrap-renderer-contract.test.cjs
```

Expected: missing aggregate card/copy/retry action.

- [ ] **Step 3: Implement the status card**

Render status from the bootstrap snapshot. For blocked components, show component name plus missing credential keys or sanitized message. For errors, show the retained component error and Retry all. Disable Retry all while status is `running`.

Keep raw executable/home controls in the existing advanced disclosure; do not remove diagnostic controls.

- [ ] **Step 4: Verify renderer and focused tests**

```bash
cd desktop-electron
node --test tests/managed-bootstrap-renderer-contract.test.cjs tests/rc9-five-stack-completion.test.cjs
bun run typecheck
bun run build:renderer -- --outDir ../aiTemp/rc9-one-app-managed/renderer-build
```

Expected: tests, typecheck, and production renderer build pass; output is under `aiTemp/`.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron/src/features/ExternalServicesSurface.tsx desktop-electron/src/features/external-services.css desktop-electron/tests/managed-bootstrap-renderer-contract.test.cjs
git commit -m "feat(rc9): show unified integration setup progress"
```

---

### Task 5: Reconcile the beta updater and install-location repair

**Files:**
- Integrate reviewed changes from PR #174 into the current rc.9 branch.
- Expected touched files include:
  - `desktop-electron/build/installer.nsh`
  - `desktop-electron/electron/main.cjs`
  - `desktop-electron/electron/update-worker.cjs`
  - `desktop-electron/tests/installer-upgrade-migration.test.cjs`
  - `desktop-electron/tests/update.test.cjs`
  - related focused updater/prompt contracts from PR #174.

**Interfaces:**
- Windows update jobs pass the current executable directory as final NSIS `/D=<directory>` argument.
- Legacy migration assigns one validated previous install location to `$INSTDIR`.
- Available stable or prerelease updates display localized Install/Later confirmation before `beginInstall()`.

- [ ] **Step 1: Update PR #174 against the current release head**

Use the current release head as the base and retain the PR's test-first commits. Resolve only actual overlaps with rc.9 main-process changes; do not drop five-stack startup reconciliation.

- [ ] **Step 2: Run updater/migration tests and confirm RED then GREEN history remains valid**

```bash
cd desktop-electron
node --test tests/update.test.cjs tests/installer-upgrade-migration.test.cjs
```

Expected: all reviewed PR #174 regression tests pass on the combined source.

- [ ] **Step 3: Run Windows-specific static/package contracts**

```bash
cd desktop-electron
node --test tests/package-contents.test.cjs tests/package-resource-preparation.test.cjs tests/product-identity.test.cjs
```

Expected: all pass.

- [ ] **Step 4: Commit the reconciled update repair**

```bash
git commit -m "fix(rc9): preserve install path and prompt for beta updates"
```

---

### Task 6: Add exact-source CI for the one-app contract

**Files:**
- Create: `.github/workflows/rc9-one-app-managed.yml`
- Create: `desktop-electron/tests/rc9-one-app-managed-contract.test.cjs`

**Interfaces:**
- Workflow runs on the integration branch and PR changes to managed/bootstrap/updater files.
- Uses pinned action SHAs and Bun `1.4.0`.

- [ ] **Step 1: Write the failing release contract**

Assert:

- version remains `0.7.0-rc.9`;
- all four managed manifests are packaged;
- `managed-bootstrap.cjs` is packaged;
- startup reconciliation and retry IPC exist;
- English/Traditional Chinese aggregate copy exists;
- updater accepts prereleases, preserves install directory, and requires checksums;
- no changed tracked file is deleted relative to the release base.

- [ ] **Step 2: Run and verify RED before workflow/materialization updates**

```bash
cd desktop-electron
node --test tests/rc9-one-app-managed-contract.test.cjs
```

- [ ] **Step 3: Add the exact-source workflow**

Run focused Node tests, syntax checks, TypeScript, renderer build under `aiTemp/rc9-one-app-managed/`, and a no-delete diff gate against the release base. Do not publish or consume provider quota.

- [ ] **Step 4: Verify locally available gates**

```bash
cd desktop-electron
node --test \
  tests/managed-bootstrap.test.cjs \
  tests/external-services-control-plane.test.cjs \
  tests/managed-bootstrap-ipc-contract.test.cjs \
  tests/managed-bootstrap-renderer-contract.test.cjs \
  tests/update.test.cjs \
  tests/installer-upgrade-migration.test.cjs \
  tests/rc9-one-app-managed-contract.test.cjs
bun run typecheck
bun run build:renderer -- --outDir ../aiTemp/rc9-one-app-managed/renderer-build
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/rc9-one-app-managed.yml desktop-electron/tests/rc9-one-app-managed-contract.test.cjs
git commit -m "ci(rc9): gate one-app managed integration"
```

---

### Task 7: Package, smoke-test, merge, and publish rc.9 prerelease

**Files:**
- Update release notes/workflow inputs only where required by the existing authoritative release process.
- Retain all output under `aiTemp/` until publication.

**Interfaces:**
- Release tag: `v0.7.0-rc.9`.
- Windows asset: `Coding.Tools_0.7.0-rc.9_windows_x64_setup.exe`.
- Required checksum asset: `SHA256SUMS.txt`.

- [ ] **Step 1: Wait for every pull-request workflow on the exact head**

Required green gates include the new one-app workflow, five-stack union, managed five-stack, unified CPA OAuth, provider execution, UI parity, external-services control plane, Windows package verification, packaged-launcher smoke, migration acceptance, checksum, provenance, and no-delete checks.

- [ ] **Step 2: Run verification-before-completion review**

Confirm exact head SHA, test counts, package identity, installer asset name, checksum entry, and absence of deleted tracked paths.

- [ ] **Step 3: Merge into the rc.9 release line**

Use a merge commit that preserves branch history and names the exact verified head. Do not merge if any required check is pending or failing.

- [ ] **Step 4: Publish GitHub prerelease**

Publish non-draft `v0.7.0-rc.9` with `prerelease: true`, the Windows installer, `SHA256SUMS.txt`, provenance, and validation evidence. Do not mark it as stable latest unless the existing release policy does so explicitly.

- [ ] **Step 5: Verify remote readback and updater eligibility**

Re-read the release by tag and verify exact asset names, sizes, SHA-256 values, and source SHA. Confirm rc.8's updater selects rc.9 as the newest complete compatible prerelease.
