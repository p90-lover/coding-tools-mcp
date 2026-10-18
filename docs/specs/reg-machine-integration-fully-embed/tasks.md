# 任务清单：reg-machine-integration-fully-embed

## 概述
Implement the complete original reg-machine application inside Coding Tools without copying private state.

## 交付物清单（Scope-lock）
- New files: 312 immutable source files plus provenance, adapter, lifecycle, UI, build and regression files; 339 scoped changed files total.
- Modified files: app-handler registry, host, desktop main, App, package configuration and package scripts.
- New functions: approximately 15 lifecycle, catalog, packaging and UI functions.
- Deliverables: source provenance manifest/license, full backend and frontend, app handler/catalog, managed lifecycle, Runtime Register surface, frozen packaging and focused tests.

## 任务列表
### 阶段 1: 准备工作
- [x] 1.1 Inventory allowlisted local source and freeze SHA256 provenance with no private data.
  - Evidence: source main.py imports api/authenticator.py and starts scheduler/task runtime; local source must be retained beyond upstream HEAD.
  - Files: app-handler/reg-machine/source and provenance manifest; existing source files retained in their existing package modules, no artificial merged files.
  - _需求: FR-1_ | _设计: Source provenance_

### 阶段 2: 核心实现
- [x] 2.1 Add owned backend lifecycle and known-route API handler preserving authorization.
  - Evidence: app-handler/antigravity-cli/handler.cjs:31 uses context.services.antigravityCli; app-handler/host.cjs:134 sanitizes module results.
  - Files: reg-machine-managed.cjs under 400 lines; handler.cjs under 180 lines; module.json; registry and host additions under 5 lines each; main service injection under 30 lines.
  - _需求: FR-2_ | _设计: API design_
- [x] 2.2 Host complete original SPA under Runtime Register and package frozen backend/browser dependencies.
  - Evidence: desktop-electron/src/features/OriginalUiSurface.tsx:275 embeds original module visuals; source main.py mounts static assets and SPA fallback.
  - Files: RegisterSurface.tsx under 150 lines; App sidebar and view additions under 20 lines; build-reg-machine.cjs under 200 lines; package/workflow wiring under 40 lines.
  - _需求: FR-1, FR-3_ | _设计: Technical architecture_

### 阶段 3: 集成测试
- [x] 3.1 Verify isolated APIs, lifecycle cleanup, complete original UI and packaged artifacts against acceptance criteria.
  - Evidence: desktop-electron/package.json:25 runs Node tests; source API health routes and frontend build provide actual local contracts.
  - Files: tests/reg-machine-managed.test.cjs with six focused regression cases and task-owned disposable fixtures under aiTemp.
  - _需求: FR-1, FR-2, FR-3_ | _设计: Testing strategy_

## 检查点
- [x] Source hash/prohibited-path inventory verified.
- [x] Handler, lifecycle, UI and packaging wired.
- [x] Focused tests and real frozen runtime smoke passed.

## 需求覆盖矩阵
| Requirement | Design | Tasks | State |
|---|---|---|---|
| FR-1 | Original UI and provenance | 1.1, 2.2, 3.1 | Passed |
| FR-2 | Owned lifecycle and API | 2.1, 3.1 | Passed |
| FR-3 | Frozen packaging | 2.2, 3.1 | Passed |

## 文件变更清单
| File | Action | Budget | Purpose |
|---|---|---|---|
| app-handler/reg-machine/source | Add | Original modules | Full preserved application |
| app-handler/reg-machine/handler.cjs | Add | 180 | Known APIs and metadata |
| desktop-electron/electron/reg-machine-managed.cjs | Add | 400 | Owned backend |
| desktop-electron/src/features/RegisterSurface.tsx | Add | 150 | Full original UI |
| desktop-electron/scripts/build-reg-machine.cjs | Add | 200 | Release resources |
| desktop-electron/tests/reg-machine-managed.test.cjs | Add | Six cases | Contract regression |
| Existing registry/main/App/package/workflow | Modify | 100 total | Host wiring |

## 检查清单
- [x] Tasks link to all FR.
- [x] Read-before-write evidence recorded.
- [x] Delivery inventory reconciled after implementation.

## Final verification evidence
- 312 staged Git blobs match the original SHA256 manifest (3,225,405 bytes); scoped attributes prevent text normalization.
- 17/17 focused Node tests pass; desktop TypeScript check passes.
- Final PyInstaller backend and Playwright, Patchright and Camoufox pass offline browser smoke checks.
- Hidden Electron loads eight distinct original SPA sections, direct /tasks reload, 11 platforms, isolated account CRUD/binary export and explicit portal authentication.
- Independent review verified owned-only solver shutdown, serialized lifecycle and portal RBAC/session refresh. No live provider registration, SMS, purchases or existing-account mutation performed.
- GitNexus detects 15 existing symbols and 22 flows, critical shared-contract risk; changes there are additive module IDs/service wiring. New source is outside the base graph and verified through focused runtime tests.
