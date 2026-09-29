# 任务清单：gui-only-one-click-update

## 概述

Implement only the GUI update path and its release artifact. Keep runtime and bridge lifecycle unchanged.

## 交付物清单（Scope-lock）

- Production new files: 3; retained test-only files are under aiTemp/gui-update.
- Modified production files: 3; one existing regression contract updated for the intentional GUI-only behavior.
- Specification files: these 3 documents.
- Deliverables: gui-update.cjs, package-gui-update.cjs, gui-only-update.yml, aiTemp/gui-update/gui-update.test.cjs, update.cjs, main.cjs, App.tsx.
- Scratch/build evidence goes under aiTemp/gui-update.

## 任务列表

### 阶段 1: Verified bundle and controller

- [x] 1.1 Add a bounded GUI bundle controller with rollback and no service hooks.
  - **证据块**: update.cjs:371 beginInstall currently stages a whole-app installer; main.cjs:1799 calls requestQuit after it.
  - **涉及文件**: gui-update.cjs, at most 320 lines; update.cjs, fewer than 15 changed lines.
  - _需求: FR-1, FR-2, FR-3_ | _设计: 技术方案, 数据模型_

### 阶段 2: Window and UI integration

- [x] 2.1 Wire the existing update action to the GUI controller and dynamic renderer path.
  - **证据块**: main.cjs:680 currently loads the packaged dist/index.html; main.cjs:1855 shuts down runtime services in requestQuit.
  - **涉及文件**: main.cjs, fewer than 140 changed lines; existing large file is not restructured.
  - _需求: FR-1, FR-2_ | _设计: Renderer-only activation_

- [x] 2.2 Make settings check/download/apply in one click and describe GUI-only progress.
  - **证据块**: App.tsx:1896 currently calls checkForUpdates only; App.tsx:1957 shows Check now.
  - **涉及文件**: App.tsx, fewer than 45 changed lines; reuse existing UI components.
  - _需求: FR-1_ | _设计: API 设计_

### 阶段 3: Packaging and verification

- [x] 3.1 Package renderer-only releases and gate publication against backend changes.
  - **证据块**: package.json:17 builds renderer with Vite; existing update.cjs:87 requires SHA256SUMS.txt.
  - **涉及文件**: package-gui-update.cjs at most 80 lines; gui-only-update.yml at most 120 lines.
  - _需求: FR-3_ | _设计: Exact compatibility_

- [x] 3.2 Verify all acceptance criteria using focused tests and rendered evidence.
  - **证据块**: update.test.cjs:216 exercises verified updater handoff; baseline TypeScript check passed.
  - **涉及文件**: aiTemp/gui-update/gui-update.test.cjs at most 180 lines; temporary evidence under aiTemp/gui-update.
  - _需求: FR-1, FR-2, FR-3_ | _设计: 测试策略_

## 检查点

- Controller test must fail before implementation and pass after it.
- Installation must contain no quit, installer worker or service lifecycle call.
- Failed install must retain the previous pointer; successful reload must preserve service processes.

## 需求覆盖矩阵

| 需求 ID | 设计章节 | 任务编号 | 状态 |
| --- | --- | --- | --- |
| FR-1 | API 设计 | 1.1, 2.1, 2.2, 3.2 | Verified |
| FR-2 | Renderer-only activation | 1.1, 2.1, 3.2 | Verified |
| FR-3 | Exact compatibility | 1.1, 3.1, 3.2 | Verified |

## 文件变更清单

| 文件 | 操作 | 行数预算 |
| --- | --- | --- |
| desktop-electron/electron/gui-update.cjs | New | 320 |
| desktop-electron/electron/update.cjs | Modify | 15 |
| desktop-electron/electron/main.cjs | Modify | 140 |
| desktop-electron/src/App.tsx | Modify | 45 |
| desktop-electron/scripts/package-gui-update.cjs | New | 80 |
| .github/workflows/gui-only-update.yml | New | 120 |
| aiTemp/gui-update/gui-update.test.cjs | New | 180 |
| desktop-electron/tests/rc11-install-location-beta-update.test.cjs | Modify | 25 |

## 检查清单

- [x] Deliverables, scope and evidence are locked.
- [x] Each task maps to requirements and design.
- [x] Implementation, focused verification and review are complete.
