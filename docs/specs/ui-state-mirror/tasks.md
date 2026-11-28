# Tasks: UI settings mirror

## 概述

Mirror the renderer's own `localStorage` keys to userData and restore them into an emptied store, then ship it in the next release batch (0.8.173; 0.8.172's cutoff has passed).

## 交付物清单（Scope-lock）

- **预计新建文件数**: 7 (3 source, 1 test, 3 spec)
- **预计修改文件数**: 5
- **预计新增/修改函数数**: about 12
- **交付物逐项列举**:
  1. `desktop-electron/electron/ui-settings-mirror.cjs`
  2. `desktop-electron/src/ui-settings-mirror.ts`
  3. `desktop-electron/src/ui-settings-mirror-start.ts`
  4. `desktop-electron/tests/ui-settings-mirror.test.cjs`
  5. `desktop-electron/electron/main.cjs` (lazy store, IPC in `registerMinimalPreRendererIpc`)
  6. `desktop-electron/electron/preload.cjs` (two `codexWebLauncher` members)
  7. `desktop-electron/src/main.tsx` (first import)
  8. `desktop-electron/src/types.ts` (two optional `LauncherApi` members)
  9. `desktop-electron/tests/ao-chat.test.cjs` (split view end to end)
  10. `docs/specs/ui-state-mirror/{requirements,design,tasks}.md`

## 任务列表

### 阶段 1: 准备工作

- [x] 1.1 Inventory every `localStorage` key the renderer writes and check them for secrets
  - **证据块**: `src/features/chat-split.ts:16` `SPLIT_STORE = "coding-tools:ao:split-view"`; `AgentOrchestratorSurface.tsx:2322` `readSplit(localStorage.getItem(splitStore))`; `ProviderOrchestratorSurfaces.tsx:27-40` provider instances hold id, name, baseUrl, models, engine (no secret); `NativeCodexPanel.tsx:19` "Only these non-secret paths and the model ID are remembered"; `AppErrorBoundary.tsx:17` the reload counter is `sessionStorage`.
  - **涉及文件**: none changed
  - _需求: FR-3_ ｜ _设计: 决策 4_
- [x] 1.2 Confirm the IPC order and the window that carries the preload
  - **证据块**: `main.cjs` `registerMinimalPreRendererIpc({ logger, stateStore })` runs before `mainWindow = createWindow(` and `ensureRendererLoaded(mainWindow, logger)`; `main.cjs:1905` only the main window has `preload: build/preload.cjs`; `chat-windows.cjs:3` "The window gets no preload".
  - **涉及文件**: none changed
  - _需求: FR-2, NFR-3_ ｜ _设计: 决策 2_

### 阶段 2: 核心实现

- [x] 2.1 Create `electron/ui-settings-mirror.cjs`: key rule, `createUiSettingsMirror` (load with ENOENT/damaged/busy cases, save that cleans, compares and writes atomically off main) and `installUiSettingsMirrorIpc` (sync answer always set, app frame only)
  - **证据块**: `atomic-file.cjs:121` `writePrivateFileAtomicAsync(filePath, content, { mode, protectDirectory, durable })`; `app-layout.cjs:1153-1176` `persist()` with `saving`/`saveAgain`/`lastWrittenText`.
  - **涉及文件**: new, about 170 lines
  - _需求: FR-1, FR-2, FR-3_ ｜ _设计: 架构设计, 数据模型, 决策 3, 决策 4_
- [x] 2.2 Create `src/ui-settings-mirror.ts` and `src/ui-settings-mirror-start.ts`: restore into an empty store, wrap `Storage.prototype` writes, debounce 1.5 s with a 10 s max wait, flush on pagehide/beforeunload, cap 2 MiB
  - **证据块**: `src/main.tsx:1-3` imports React and App first today; `chat-response-style.test.cjs:17-24` vm-loads a feature module with `localStorage` injected.
  - **涉及文件**: new, about 150 + 10 lines
  - _需求: FR-1, FR-2, FR-3_ ｜ _设计: 决策 1, 决策 2_
