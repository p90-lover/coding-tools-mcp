# Design: Complete Register and CPA Integration

## 概述

Cover FR-1, FR-2, FR-3 and NFR-1 through NFR-3 with the current Electron host, isolated native content view, packaged Python application and native CPA plugin. A source snapshot is executable application code, never a copy of local account state.

## 技术方案

### 技术选型

| Area | Choice | Reason | Requirement |
|---|---|---|---|
| Runtime | Relocatable Python executable with current Register source and rebuilt static UI | No checkout, system Python or virtual environment on user's machine | FR-1 |
| View | Existing sandboxed WebContentsView without launcher preload | Preserve real UI and same-site authentication | FR-1, NFR-2 |
| Handler | Scoped loopback HTTP server and private descriptor | CPA integration without browser-control privileges | FR-2 |
| Plugin | Existing native CPA ABI and host.auth.save | Real installed plugin with immediate credential registration | FR-3 |

### 架构设计

RegisterSurface opens the managed RegisterHost. The host launches register-service from resources/register-runtime, or root aiTemp/register-runtime in development. The child receives a private service password and application-owned database/data paths before importing upstream modules. The native session injects authorization only for this service origin.

The private Register API descriptor lives beside application runtime state and contains schema_version, fixed loopback URL, rotating bearer token and stable source_id. CPA receives only that descriptor path through its managed plugin configuration. It cannot use the launcher browser-control token.

The runtime includes freshly provisioned, pinned Camoufox and Chromium engines with managed cache/executable paths. Packaging does not copy the developer's virtual environment or browser profiles, and no browser setup is required to open the registration workspace.

## 数据模型

| Entity | Fields | Constraints |
|---|---|---|
| Descriptor | schema_version, url, token, source_id | private atomic file, loopback URL, bounded size |
| Account summary | id, email, eligible, disabled, revision | positive ID, no OAuth material |
| Export | account_id, name, revision, json | only explicit selected IDs; revision excludes volatile export timestamps |
| Plugin state | automation switches, interval, account selection, imported revisions | automation off until enabled; successful imports only; private storage |

## API 设计

| Method | Route | Contract | Requirement |
|---|---|---|---|
| GET | /v1/status | ready, owned, starting, sanitized error, source_id | FR-2 |
| POST | /v1/start | start only the managed Register service | FR-1, FR-2 |
| GET | /v1/accounts | source_id and sanitized account summaries | FR-2 |
| POST | /v1/export | explicit IDs to selected CPA OAuth objects and stable revisions | FR-2, FR-3 |
| POST | /v1/refresh | explicit IDs to sanitized noninteractive renewal results | FR-2, FR-3 |

The Python adapter exposes protected /api/coding-tools/accounts, /export and /refresh routes. Empty ID lists never mean all accounts. Unknown methods/paths, browser origins, oversized requests and redirects are rejected. Status and reads do not implicitly start account operations.

## 文件结构

- desktop-electron/vendor/register/: source snapshot, provenance, Python entry and narrow adapters.
- desktop-electron/scripts/prepare-register-runtime.cjs: reproducible runtime preparation.
- desktop-electron/electron/register-host.cjs and register-api.cjs: managed lifecycle and restricted handler.
- desktop-electron/vendor/cpa-plugins/register_plugins/: native ABI plugin, console and tests.
- desktop-electron/vendor/bundled/cpa-plugins/: generated plugin asset and digest manifest.
- desktop-electron/electron/main.cjs, cpa-managed.cjs and RegisterSurface.tsx: launcher, plugin and UI wiring.
- desktop-electron/package.json and package verification: executable, source/license and plugin contents.

## 设计决策

### Managed executable replaces path selection (FR-1)

An external-checkout fallback would keep the reported bug. Package the source and interpreter instead. Preserve user data by creating application-owned storage and leaving the original project untouched.

### Explicit account scope and noninteractive renewal (FR-2)

Reuse existing export and token-renewal functions rather than the manual refresh action, which may log in interactively. Report login-required status without bypassing account verification restrictions.

### Idempotent CPA imports and opt-in timers (FR-3)

Prefix auth names by stable source/account identity and keep ownership markers. Skip unchanged source revisions even when CPA refreshed its copy, preserve disabled flags, refuse foreign records and cancel overlapping or shutting-down work.

## 测试策略

Use isolated databases and fixture credentials. Prove the old path requirement fails the new regression, build the executable and open real UI away from the original checkout, exercise authenticated exports and renewal against mocks, load the actual plugin in an isolated pinned CPA process, and verify package contents plus shutdown/retry behavior. Never use a production account or start the user's app.

## 风险评估

| Risk | Impact | Mitigation |
|---|---|---|
| Missing dependencies or hidden imports | Runtime fails after packaging | Relocated executable startup and API/UI smoke |
| Source-root writes or private files copied | Data loss or credential disclosure | Explicit source allowlist, private-file scan and writable data override |
| Token exposure or account rollback | Credential compromise or unusable accounts | Separate tokens, strict routes, stable revision/ownership checks and fixture tests |
| Shared shutdown regression | Orphan service or disabled UI | Preserve existing generation and cancelled-quit tests |

## 检查清单

- [x] Every FR has a design, typed interface, failure behavior and verification strategy.
