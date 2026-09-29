# 设计文档：gui-only-one-click-update

## 概述

Keep the existing settings row and sidebar action. Replace their full-installer behavior with a compatible GUI controller. The old full updater remains available in its module for a later whole-app update.

**对应需求:** FR-1, FR-2, FR-3, NFR-1, NFR-2, NFR-3, NFR-4.

## 技术方案

### 技术选型

| 类别 | 选择 | 理由 | 关联需求 |
| --- | --- | --- | --- |
| Bundle | gzip JSON with base64 file contents | Node zlib and JSON need no archive dependency | FR-3 |
| Trust | Existing release URL validation and SHA-256 helpers | Preserve the project's update trust boundary | FR-3 |
| Activation | Versioned userData GUI directory and atomic pointer | Retain previous GUI and commit only after reload succeeds | FR-2 |
| UI | Existing SettingRow, SidebarItem and buttons | Keep the established utility surface | FR-1 |

### 架构设计

Update GUI -> GUI release check -> checksum and compatibility verification -> stage renderer assets -> load renderer in the existing window -> commit current pointer.

No service references or shutdown hooks are passed to the GUI controller. Startup loads the saved compatible bundle, with the packaged renderer as fallback.

## 数据模型

| Entity | Fields | Constraints |
| --- | --- | --- |
| Bundle | schema, shellVersion, shellHash, revision, files | schema 1, exact version/hash, positive revision, bounded safe renderer paths |
| Current pointer | directory, revision | generated bundle directory only, positive revision |
| Release | v<SHELL>-gui.r<REVISION> | non-draft, exact bundle asset and checksum file |

shellHash covers the Electron main, source preload, IPC schema and GUI updater files. Publication also compares backend directories with the corresponding shell release tag.

## API 设计

| Function | Contract | 关联需求 |
| --- | --- | --- |
| createGuiUpdateController | getState, getRendererPath, checkNow, checkOnce, startPeriodicChecks, stopPeriodicChecks, beginInstall | FR-1, FR-2 |
| parseGuiBundle | validate and decode the complete renderer bundle before writes | FR-3 |
| package-gui-update.cjs | --dist, --revision, --output; produces bundle and SHA256SUMS.txt | FR-3 |

Reuse launcher:update-check, launcher:update-install, launcher:update-state and the existing UpdateState shape. The version label is GUI rN.

## 文件结构

New: desktop-electron/electron/gui-update.cjs; desktop-electron/scripts/package-gui-update.cjs; aiTemp/gui-update/gui-update.test.cjs; .github/workflows/gui-only-update.yml.

Modify: desktop-electron/electron/update.cjs exports and optional tag validation; desktop-electron/electron/main.cjs update wiring and renderer path; desktop-electron/src/App.tsx one-click controls and copy.

## 设计决策

### Renderer-only activation（关联需求: FR-1, FR-2）

A full installer requires quitting the parent process. A separate renderer bundle fits the requested service continuity. Keep revision directories and failed staging files for recovery; do not replace the installed application.

### Exact compatibility（关联需求: FR-3）

A newer GUI can require newer IPC or runtime APIs. Require the existing shell version and fingerprint rather than guessing compatibility. GUI release publication rejects backend changes relative to that shell tag.

## 测试策略

One focused Node test file covers selection, verified activation, duplicate calls, checksum/path/compatibility rejection and rollback. Run existing update regression tests, TypeScript and an isolated renderer build. Verify the rendered settings/sidebar action and an Electron renderer reload with stable service PIDs where available.

## 风险评估

| Risk | Impact | Mitigation |
| --- | --- | --- |
| GUI expects newer backend API | High | Exact shell version/fingerprint and release backend comparison |
| Renderer reload fails | Medium | Roll back to previous path and leave pointer uncommitted |
| Initial installed shell lacks new updater | Medium | Preserve current processes; report bootstrap installation boundary |
| Existing unrelated worktree edits | Medium | Exact changes only; no staging, reset or commit |

## 检查清单

- [x] All FRs map to implementation and tests.
- [x] Paths, API boundaries, compatibility and rollback are concrete.