- [x] 2.3 Wire the bridge: preload `loadUiSettingsMirror` (sendSync, catches) and `saveUiSettingsMirror`; `LauncherApi` types; `main.cjs` lazy store and IPC in `registerMinimalPreRendererIpc`; first import in `main.tsx`
  - **证据块**: `preload.cjs:188` `appLayout: () => ipcRenderer.invoke("launcher:app-layout")`; `main.cjs:393` `appLayoutStore(logger)` lazy creation; `main.cjs:2231` `registerMinimalPreRendererIpc`.
  - **涉及文件**: preload.cjs +8, types.ts +4, main.cjs +15, main.tsx +3
  - _需求: FR-1, FR-2_ ｜ _设计: 架构设计_

### 阶段 3: 集成测试

- [x] 3.1 Add `tests/ui-settings-mirror.test.cjs` covering every acceptance criterion of FR-1..FR-3 and NFR-2..NFR-4
  - **证据块**: `preload-boundary.test.cjs:96` pins only `codingTools` namespaces; `bundled-preload-sandbox.test.cjs:23` asserts `codexWebLauncher` exists.
  - **涉及文件**: new, about 300 lines
  - _需求: FR-1, FR-2, FR-3_ ｜ _设计: 测试策略_
- [x] 3.2 Add the split view end-to-end test to `tests/ao-chat.test.cjs`: save from one store, empty it, restore from the mirror, Surface reopens the panes
  - **证据块**: `ao-chat.test.cjs:713` `surfaceComposer(seed, globals)` accepts a `localStorage`; the restore effect contains `splitRestored.current = true`.
  - **涉及文件**: tests/ao-chat.test.cjs +60
  - _需求: FR-2.5_ ｜ _设计: 测试策略_
- [ ] 3.3 Run the focused tests at low priority and `tsc --noEmit`, then join the next release batch with a READY JOINER line
  - **证据块**: AGENTS.md "Delivery: every change ships as a release"; `G:\aiTemp\release0172\OWNER.txt` 01:41 "Cutoff: later work rides 0.8.173".
  - **涉及文件**: none
  - _需求: all_ ｜ _设计: 测试策略_

## 检查点

- [x] 阶段 1 完成后：key inventory and IPC order recorded (done).
- [x] 阶段 2 完成后：`tsc --noEmit` clean; the preload still bundles in the sandbox test.
- [x] 阶段 3 完成后：new tests and the touched existing tests pass.

## 需求覆盖矩阵

| 需求 ID | 设计章节 | 任务编号 | 状态 |
|---------|----------|----------|------|
| FR-1 | 决策 1, 数据模型 | 2.1, 2.2, 2.3, 3.1 | 完成 |
| FR-2 | 决策 2, 决策 3 | 1.2, 2.1, 2.2, 2.3, 3.1, 3.2 | 完成 |
| FR-3 | 决策 4 | 1.1, 2.1, 2.2, 3.1 | 完成 |

## 文件变更清单

| 文件 | 操作 | 行数预算 | 说明 |
|------|------|----------|------|
| `desktop-electron/electron/ui-settings-mirror.cjs` | 新建 | 170 | Main store and IPC |
| `desktop-electron/src/ui-settings-mirror.ts` | 新建 | 150 | Restore and tracking |
| `desktop-electron/src/ui-settings-mirror-start.ts` | 新建 | 10 | Installs it for the window |
| `desktop-electron/tests/ui-settings-mirror.test.cjs` | 新建 | 300 | Unit and parity tests |
| `desktop-electron/electron/main.cjs` | 修改 | 15 | Store and IPC wiring |
| `desktop-electron/electron/preload.cjs` | 修改 | 8 | Bridge members |
| `desktop-electron/src/main.tsx` | 修改 | 3 | First import |
| `desktop-electron/src/types.ts` | 修改 | 4 | Types |
| `desktop-electron/tests/ao-chat.test.cjs` | 修改 | 60 | Split view end to end |

## 检查清单

- [x] 交付物清单（Scope-lock）已填
- [x] 每条任务标题是"动词+对象+约束"的具体描述
- [x] 每条任务含证据块
- [x] 每条任务标注涉及文件与行数预算
- [x] 任务分阶段合理
- [x] 每条任务都回链到 FR 与 design 章节
- [x] 需求覆盖矩阵已填
- [x] 阶段 3 包含"对照验收标准核验"
- [x] 全文无占位
