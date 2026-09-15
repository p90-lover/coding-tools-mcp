# Electron-first Full Codex Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the primary Tauri desktop shell with a Coding Tools-branded Electron application that preserves the pinned `codex-chatgpt-web` v5.0.6 Full Codex Harness and supervises the existing Coding Tools Rust capabilities as a private headless sidecar.

**Architecture:** The Electron main process owns ChatGPT browser state, Codex routing, task-bound browser surfaces, the official OpenAI tunnel client, updates, and the unified renderer. A reusable Rust core plus a headless Rust executable remains authoritative for workspaces, local tools, permissions, long-running commands, computer use, history, native Codex sessions, and existing integrations. Full Harness calls reach Rust only through a short-lived capability bound to the exact Codex task, turn, compaction epoch, workspace roots, policy revision, and tool-catalogue hash.

**Tech Stack:** Electron 41.10.7, React 19, Bun 1.4.0, TypeScript 5.9.3, Vite 6, Playwright Core, OpenAI `tunnel-client` pinned by upstream, Rust 2021, Tokio, Axum, Tauri 2 compatibility shell, GitHub Actions, NSIS.

**Spec:** `docs/superpowers/specs/2026-09-14-electron-full-codex-harness-design.md`

## Global Constraints

- Pin `miuuyy/codex-chatgpt-web` to v5.0.6 commit `e85e3693fdb4e3e033348c08df0298c20fcdb612`; every import and packaged runtime must be manifest-verified against that commit.
- Target integrated version `0.6.0-rc.1`; do not call the integration complete until all acceptance gates pass.
- Keep the published Coding Tools v0.4.10 Tauri application buildable and available as a rollback artifact until the replacement gate passes.
- Never use a delete command. Move replaced or generated superseded files into `Trash/<workstream>/<timestamp>/`; put every temporary checkout, archive, build probe, and fixture under `aiTemp/`.
- Do not rewrite or delete historical branches, tags, releases, evidence, or application data.
- Preserve the upstream MIT copyright/license and generate combined Electron/Bun/Rust third-party notices.
- Use a new browser profile; never copy cookies, local storage, or login artifacts from Chrome, Edge, the Tauri WebView, or another application.
- Use explicit connector identities `Coding Tools Native2` and `Coding Tools Native2 DEV`; never silently refresh, rename, delete, or reuse an incompatible connector.
- Use a loopback Rust control service authenticated by an application-owned random token stored in a user-only token file. Pass only the token-file path through an inherited environment variable; never put secret material in arguments, logs, Git, prompts, or build artifacts.
- Renderer code communicates only through a narrow typed preload API. It cannot spawn processes, inspect browser cookies, read arbitrary files, or call Rust directly.
- A turn capability narrows authority and never broadens Rust permissions. Rust workspace policy remains authoritative.
- Missing, null, or zero command timeout continues to mean no automatic process deadline.
- Never automatically replay an unknown browser turn, tool call, process start, input write, provider request, or migration step.
- Computer “Always enabled” remains remembered local approval for one verified target and safety configuration. It never grants model usage, other windows, permanent ChatGPT approval, or invisible background input.
- Browser-only and Zero Risk remain usable without starting the Rust sidecar, tunnel capability broker, or local tools.
- Full mode may consume the signed-in ChatGPT/Codex account’s quota. Native local tools alone must not start a model.
- Paseo and Anneal remain the verified management/observation scope from v0.4.10 unless a separate approved implementation plan extends them.
- Before editing an existing symbol, run the repository’s required `mcp-probe-kit`/GitNexus impact check when available; when unavailable, record source-level callers and affected flows in the task evidence. Run `gitnexus_detect_changes` or the documented CLI fallback before each commit.
- Every task follows RED → GREEN → focused regression → commit. Intermediate work stays on `feature/electron-full-codex-harness-0.6.0`; `main` advances only after the full release gate.

---

## File and Ownership Map

### Pinned upstream and provenance

- `vendor/codex-chatgpt-web-v5.0.6/` — exact upstream source snapshot, unchanged except repository metadata exclusion.
- `vendor/codex-chatgpt-web-v5.0.6/UPSTREAM_MANIFEST.json` — source pin, path/size/SHA-256 inventory, tunnel-client pin, import timestamp.
- `scripts/import-codex-chatgpt-web.mjs` — deterministic import into `aiTemp/`, verification, and retained replacement handling.
- `scripts/verify-vendored-upstream.mjs` — fail-closed manifest verification used locally and in CI.
- `third_party/LICENSES/codex-chatgpt-web-MIT.txt` and `third_party/THIRD_PARTY_NOTICES.md` — attribution.

### Electron product

- `desktop-electron/` — primary product package.
- `desktop-electron/electron/` — main process, preload, supervisors, lifecycle, migration, updater.
- `desktop-electron/src/` — unified React renderer and typed API clients.
- `desktop-electron/tests/` — Node/Electron component and lifecycle tests.
- `runtime-web/` — structurally recognizable adapted upstream Responses/browser/MCP runtime.

### Rust product core

- `rust-core/coding-tools-core/` — reusable application state, data, workspace, policy, tools, runtime, integrations.
- `rust-core/coding-tools-headless/` — private control service and existing MCP/Actions listeners.
- `src-tauri/` — retained compatibility shell depending on `coding-tools-core`.
- `migration/` — migration/rollback journal formats shared by Electron tests and Rust fixtures.

### Release

- `.github/workflows/electron-full-harness-ci.yml` — continuous verification.
- `.github/workflows/electron-full-harness-release.yml` — exact-source Windows release and readback.
- `docs/releases/v0.6.0-rc.1.md` — precise feature and boundary disclosure.

---

### Task 1: Pin and Verify the Upstream Source and Licenses

**Files:**
- Create: `scripts/import-codex-chatgpt-web.mjs`
- Create: `scripts/verify-vendored-upstream.mjs`
- Create: `scripts/lib/upstream-manifest.mjs`
- Create: `tests/upstream-manifest.test.mjs`
- Create: `vendor/codex-chatgpt-web-v5.0.6/UPSTREAM_MANIFEST.json`
- Create: `third_party/LICENSES/codex-chatgpt-web-MIT.txt`
- Create: `third_party/THIRD_PARTY_NOTICES.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces `readManifest(path): Promise<UpstreamManifest>`.
- Produces `verifyTree(root, manifest): Promise<{ files: number; bytes: number }>`.
- Produces a deterministic source inventory consumed by Tasks 2, 16, and 17.

- [ ] **Step 1: Write the failing manifest tests**

```js
// tests/upstream-manifest.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTree } from '../scripts/lib/upstream-manifest.mjs';

test('rejects a changed pinned upstream byte', async () => {
  await assert.rejects(
    verifyTree('aiTemp/fixtures/upstream-mutated', 'aiTemp/fixtures/manifest.json'),
    /UPSTREAM_MANIFEST_MISMATCH/,
  );
});

