# 任务清单：electron-host-seam

## 概述 · Overview

Slice 1 now (desktop services and the ratchet test); slices 2–4 follow in their own changes.

## 交付物清单（Scope-lock） · Deliverables

- `desktop-electron/electron/host/electron-host.cjs`
- `desktop-electron/electron/main.cjs`, `desktop-electron/electron/browser-host.cjs` switched to it
- `desktop-electron/tests/electron-host.test.cjs`
- Joins the next release batch; no installer of its own

## 任务列表 · Tasks

### 阶段 1: 准备工作 · Preparation
- [x] Measure Electron use (4 files load it; 24 receive objects; methods in use listed in design.md)
- [x] Spec (this folder)

### 阶段 2: 核心实现 · Implementation
- [x] `electron-host.cjs`: seven services, frozen, null under plain Node
- [x] `main.cjs`: build the host; replace `safeStorage`, `clipboard`, `shell`, `nativeTheme`,
      `Notification`, `powerMonitor`, `powerSaveBlocker` uses; trim the import
- [x] `browser-host.cjs`: build its host from the Electron it loads; import only
      `WebContentsView`

### 阶段 3: 集成测试 · Tests
- [x] `electron-host.test.cjs` (shape, forwarding, plain Node, lazy lookups, ratchet): 5/5
- [x] Affected suites: 79 files, 1,990/1,998; the 8 failures are missing packages in this
      worktree (`playwright-core`; `runtime-web` dependencies for its separate browser host).
      After the lazy-lookup change, the sensitive suites again: 276/276. `node --check` clean.

## 检查点 · Checkpoints

- After implementation: no file outside the allow-list loads Electron; removed names gone.
- After tests: suites green, then commit and join the batch.

## 需求覆盖矩阵 · Coverage

| Requirement | Tasks |
|---|---|
| FR-1 | electron-host.cjs, main.cjs, browser-host.cjs |
| FR-2 | electron-host.test.cjs ratchet |
| FR-3 | slice 2: windows (later change) |
| FR-4 | slice 3: browser panes (later change) |
| FR-5 | slice 4: app lifecycle (later change) |

## 文件变更清单 · Files changed

- new: `electron/host/electron-host.cjs`, `tests/electron-host.test.cjs`
- changed: `electron/main.cjs`, `electron/browser-host.cjs`

## 检查清单 · Checklist

- [x] Implementation done (slice 1)
- [x] Tests green (slice 1)
- [ ] Committed and joined the batch
