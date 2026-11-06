# Tasks: Complete Register and CPA Integration

## 概述

Implement FR-1 through FR-3 in the isolated codex/register-cpa-integration checkout. Required outputs are complete runtime packaging, native handler, plugin, UI and offline installed-path evidence.

## 交付物清单（Scope-lock）

- New files: one explicitly inventoried Register source snapshot, Python entry/adapters/tests, runtime preparation script/test, native API/test, native plugin source/tests/console and generated asset, and these three specs.
- Modified files: Register host/tests, launcher wiring/types/preload as needed, RegisterSurface, CPA managed config/tests, package manifest/verifier/tests and required build workflow hooks.
- Functions: change only existing Register launch/resolution, initialization/teardown and CPA plugin registration; new functions serve those contracts.
- Snapshot file count and artifact hashes must be recorded by the packaging manifest before completion; no private files or separately unlicensed nested project.

## 任务列表

### 阶段 1: Prepare source and managed executable (FR-1)

- [ ] 1.1 Package the current Register application and its Python dependencies without an external checkout.
  - **证据块**: register-host.cjs:212 validates projectRoot; line 221 resolves `.venv/Scripts/python.exe`; line 270 uses the external project as cwd.
  - Files: vendor/register source inventory; prepare-register-runtime.cjs under 400 lines; Python entry/adapters split by runtime and account bridge, each under 500 lines.
  - Requirement: FR-1; design: Managed executable replaces path selection.
- [ ] 1.2 Redirect all bundled runtime writes to application-owned data before upstream imports and preserve source/license.
  - **证据块**: upstream core/db.py derives a source-local DB without ACCOUNT_MANAGER_DATABASE_URL; core/base_sms.py and local_ms_mailbox.py derive source-root data.
  - Files: vendor/register entry/source data overrides and runtime tests; no original reg-machine edits.
  - Requirement: FR-1, NFR-2, NFR-3; design: Architecture and file structure.

### 阶段 2: Connect the handler and native CPA plugin

- [ ] 2.1 Replace external path launch with managed lifecycle and authenticated local APIs.
  - **证据块**: main.cjs:327 creates getRegisterHost; register-host.cjs exposes status/start/stop/quit recovery. Keep those lifecycle invariants.
  - Files: register-host.cjs existing 408 lines, separate register-api.cjs under 400 lines, focused host/API tests and main wiring.
  - Requirement: FR-1, FR-2; design: API and explicit account scope.
- [ ] 2.2 Implement register_plugins console, authenticated management APIs, idempotent OAuth imports and bounded optional refresh jobs.
  - **证据块**: cpa-managed.cjs:134 registers COMMANDCODE_PLUGINS; cline-pass-switcher provides ABI 1/schema 6; CPA host.auth.save imports auth files but no host.auth.refresh exists.
  - Files: split ABI, plugin jobs and console by responsibility; Go source modules under 500 lines each, generated native asset and digest manifest, managed config and tests.
  - Requirement: FR-3; design: Idempotent imports and opt-in timers.
- [ ] 2.3 Open the managed Register UI without a Choose project step and include every required asset in package preparation.
  - **证据块**: RegisterSurface.tsx currently renders Choose project and an external-project empty-state hint; package.json already includes bundled CPA plugin assets.
  - Files: RegisterSurface.tsx, package scripts/extraResources, package verifier/test fixture and integration tests.
  - Requirement: FR-1, FR-3; design: Managed executable and file structure.

### 阶段 3: Verify and publish scoped GitHub changes

- [ ] 3.1 Verify relocated executable/UI, explicit-ID OAuth export, mock noninteractive renewal, actual native CPA import and repeated-sync behavior.
  - **证据块**: existing native/register.cjs and host/renderer tests; new tests must fail on the old external-path behavior and empty/unauthorized account calls.
  - Files: existing native test, scoped host/API/Go/package tests; artifacts only aiTemp/register-cpa-20261023.
  - Requirement: FR-1, FR-2, FR-3; design: Test strategy.
- [ ] 3.2 Review auth, lifecycle, package contents and account ownership; run graph change analysis, commit only scoped files, push and create GitHub PR.
  - **证据块**: clean baseline 819f63d and preserved original G checkout with 138 changes; no production service or account changes.
  - Files: source/tests/specs and required generated assets only; no credentials, test databases, reports or caches committed.
  - Requirement: FR-1 through FR-3; design: Risks and verification.

## 检查点

- [ ] Source inventory excludes private data and installed runtime is relocatable.
- [ ] Bridge rejects unauthorized/empty/oversized calls and refresh never opens login.
- [ ] Native CPA plugin imports fixtures idempotently and preserves disabled/unrelated accounts.
- [ ] Runtime/UI/package checks and independent review are complete before GitHub publication.

## 需求覆盖矩阵

| Requirement | Design | Tasks | Status |
|---|---|---|---|
| FR-1 | Managed executable, architecture | 1.1, 1.2, 2.1, 2.3, 3.1 | Pending |
| FR-2 | Restricted API, explicit account scope | 2.1, 3.1, 3.2 | Pending |
| FR-3 | Idempotent imports, opt-in timers | 2.2, 2.3, 3.1, 3.2 | Pending |

## 文件变更清单

The implementation groups above are the bounded file inventory; the source snapshot manifest enumerates vendored files, and the final Git diff enumerates exact changed integration paths. Larger existing main/CPA files receive narrow wiring edits rather than refactoring.

## 检查清单

- [x] Tasks include evidence, file responsibilities, requirements and acceptance checks.
- [ ] Final manifest, tests, package artifacts and GitHub PR are verified.