test('accepts the exact v5.0.6 inventory and MIT notice', async () => {
  const result = await verifyTree(
    'vendor/codex-chatgpt-web-v5.0.6',
    'vendor/codex-chatgpt-web-v5.0.6/UPSTREAM_MANIFEST.json',
  );
  assert.ok(result.files > 100);
  assert.ok(result.bytes > 1_000_000);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test tests/upstream-manifest.test.mjs`

Expected: FAIL because `scripts/lib/upstream-manifest.mjs` and the pinned inventory do not exist.

- [ ] **Step 3: Implement deterministic import and verification**

```js
// scripts/lib/upstream-manifest.mjs
export async function verifyTree(root, manifestPath) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.repository !== 'miuuyy/codex-chatgpt-web'
      || manifest.commit !== 'e85e3693fdb4e3e033348c08df0298c20fcdb612') {
    throw new Error('UPSTREAM_MANIFEST_PIN_MISMATCH');
  }
  const actual = await inventory(root, { exclude: ['.git'] });
  assert.deepStrictEqual(actual, manifest.files, 'UPSTREAM_MANIFEST_MISMATCH');
  return {
    files: actual.length,
    bytes: actual.reduce((sum, item) => sum + item.size, 0),
  };
}
```

The import script must:

1. checkout the exact commit into `aiTemp/vendor-import/<run-id>/source`;
2. verify the commit and MIT license;
3. generate a sorted POSIX-path inventory with SHA-256 and size;
4. move an existing vendor snapshot to `Trash/vendor-import/<timestamp>/` rather than deleting it;
5. copy the verified snapshot into `vendor/codex-chatgpt-web-v5.0.6/`;
6. generate notices and provenance.

- [ ] **Step 4: Import and verify the exact upstream source**

Run:

```bash
node scripts/import-codex-chatgpt-web.mjs \
  --repository miuuyy/codex-chatgpt-web \
  --commit e85e3693fdb4e3e033348c08df0298c20fcdb612
node scripts/verify-vendored-upstream.mjs
node --test tests/upstream-manifest.test.mjs
```

Expected: all checks pass; no delete command appears in the import log.

- [ ] **Step 5: Commit**

```bash
git add scripts tests vendor/codex-chatgpt-web-v5.0.6 third_party .gitignore
git commit -m "build: pin codex-chatgpt-web v5.0.6 source and licenses"
```

---

### Task 2: Establish the Electron/Bun Workspace and Rebrand Without Fork Drift

**Files:**
- Create: `desktop-electron/package.json`
- Create: `desktop-electron/bun.lock`
- Create: `desktop-electron/tsconfig.json`
- Create: `desktop-electron/vite.config.ts`
- Create: `desktop-electron/index.html`
- Create: `desktop-electron/electron/product.cjs`
- Create: `desktop-electron/tests/product-identity.test.cjs`
- Create: `scripts/materialize-electron-base.mjs`
- Create: `runtime-web/package.json`
- Create: `runtime-web/src/`
- Create: `desktop-electron/upstream/`

**Interfaces:**
- Produces `PRODUCT_IDENTITY` with `appId`, `productName`, `protocolVersion`, `connectorName`, and `devConnectorName`.
- Produces `bun run electron:verify` and `bun run electron:dev` from the repository root.

- [ ] **Step 1: Write the failing identity test**

```js
// desktop-electron/tests/product-identity.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { PRODUCT_IDENTITY } = require('../electron/product.cjs');

test('uses Coding Tools identities without impersonating upstream', () => {
  assert.equal(PRODUCT_IDENTITY.appId, 'dev.codingtools.fullharness');
  assert.equal(PRODUCT_IDENTITY.productName, 'Coding Tools');
  assert.equal(PRODUCT_IDENTITY.connectorName, 'Coding Tools Native2');
  assert.equal(PRODUCT_IDENTITY.devConnectorName, 'Coding Tools Native2 DEV');
  assert.notEqual(PRODUCT_IDENTITY.appId, 'dev.codexwebgpt.launcher');
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test desktop-electron/tests/product-identity.test.cjs`

Expected: FAIL because the Electron workspace and product identity do not exist.

- [ ] **Step 3: Materialize the upstream launcher/runtime through adapters**

```js
// desktop-electron/electron/product.cjs
exports.PRODUCT_IDENTITY = Object.freeze({
  appId: 'dev.codingtools.fullharness',
  productName: 'Coding Tools',
  version: '0.6.0-rc.1',
  protocolVersion: 1,
  connectorName: 'Coding Tools Native2',
  devConnectorName: 'Coding Tools Native2 DEV',
  modelNamespace: 'chatgpt-web/',
});
```

`scripts/materialize-electron-base.mjs` must copy from the verified vendor tree into `desktop-electron/upstream/` and `runtime-web/`, preserve upstream file layout, and write a generated mapping manifest. Existing materialized output is moved into `Trash/electron-materialization/<timestamp>/`.

- [ ] **Step 4: Add root scripts and verify the imported baseline builds unchanged**

Run:

```bash
bun install --frozen-lockfile --cwd desktop-electron
bun install --frozen-lockfile --cwd runtime-web
bun run --cwd desktop-electron typecheck
bun run --cwd desktop-electron build:renderer
bun run --cwd runtime-web verify
node --test desktop-electron/tests/product-identity.test.cjs
```

Expected: PASS. The generated mapping records every adapted upstream source path.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron runtime-web scripts/materialize-electron-base.mjs package.json bun.lock
git commit -m "build: establish Coding Tools Electron full-harness workspace"
```

---

### Task 3: Preserve the Upstream Verification and Development Profiles

**Files:**
- Create: `desktop-electron/tests/upstream-parity.test.cjs`
- Create: `desktop-electron/tests/dev-profile-isolation.test.cjs`
- Create: `runtime-web/tests/coding-tools-upstream-smoke.test.ts`
- Create: `.github/workflows/electron-upstream-parity.yml`
- Modify: `desktop-electron/electron/profile.cjs`
- Modify: `desktop-electron/electron/runtime-install.cjs`
- Modify: `runtime-web/src/cli.ts`

**Interfaces:**
- Produces isolated application homes `~/.coding-tools` and `~/.coding-tools-dev`.
- Preserves upstream commands `dev launcher`, `dev chat`, compaction lab, source verification, subagent smoke, and package smoke.

- [ ] **Step 1: Write the failing isolation tests**

```js
test('development profile cannot reuse production browser or tunnel paths', () => {
  const production = resolveProfile('production');
  const development = resolveProfile('development');
  assert.notEqual(production.userData, development.userData);
  assert.notEqual(production.browserPartition, development.browserPartition);
  assert.notEqual(production.tunnelProfile, development.tunnelProfile);
  assert.equal(development.connectorName, 'Coding Tools Native2 DEV');
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test desktop-electron/tests/upstream-parity.test.cjs desktop-electron/tests/dev-profile-isolation.test.cjs`

Expected: FAIL until the imported profile/runtime paths are rehomed under Coding Tools identities.

- [ ] **Step 3: Add compatibility adapters without changing upstream behavior**

Keep upstream browser, daemon, compaction, and tool-projection modules structurally intact. Inject only:

```js
const profile = resolveCodingToolsProfile({ development: argv.includes('--development') });
const connectorIdentity = profile.development
  ? PRODUCT_IDENTITY.devConnectorName
  : PRODUCT_IDENTITY.connectorName;
```

- [ ] **Step 4: Run the complete pinned upstream suite**

Run:

```bash
bun run --cwd runtime-web verify
bun run --cwd runtime-web smoke:subagents
bun run --cwd desktop-electron test
bun run --cwd desktop-electron smoke:package
```

Expected: PASS using isolated fixtures; no production profile is modified.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron runtime-web .github/workflows/electron-upstream-parity.yml
git commit -m "test: preserve full upstream harness and isolated DEV profiles"
```

---

### Task 4: Create a Reusable Rust Core While Keeping Tauri Buildable

**Files:**
- Create: `Cargo.toml`
- Create: `rust-core/coding-tools-core/Cargo.toml`
- Create: `rust-core/coding-tools-core/src/lib.rs`
- Create: `rust-core/coding-tools-core/tests/catalog_compat.rs`
- Create: `rust-core/coding-tools-headless/Cargo.toml`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Move retained originals, when superseded: `Trash/legacy-tauri-core-v0.4.10/`

**Interfaces:**
- Produces `coding_tools_core::CoreState::load() -> AppResult<CoreState>`.
- Produces `CoreState::with_data`, `CoreState::with_runtime`, and the existing tool registry.
- Keeps `coding_tools_mcp_desktop_lib::run()` working through a Tauri adapter.

- [ ] **Step 1: Write failing compatibility tests**

```rust
#[test]
fn extracted_core_preserves_catalog_and_data_fixture() {
    let state = coding_tools_core::CoreState::load_from(test_data_path()).unwrap();
    let catalog = coding_tools_core::tools::registry::list_tools_for_profile("advanced");
    assert_eq!(catalog.len(), 71);
    assert_eq!(catalog_sha256(&catalog), include_str!("fixtures/v0_4_10_catalog.sha256").trim());
    assert_eq!(state.workspace_count().unwrap(), 2);
}
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cargo test -p coding-tools-core extracted_core_preserves_catalog_and_data_fixture`

Expected: FAIL because the workspace and extracted crate do not exist.

- [ ] **Step 3: Introduce the Cargo workspace and move headless-safe modules**

```rust
// rust-core/coding-tools-core/src/lib.rs
pub mod actions;
pub mod auth;
pub mod codex_bridge;
pub mod data;
pub mod error;
pub mod harness;
pub mod health;
pub mod integrations;
pub mod mcp;
pub mod platform;
pub mod runtime;
pub mod secret;
pub mod settings;
pub mod tools;
pub mod tunnel;
pub mod update;
pub mod workspace;

pub struct CoreState {
    pub data: std::sync::Mutex<data::DataStore>,
    pub runtime: std::sync::Mutex<runtime::RuntimeSupervisor>,
}
```

Move modules in dependency order. Keep Tauri-specific window/tray/dialog code in `src-tauri`; move superseded originals into `Trash/legacy-tauri-core-v0.4.10/` only after both crates compile.

- [ ] **Step 4: Make Tauri an adapter and run both products**

Run:

```bash
cargo fmt --all -- --check
cargo test --workspace --all-features
cargo clippy --workspace --all-targets --all-features -- -D warnings
npm run check
npm run build
```

Expected: PASS; the v0.4.10 Tauri UI still starts in a fixture environment.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml rust-core src-tauri Trash/legacy-tauri-core-v0.4.10
git commit -m "refactor: extract reusable Coding Tools Rust core"
```

---

### Task 5: Add the Authenticated Headless Rust Control Service

**Files:**
- Create: `rust-core/coding-tools-headless/src/main.rs`
- Create: `rust-core/coding-tools-headless/src/control/auth.rs`
- Create: `rust-core/coding-tools-headless/src/control/descriptor.rs`
- Create: `rust-core/coding-tools-headless/src/control/routes.rs`
- Create: `rust-core/coding-tools-headless/tests/control_api.rs`
- Create: `rust-core/coding-tools-headless/tests/fixtures/`

**Interfaces:**
- Reads `CODING_TOOLS_CONTROL_TOKEN_FILE`, `CODING_TOOLS_CONTROL_DESCRIPTOR_FILE`, and `CODING_TOOLS_APP_DATA_DIR` from inherited environment variables.
- Writes `ControlDescriptor { protocol_version, pid, port, version, token_sha256, started_at_ms }` atomically.
- Exposes authenticated `/control/v1/health`, `/control/v1/drain`, `/control/v1/resume`, `/control/v1/shutdown`, `/api/v1/state`, `/api/v1/workspaces/*`, `/api/v1/tools/catalog`, `/api/v1/tools/call`, and `/api/v1/operations/:id`.

- [ ] **Step 1: Write the failing child-process control tests**

```rust
#[tokio::test]
async fn rejects_missing_token_and_drains_without_killing_active_work() {
    let child = HeadlessFixture::spawn().await;
    assert_eq!(child.get("/control/v1/health", None).await.status(), 401);
    let health = child.get("/control/v1/health", child.token()).await.json();
    assert_eq!(health["protocol_version"], 1);
    child.start_fixture_command().await;
    let drain = child.post("/control/v1/drain", child.token(), json!({})).await.json();
    assert_eq!(drain["active_commands"], 1);
    assert_eq!(drain["safe_to_shutdown"], false);
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test -p coding-tools-headless control_api -- --nocapture`

Expected: FAIL because the headless binary and API do not exist.

- [ ] **Step 3: Implement token-file authentication and bounded endpoints**

```rust
pub struct ControlAuth {
    token: secrecy::SecretString,
    token_sha256: String,
}

pub fn require_control_auth(headers: &HeaderMap, auth: &ControlAuth) -> Result<(), StatusCode> {
    let supplied = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    subtle::ConstantTimeEq::ct_eq(supplied.as_bytes(), auth.token.expose_secret().as_bytes())
        .then_some(())
        .ok_or(StatusCode::UNAUTHORIZED)
}
```

Bind to `127.0.0.1:0`, enforce request/response byte limits, separate lifecycle and tool routers, and never log authorization headers or token-file contents.

- [ ] **Step 4: Verify real child lifecycle and existing MCP listeners**

Run:

```bash
cargo test -p coding-tools-headless --all-features -- --nocapture
cargo test -p coding-tools-core --all-features
```

Expected: PASS. Existing MCP/Actions listeners still use their own workspace auth and ports.

- [ ] **Step 5: Commit**

```bash
git add rust-core/coding-tools-headless rust-core/coding-tools-core
git commit -m "feat: add authenticated headless Coding Tools service"
```

---

### Task 6: Supervise the Rust Sidecar from Electron

**Files:**
- Create: `desktop-electron/electron/rust-core-supervisor.cjs`
- Create: `desktop-electron/electron/rust-core-client.cjs`
- Create: `desktop-electron/electron/rust-core-state.cjs`
- Create: `desktop-electron/tests/rust-core-supervisor.test.cjs`
- Modify: `desktop-electron/electron/main.cjs`
- Modify: `desktop-electron/electron/runtime-supervisor.cjs`

**Interfaces:**
- Produces `RustCoreSupervisor.start()`, `.health()`, `.drain()`, `.resume()`, `.shutdown()`, and `.status()`.
- Produces `RustCoreClient.request(method, path, body, { timeoutMs, maxBytes })`.
- Emits state transitions `stopped → starting → running → draining → stopping/error`.

- [ ] **Step 1: Write failing supervisor tests**

```js
test('does not restart a sidecar with unresolved active work', async () => {
  const fixture = new FakeRustCore({ activeCommands: 1, exitAfterHealth: true });
  const supervisor = createSupervisor({ fixture, crashBudget: 3 });
  await supervisor.start();
  await fixture.exitUnexpectedly();
  assert.equal(supervisor.status().state, 'blocked');
  assert.match(supervisor.status().reason, /unresolved active work/i);
  assert.equal(fixture.spawnCount, 1);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test desktop-electron/tests/rust-core-supervisor.test.cjs`

Expected: FAIL because no Rust sidecar supervisor exists.

- [ ] **Step 3: Implement owned-process startup, health, drain, and crash budget**

```js
const child = spawn(rustCoreBinary, ['serve'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...sanitizedEnvironment(),
    CODING_TOOLS_CONTROL_TOKEN_FILE: tokenFile,
    CODING_TOOLS_CONTROL_DESCRIPTOR_FILE: descriptorFile,
    CODING_TOOLS_APP_DATA_DIR: appDataDir,
  },
  windowsHide: true,
});
```

The supervisor must use a Windows Job Object/process group helper, verify the packaged binary manifest before launch, and retain unknown-operation evidence instead of immediately restarting.

- [ ] **Step 4: Run supervisor and package-fixture checks**

Run:

```bash
node --test desktop-electron/tests/rust-core-supervisor.test.cjs
bun run --cwd desktop-electron test
```

Expected: PASS; no token appears in process arguments, logs, or fixture snapshots.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron/electron desktop-electron/tests
git commit -m "feat: supervise the headless Rust core from Electron"
```

---

### Task 7: Implement Migration, Backup, and Rollback Journals

**Files:**
- Create: `migration/schema.ts`
- Create: `migration/journal.ts`
- Create: `desktop-electron/electron/migration-manager.cjs`
- Create: `desktop-electron/electron/rollback-manager.cjs`
- Create: `desktop-electron/tests/migration.test.cjs`
- Create: `rust-core/coding-tools-core/tests/migration_compat.rs`

**Interfaces:**
- Produces `MigrationJournalV1` with source/destination paths, source version, target version, hashes, stages, and completion state.
- Produces `migrateV0410Data()` and `rollbackToTauri()`.

- [ ] **Step 1: Write failing migration/rollback tests**

```js
test('retains the v0.4.10 source and refuses partial migration', async () => {
  const result = await migrateFixture('fixtures/v0.4.10-data', 'aiTemp/migrated');
  assert.ok(result.backupPath.includes('Trash/migration-backups/'));
  assert.equal(await exists(result.sourcePath), true);
  await corrupt(result.journalPath, 'destination_hash');
  await assert.rejects(resumeMigration(result.journalPath), /MIGRATION_JOURNAL_MISMATCH/);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test desktop-electron/tests/migration.test.cjs`

Expected: FAIL because migration journaling does not exist.

- [ ] **Step 3: Implement atomic migration and rollback**

```ts
export interface MigrationJournalV1 {
  schema: 1;
  sourcePath: string;
  destinationPath: string;
  backupPath: string;
  sourceVersion: '0.4.10';
  targetVersion: '0.6.0-rc.1';
  sourceSha256: string;
  destinationSha256: string | null;
  stage: 'backed_up' | 'migrated' | 'verified' | 'committed' | 'failed';
}
```

Migration calls the Rust DataStore migrator, writes through an atomic temporary file under `aiTemp/`, and changes no Codex route until `stage === 'committed'`.

- [ ] **Step 4: Verify Rust and Electron compatibility fixtures**

Run:

```bash
node --test desktop-electron/tests/migration.test.cjs
cargo test -p coding-tools-core migration_compat
```

Expected: PASS, including rollback to the retained Tauri executable and pre-migration data.

- [ ] **Step 5: Commit**

```bash
git add migration desktop-electron/electron/migration-manager.cjs desktop-electron/electron/rollback-manager.cjs desktop-electron/tests/migration.test.cjs rust-core
git commit -m "feat: add retained data migration and Tauri rollback"
```

---

### Task 8: Add a Narrow Typed Renderer IPC Boundary

**Files:**
- Create: `desktop-electron/src/api/contracts.ts`
- Create: `desktop-electron/src/api/client.ts`
- Create: `desktop-electron/electron/ipc-schema.cjs`
- Modify: `desktop-electron/electron/preload.cjs`
- Modify: `desktop-electron/electron/main.cjs`
- Create: `desktop-electron/tests/preload-boundary.test.cjs`

**Interfaces:**
- Exposes `window.codingTools.runtime`, `.workspaces`, `.permissions`, `.computer`, `.tasks`, `.history`, `.nativeCodex`, `.integrations`, `.updates`, and `.diagnostics`.
- Every method has Zod/JSON-schema validation and a maximum request/response size.

- [ ] **Step 1: Write failing preload-boundary tests**

```js
test('renderer receives no generic invoke, filesystem, process, or cookie API', () => {
  const exposed = loadPreloadContract();
  assert.equal(exposed.invoke, undefined);
  assert.equal(exposed.spawn, undefined);
  assert.equal(exposed.readFile, undefined);
  assert.equal(exposed.cookies, undefined);
  assert.equal(typeof exposed.workspaces.list, 'function');
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test desktop-electron/tests/preload-boundary.test.cjs`

Expected: FAIL because the imported upstream preload does not expose Coding Tools APIs.

- [ ] **Step 3: Implement exact IPC contracts**

```ts
export const WorkspaceSummarySchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(240),
  path: z.string().min(1).max(4096),
  mcpState: z.enum(['stopped', 'starting', 'running', 'stopping', 'error']),
  policyRevision: z.number().int().nonnegative(),
});
```

The main process validates renderer input, calls `RustCoreClient`, validates output, and strips secrets before returning.

- [ ] **Step 4: Run contract and renderer type checks**

Run:

```bash
node --test desktop-electron/tests/preload-boundary.test.cjs
bun run --cwd desktop-electron typecheck
bun run --cwd desktop-electron build:renderer
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron/src/api desktop-electron/electron desktop-electron/tests/preload-boundary.test.cjs
git commit -m "feat: add typed Electron-to-Rust IPC boundary"
```

---

### Task 9: Build the Unified Electron Shell and Navigation

**Files:**
- Create: `desktop-electron/src/app/App.tsx`
- Create: `desktop-electron/src/app/routes.tsx`
- Create: `desktop-electron/src/app/AppShell.tsx`
- Create: `desktop-electron/src/app/state.ts`
- Create: `desktop-electron/src/i18n/en.ts`
- Create: `desktop-electron/src/i18n/zh-Hant.ts`
- Create: `desktop-electron/src/pages/OverviewPage.tsx`
- Create: `desktop-electron/src/pages/ChatGptWebPage.tsx`
- Create: `desktop-electron/src/pages/ModelsRoutePage.tsx`
- Create: `desktop-electron/src/pages/HarnessTunnelPage.tsx`
- Create: `desktop-electron/tests/navigation.test.tsx`

**Interfaces:**
- Produces the twelve top-level product routes defined in the specification.
- Uses only `window.codingTools` typed APIs.

- [ ] **Step 1: Write failing navigation/i18n tests**

```tsx
it('renders every required route in English and Traditional Chinese', async () => {
  render(<App fixture="healthy" />);
  for (const name of ['Overview', 'ChatGPT Web', 'Models & Codex Route', 'Harness & Tunnel', 'Workspaces', 'Permissions', 'Computer Control', 'Tasks & History', 'Native Codex Sessions', 'Paseo / Anneal', 'Activity & Doctor', 'Updates & Recovery']) {
    expect(screen.getByRole('link', { name })).toBeVisible();
  }
  await user.click(screen.getByRole('button', { name: '繁體中文' }));
  expect(screen.getByRole('link', { name: '電腦操作' })).toBeVisible();
});
```

- [ ] **Step 2: Run and verify RED**

Run: `bun test --cwd desktop-electron tests/navigation.test.tsx`

Expected: FAIL because the Coding Tools shell does not exist.

- [ ] **Step 3: Implement the shell while retaining upstream account/setup surfaces**

Split the upstream monolithic `App.tsx` into focused pages. Do not remove upstream setup, Activity, Doctor, model, MCP, or Settings behavior; mount them through adapters under the Coding Tools route tree.

- [ ] **Step 4: Run renderer checks**

Run:

```bash
bun run --cwd desktop-electron typecheck
bun run --cwd desktop-electron build:renderer
bun test --cwd desktop-electron tests/navigation.test.tsx
```

Expected: PASS in desktop and narrow viewports.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron/src desktop-electron/tests/navigation.test.tsx
git commit -m "feat: add unified Coding Tools Electron shell"
```

---

### Task 10: Port Workspaces, Connections, and Live Permissions

**Files:**
- Create: `desktop-electron/src/pages/WorkspacesPage.tsx`
- Create: `desktop-electron/src/pages/WorkspaceDetailPage.tsx`
- Create: `desktop-electron/src/pages/PermissionsPage.tsx`
- Create: `desktop-electron/src/components/workspaces/LinkedRoots.tsx`
- Create: `desktop-electron/src/components/permissions/PolicyEditor.tsx`
- Create: `desktop-electron/tests/workspaces-permissions.test.tsx`
- Create: `rust-core/coding-tools-headless/tests/live_permission_api.rs`

**Interfaces:**
- Calls sidecar APIs for workspace CRUD, linked roots, runtime start/stop/status, tunnel status, secrets, logs, health, and live policy changes.
- Preserves policy revision and `LIVE_POLICY_BUSY` behavior.

- [ ] **Step 1: Write failing GUI and Rust API tests**

```tsx
it('applies a permission revision without restarting browser, tunnel, or listener', async () => {
  render(<PermissionsPage fixture="running-workspace" />);
  await user.selectOptions(screen.getByLabelText('Permission mode'), 'read-only');
  await user.click(screen.getByRole('button', { name: 'Save policy' }));
  expect(fakeRust.calls.updatePolicy).toHaveLength(1);
  expect(fakeSupervisor.calls.restart).toHaveLength(0);
  expect(screen.getByText(/Applied live.*revision 8/)).toBeVisible();
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
bun test --cwd desktop-electron tests/workspaces-permissions.test.tsx
cargo test -p coding-tools-headless live_permission_api
```

Expected: FAIL because the pages and private API projections do not exist.

- [ ] **Step 3: Implement the pages and DTO projections**

Expose secrets only through dedicated set/regenerate operations; never return stored secret values to ordinary renderer reads. Preserve exact tool-catalogue hash and hidden-tool evidence.

- [ ] **Step 4: Run compatibility checks**

Run:

```bash
bun test --cwd desktop-electron tests/workspaces-permissions.test.tsx
cargo test -p coding-tools-headless live_permission_api
cargo test -p coding-tools-core tools::live_policy
```

Expected: PASS; the active browser login and Codex route remain untouched.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron/src/pages desktop-electron/src/components/workspaces desktop-electron/src/components/permissions desktop-electron/tests rust-core
git commit -m "feat: port workspaces and live permissions to Electron"
```

---

### Task 11: Port Computer Control and Vision with Remembered Approval

**Files:**
- Create: `desktop-electron/src/pages/ComputerControlPage.tsx`
- Create: `desktop-electron/src/components/computer/TargetPicker.tsx`
- Create: `desktop-electron/src/components/computer/LiveMonitor.tsx`
- Create: `desktop-electron/src/components/computer/RememberedApproval.tsx`
- Create: `desktop-electron/tests/computer-control.test.tsx`
- Create: `rust-core/coding-tools-headless/tests/computer_control_api.rs`

**Interfaces:**
- Preserves target listing, permissions, start/poll/preview/pause/resume/stop/forget.
- Renderer never receives raw screenshot pixels except the explicitly requested in-memory preview result.

- [ ] **Step 1: Write failing remembered-approval tests**

```tsx
it('restores only the exact approved target and keeps Stop authoritative', async () => {
  render(<ComputerControlPage fixture="remembered-target" />);
  expect(screen.getByText('Approved executable: fixture-app.exe')).toBeVisible();
  expect(fakeComputer.start).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Restore approved target' }));
  expect(fakeComputer.start).toHaveBeenCalledWith(expect.objectContaining({ executableSha256: 'fixture-sha' }));
  await user.click(screen.getByRole('button', { name: 'Stop' }));
  expect(fakeComputer.stop).toHaveBeenCalledTimes(1);
  expect(fakeModel.start).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
bun test --cwd desktop-electron tests/computer-control.test.tsx
cargo test -p coding-tools-headless computer_control_api
```

Expected: FAIL.

- [ ] **Step 3: Implement typed computer controls and demand-driven previews**

Use a visible monitor state machine. Preview polling stops when hidden, paused, stopped, minimized, or another input is pending. `Ctrl+Alt+Esc`/Stop revocation remains local and does not depend on the renderer.

- [ ] **Step 4: Run Windows background-observation/input fixtures**

Run:

```bash
cargo test -p coding-tools-core computer_ -- --test-threads=1
bun test --cwd desktop-electron tests/computer-control.test.tsx
```

Expected: PASS; unsupported background input is disclosed rather than claimed.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron/src/pages/ComputerControlPage.tsx desktop-electron/src/components/computer desktop-electron/tests/computer-control.test.tsx rust-core
git commit -m "feat: port remembered computer control to Electron"
```

---

### Task 12: Port Tasks, Long-running Commands, History, Native Codex, and Integrations

**Files:**
- Create: `desktop-electron/src/pages/TasksHistoryPage.tsx`
- Create: `desktop-electron/src/pages/NativeCodexPage.tsx`
- Create: `desktop-electron/src/pages/IntegrationsPage.tsx`
- Create: `desktop-electron/src/components/tasks/CommandHandle.tsx`
- Create: `desktop-electron/src/components/tasks/HistorySession.tsx`
- Create: `desktop-electron/tests/tasks-history.test.tsx`
- Create: `desktop-electron/tests/native-integrations.test.tsx`
- Create: `rust-core/coding-tools-headless/tests/task_history_api.rs`

**Interfaces:**
- Preserves command start/read/write/kill handles, output offsets/gaps, finalization, task monitor, history bootstrap/search/read/checkpoint/validate, native Codex status/read/control, and Paseo/Anneal read snapshots.

- [ ] **Step 1: Write failing long-task and history tests**

```tsx
it('polls the same command handle and never treats an RPC return as process completion', async () => {
  render(<TasksHistoryPage fixture="running-command" />);
  expect(screen.getByText('command_ok: unknown')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Read more output' }));
  expect(fakeRust.readOutput).toHaveBeenCalledWith({ commandId: 'cmd-1', offset: 4096 });
  expect(fakeRust.execCommand).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
bun test --cwd desktop-electron tests/tasks-history.test.tsx tests/native-integrations.test.tsx
cargo test -p coding-tools-headless task_history_api
```

Expected: FAIL.

- [ ] **Step 3: Implement bounded projections**

Do not expose raw native reasoning, secrets, browser state, or unbounded logs. Keep native Codex model-use consent independent and disabled after restart/policy change as documented.

- [ ] **Step 4: Run long-running and integration regressions**

Run:

```bash
cargo test -p coding-tools-core command_ history_session_ codex_bridge_ integration_
bun test --cwd desktop-electron tests/tasks-history.test.tsx tests/native-integrations.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron/src/pages desktop-electron/src/components/tasks desktop-electron/tests rust-core
git commit -m "feat: port tasks history and native integrations to Electron"
```

---

### Task 13: Extend the Turn-scoped Broker to Coding Tools

**Files:**
- Create: `runtime-web/src/adapters/chatgpt-web/coding-tools-capability.ts`
- Create: `runtime-web/src/adapters/chatgpt-web/coding-tools-client.ts`
- Create: `runtime-web/tests/coding-tools-capability.test.ts`
- Modify: `runtime-web/src/adapters/chatgpt-web/mcp-server.ts`
- Modify: `runtime-web/src/bridge.ts`
- Modify: `desktop-electron/electron/runtime-supervisor.cjs`
- Create: `rust-core/coding-tools-headless/tests/turn_session_api.rs`

**Interfaces:**
- Produces `CodingToolsTurnCapability { taskId, turnId, epoch, workspaceId, rootsRevision, policyRevision, catalogSha256, token, expiresAtMs }`.
- Namespaces Rust tools as `coding_tools__<exact-rust-name>` inside the upstream broker while preserving the exact Rust name privately.
- Uses `/api/v1/turn-sessions`, `/api/v1/tools/catalog`, and `/api/v1/tools/call`.

- [ ] **Step 1: Write failing capability tests**

```ts
it('rejects stale policy, wrong task, duplicate conflict, expired epoch, and recursive exec', async () => {
  const capability = fixtureCapability();
  await expect(callCodingTools(capability, { taskId: 'foreign', tool: 'coding_tools__read_file' }))
    .rejects.toThrow('FOREIGN_TASK_CAPABILITY');
  await expect(callCodingTools({ ...capability, policyRevision: 6 }, fixtureCall()))
    .rejects.toThrow('STALE_POLICY_CAPABILITY');
  await expect(callCodingTools(capability, { ...fixtureCall(), tool: 'coding_tools__exec' }))
    .rejects.toThrow('RECURSIVE_GATEWAY_DENIED');
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
bun test --cwd runtime-web tests/coding-tools-capability.test.ts
cargo test -p coding-tools-headless turn_session_api
```

Expected: FAIL because no cross-runtime capability exists.

- [ ] **Step 3: Implement capability issuance and claim**

```ts
export interface CodingToolsTurnCapability {
  taskId: string;
  turnId: string;
  epoch: number;
  workspaceId: string;
  rootsRevision: string;
  policyRevision: number;
  catalogSha256: string;
  token: string;
  expiresAtMs: number;
}
```

The Rust session stores only a token hash and private context. Every claim compares task/turn/epoch/root/policy/catalog and idempotency fingerprint. Terminal or expired capabilities reject all later calls.

- [ ] **Step 4: Run an end-to-end fixture tool round**

Run:

```bash
bun test --cwd runtime-web tests/coding-tools-capability.test.ts tests/chatgpt-web-harness.test.ts
cargo test -p coding-tools-headless turn_session_api
```

Expected: a fake ChatGPT response calls one Codex-native fixture tool and one scoped Rust fixture tool in the same response; a foreign task cannot use either capability.

- [ ] **Step 5: Commit**

```bash
git add runtime-web desktop-electron/electron/runtime-supervisor.cjs rust-core
git commit -m "feat: bind Coding Tools to exact Full Harness turns"
```

---

### Task 14: Preserve Browser-only, Full Harness, and Zero Risk Modes

**Files:**
- Modify: `runtime-web/src/chatgpt-web-models.ts`
- Modify: `runtime-web/src/codex-integration-route.ts`
- Modify: `runtime-web/src/codex-integration-journal.ts`
- Modify: `runtime-web/src/tunnel.ts`
- Modify: `runtime-web/src/adapters/chatgpt-web/mcp-server.ts`
- Modify: `desktop-electron/electron/connector-identity.cjs`
- Create: `runtime-web/tests/coding-tools-modes.test.ts`
- Create: `desktop-electron/tests/route-journal.test.cjs`

**Interfaces:**
- Preserves model namespace `chatgpt-web/*` and account-observed model/effort availability.
- Uses connector identities `Coding Tools Native2` and `Coding Tools Native2 DEV`.
- Preserves exact config journaling and byte-for-byte restoration.

- [ ] **Step 1: Write failing mode and route tests**

```ts
it('browser-only never starts broker, tunnel, or Rust tools', async () => {
  const turn = await runFixtureTurn({ mode: 'browser-only' });
  expect(turn.models).toContain('chatgpt-web/high');
  expect(turn.startedTunnel).toBe(false);
  expect(turn.startedBroker).toBe(false);
  expect(turn.codingToolsCatalog).toEqual([]);
});

it('zero-risk copies but never submits or mutates the ChatGPT DOM', async () => {
  const turn = await runFixtureTurn({ mode: 'zero-risk' });
  expect(turn.clipboardWrites).toHaveLength(1);
  expect(turn.domSubmissions).toBe(0);
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
bun test --cwd runtime-web tests/coding-tools-modes.test.ts
node --test desktop-electron/tests/route-journal.test.cjs
```

Expected: FAIL until Coding Tools identities and Rust-tool mode boundaries are integrated.

- [ ] **Step 3: Implement route, connector, and mode adapters**

Keep Voice/realtime routing pinned to the official endpoint. Full mode starts the official pinned tunnel client; Browser-only and Zero Risk do not grant Coding Tools tools unless their documented connector capability is active.

- [ ] **Step 4: Run mode and route restoration suites**

Run:

```bash
bun test --cwd runtime-web tests/coding-tools-modes.test.ts tests/chatgpt-web-harness.test.ts
node --test desktop-electron/tests/route-journal.test.cjs
bun run --cwd runtime-web smoke:codex
```

Expected: PASS; a conflicting existing route fails closed unless explicit replacement is selected.

- [ ] **Step 5: Commit**

```bash
git add runtime-web desktop-electron/electron desktop-electron/tests
git commit -m "feat: preserve all ChatGPT Web harness modes"
```

---

### Task 15: Preserve Task-bound Browser Tabs, Images, Context, and Compaction

**Files:**
- Modify: `desktop-electron/electron/browser-host.cjs`
- Modify: `desktop-electron/electron/browser-state.cjs`
- Modify: `desktop-electron/electron/retained-turn-release.cjs`
- Modify: `runtime-web/src/bridge.ts`
- Modify: `runtime-web/src/chatgpt-session.ts`
- Create: `runtime-web/tests/coding-tools-context-compaction.test.ts`
- Create: `desktop-electron/tests/task-tab-isolation.test.cjs`

**Interfaces:**
- Keeps at most five task-bound browser surfaces.
- Binds surfaces by task/model/effort/compaction epoch and logical `data-turn-id`.
- Preserves native image references and structured checkpoint handoff.

- [ ] **Step 1: Write failing tab-isolation and compaction tests**

```ts
it('reuses one task surface but isolates a different task and a new compaction epoch', async () => {
  const first = await leaseSurface({ task: 'A', epoch: 0 });
  const second = await leaseSurface({ task: 'A', epoch: 0 });
  const other = await leaseSurface({ task: 'B', epoch: 0 });
  const compacted = await leaseSurface({ task: 'A', epoch: 1 });
  expect(second.id).toBe(first.id);
  expect(other.id).not.toBe(first.id);
  expect(compacted.id).not.toBe(first.id);
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
bun test --cwd runtime-web tests/coding-tools-context-compaction.test.ts
node --test desktop-electron/tests/task-tab-isolation.test.cjs
```

Expected: FAIL until Coding Tools supervisor and capability epoch are part of the lease.

- [ ] **Step 3: Extend lease identity without weakening upstream logical-turn checks**

Use the upstream logical turn identity and add the Coding Tools workspace/capability epoch as private metadata. Never infer a new turn from remounted display indexes or assistant prose.

- [ ] **Step 4: Run context, image, compaction, and five-tab checks**

Run:

```bash
bun test --cwd runtime-web tests/coding-tools-context-compaction.test.ts tests/chatgpt-web-harness.test.ts
node --test desktop-electron/tests/task-tab-isolation.test.cjs
bun run --cwd runtime-web dev:chat -- compaction-lab-fixture
```

Expected: PASS with no live account.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron/electron runtime-web
git commit -m "feat: preserve task-bound ChatGPT sessions and compaction"
```

---

### Task 16: Preserve Subagents, Doctor, Activity, Cancellation, and Drain

**Files:**
- Modify: `runtime-web/src/codex-integration.ts`
- Modify: `runtime-web/src/doctor.ts`
- Modify: `desktop-electron/electron/control-server.cjs`
- Modify: `desktop-electron/electron/runtime-supervisor.cjs`
- Modify: `desktop-electron/electron/turn-suspension.cjs`
- Create: `desktop-electron/src/pages/ActivityDoctorPage.tsx`
- Create: `runtime-web/tests/coding-tools-subagents.test.ts`
- Create: `desktop-electron/tests/drain-cancel.test.cjs`

**Interfaces:**
- Preserves Compatibility V1 and Native selections.
- Exposes separate active HTTP request and active browser/tool counters.
- Drains before stop/update/uninstall and resumes on pre-commit failure.

- [ ] **Step 1: Write failing drain and subagent tests**

```js
test('update is blocked while either browser/tool or Rust work remains active', async () => {
  const lifecycle = fixtureLifecycle({ http: 0, browserTools: 1, rustCommands: 1 });
  const result = await lifecycle.beginUpdate();
  assert.equal(result.allowed, false);
  assert.deepEqual(result.blockers, ['browser_tools', 'rust_commands']);
  assert.equal(lifecycle.killedProcesses.length, 0);
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
bun test --cwd runtime-web tests/coding-tools-subagents.test.ts
node --test desktop-electron/tests/drain-cancel.test.cjs
```

Expected: FAIL until Rust counters and unified drain are integrated.

- [ ] **Step 3: Implement unified lifecycle evidence**

Doctor reports browser authentication, Responses daemon, tunnel binary/key/health, connector identity, Rust binary manifest, Rust control health, workspace runtimes, Codex route journal, and unresolved operations separately.

- [ ] **Step 4: Run subagent and lifecycle suites**

Run:

```bash
bun run --cwd runtime-web smoke:subagents
bun test --cwd runtime-web tests/coding-tools-subagents.test.ts
node --test desktop-electron/tests/drain-cancel.test.cjs
```

Expected: PASS. Nonterminal `wait_agent` polls release the serialized broker channel.

- [ ] **Step 5: Commit**

```bash
git add runtime-web desktop-electron/electron desktop-electron/src/pages/ActivityDoctorPage.tsx desktop-electron/tests
git commit -m "feat: unify subagents diagnostics cancellation and drain"
```

---

### Task 17: Package the Electron App, Rust Core, Bun, Tunnel Client, and Rollback Assets

**Files:**
- Modify: `desktop-electron/package.json`
- Create: `desktop-electron/scripts/prepare-runtime.cjs`
- Create: `desktop-electron/scripts/package.cjs`
- Create: `desktop-electron/scripts/verify-package.cjs`
- Create: `desktop-electron/packaging/runtime-manifest.ts`
- Create: `desktop-electron/packaging/rollback/`
- Create: `desktop-electron/tests/package-contents.test.cjs`
- Create: `docs/releases/v0.6.0-rc.1.md`

**Interfaces:**
- Produces `Coding.Tools_0.6.0-rc.1_windows_x64_setup.exe`.
- Packages exact runtime manifests, Rust core, native helpers, Bun, web runtime, tunnel client, licenses, migration/rollback tools, and the retained Tauri rollback installer/reference.

- [ ] **Step 1: Write failing package-content tests**

```js
test('package contains exact verified runtimes and no credentials', async () => {
  const manifest = await inspectPackage('aiTemp/package-fixture');
  for (const name of ['coding-tools-core.exe', 'bun.exe', 'tunnel-client.exe', 'runtime/manifest.json', 'THIRD_PARTY_NOTICES.md']) {
    assert.ok(manifest.paths.includes(name), name);
  }
  assert.equal(manifest.secretsFound.length, 0);
  assert.equal(manifest.productVersion, '0.6.0-rc.1');
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test desktop-electron/tests/package-contents.test.cjs`

Expected: FAIL because the integrated package does not exist.

- [ ] **Step 3: Implement deterministic packaging and verification**

`prepare-runtime.cjs` must verify every source binary against its manifest before copying. Packaging is per-user, NSIS, no elevation, and uses the new Coding Tools app ID. Existing build output is moved into `Trash/package-output/<timestamp>/`.

- [ ] **Step 4: Build and inspect the Windows package**

Run:

```bash
cargo build --release -p coding-tools-headless --all-features
bun run --cwd runtime-web build
bun run --cwd desktop-electron package:win
node desktop-electron/scripts/verify-package.cjs desktop-electron/release
node --test desktop-electron/tests/package-contents.test.cjs
```

Expected: PASS; SHA-256 manifest and provenance reference the exact source commit.

- [ ] **Step 5: Commit**

```bash
git add desktop-electron runtime-web docs/releases/v0.6.0-rc.1.md
git commit -m "release: package Electron full harness with Rust core"
```

---

### Task 18: Add Full CI, Security, Compatibility, and Release Publication Gates

**Files:**
- Create: `.github/workflows/electron-full-harness-ci.yml`
- Create: `.github/workflows/electron-full-harness-release.yml`
- Create: `scripts/release/verify-source-scope.mjs`
- Create: `scripts/release/verify-assets.mjs`
- Create: `scripts/release/publish-v0.6.0-rc.1.mjs`
- Create: `tests/no-delete-policy.test.mjs`
- Modify: `README.md`
- Modify: `README.en.md`

**Interfaces:**
- CI matrices: Linux source/runtime, Windows full build/installer, macOS compile/package compatibility.
- Publication uses exact tested source, draft release, asset upload, readback, checksum verification, then non-forced tag/release publication.

- [ ] **Step 1: Write failing release-policy tests**

```js
test('release scripts contain no destructive repository or filesystem operation', async () => {
  const source = await readReleaseScripts();
  for (const forbidden of ['git push --force', 'git reset --hard', 'rm -rf', 'Remove-Item -Recurse -Force', 'git tag -d']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/no-delete-policy.test.mjs`

Expected: FAIL until the release workflows/scripts exist.

- [ ] **Step 3: Implement CI and release gates**

Required workflow checks:

```text
source pin + licenses
Bun lock + audit + typecheck + tests
upstream verify + smoke + subagent fixtures
Rust fmt + Clippy -D warnings + full tests + cargo audit
native helper hash/identity
Tauri compatibility build
Electron renderer/build/package tests
Rust child/control/capability integration
route install/remove/restore
Browser-only/Full/Zero Risk fixtures
context/image/compaction fixtures
computer/history/native Codex compatibility
migration/rollback fixtures
NSIS manifest/version/license inspection
Git-history credential scan
asset download/readback SHA-256
```

- [ ] **Step 4: Run the full release workflow from the feature branch**

Run through GitHub Actions. Expected: all automated jobs succeed; live-account acceptance remains explicitly pending/manual and is not replaced by fixture evidence.

- [ ] **Step 5: Publish the prerelease only after all gates**

Publication sequence:

```text
create draft v0.6.0-rc.1 at exact tested SHA
upload installer + SHA256SUMS + provenance + validation evidence
redownload every asset
verify byte-for-byte hashes and installer metadata
create non-forced tag
publish prerelease
leave main unchanged until replacement acceptance is complete
```

- [ ] **Step 6: Commit**

```bash
git add .github/workflows scripts/release tests/no-delete-policy.test.mjs README.md README.en.md
git commit -m "ci: gate the Electron full harness prerelease"
```

---

### Task 19: Execute the Replacement Acceptance Matrix and Advance Main

**Files:**
- Create: `docs/validation/v0.6.0-rc.1-acceptance.md`
- Create: `docs/validation/v0.6.0-rc.1-live-account.md`
- Create: `aiTemp/release-evidence/` during execution only
- Modify: `docs/releases/v0.6.0-rc.1.md`

**Interfaces:**
- Produces a signed-off acceptance record mapping every specification criterion to evidence.
- Produces a rollback rehearsal record and a final `main` fast-forward decision.

- [ ] **Step 1: Build the acceptance checklist from the specification**

```markdown
- [ ] Electron is the primary UI and owns every child lifecycle.
- [ ] Browser-only completes without Rust/tunnel tools.
- [ ] Full completes one Codex-native and one Coding Tools tool in one response.
- [ ] Zero Risk completes manual send/confirm.
- [ ] One compaction epoch and image attachment pass.
- [ ] v0.4.10 migration and rollback pass.
- [ ] Unknown outcomes do not replay after restart.
- [ ] Computer remembered approval restores one target and remains revocable.
- [ ] Downloaded installer and published checksums match.
```

- [ ] **Step 2: Run clean Windows VM install/repair/upgrade/rollback/uninstall tests**

Preserve VM logs and screenshots under `aiTemp/release-evidence/`; copy only sanitized proof into the release evidence artifact. No user browser profile is exported.

- [ ] **Step 3: Run the distinct live-account acceptance**

Verify current account model/effort detection, sign-in, one Browser-only turn, one Full Harness turn, one Zero Risk turn, connector identity, tunnel health, and current ChatGPT UI selectors. Record account-dependent results without publishing cookies, prompts, or sensitive page content.

- [ ] **Step 4: Reconcile failures without replay**

Any unknown tool/model/turn outcome blocks promotion. Inspect retained operation/task/browser evidence; do not rerun under a new ID until the prior outcome is classified.

- [ ] **Step 5: Fast-forward main only after complete acceptance**

```bash
git merge --ff-only feature/electron-full-codex-harness-0.6.0
git push origin main
```

Expected: no force push, no history rewrite, no file deletion, and the prior Tauri release remains downloadable.

- [ ] **Step 6: Commit acceptance records**

```bash
git add docs/validation docs/releases/v0.6.0-rc.1.md
git commit -m "docs: record Electron full harness replacement acceptance"
```

---

## Plan Self-review Record

- **Spec coverage:** Tasks 1–3 cover pinning, licensing, upstream parity, and DEV profiles. Tasks 4–8 cover Rust extraction, authenticated sidecar lifecycle, migration, rollback, and IPC. Tasks 9–12 cover the unified GUI and every published Coding Tools surface. Tasks 13–16 cover turn-scoped tools and every pinned Full Harness mode/lifecycle. Tasks 17–19 cover packaging, CI, security, release, live acceptance, rollback, and main promotion.
- **No placeholders:** The plan contains no `TBD`, deferred implementation placeholder, or generic “add tests” instruction. Each task names files, interfaces, RED/GREEN commands, and a commit.
- **Type consistency:** `CoreState`, `ControlDescriptor`, `RustCoreSupervisor`, `CodingToolsTurnCapability`, connector identities, version `0.6.0-rc.1`, and private API paths are defined once and reused consistently.
- **Chosen IPC:** Loopback HTTP with a random token stored in a user-only token file is selected for the initial cross-platform release. Named pipes/domain sockets remain outside this plan.
- **Execution mode:** Under the user’s standing approval, execute inline in this feature branch, stop only for a genuine external blocker, failed safety gate, unknown side effect, or irreversible action not already covered by the approved specification.
