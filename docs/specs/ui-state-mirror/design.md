# Design: UI settings mirror

## 概述

A renderer module watches `localStorage` writes and sends the app keys to main; main keeps them in `ui-settings-mirror.json` under userData. When the page starts with an empty store, the same module asks main for the mirror synchronously and puts the keys back before any screen module runs.

**对应需求:** FR-1, FR-2, FR-3, NFR-1..NFR-4.

## 技术方案

### 技术选型

| 类别 | 选择 | 理由 | 关联需求 |
|------|------|------|----------|
| Change detection | Wrap `Storage.prototype.setItem/removeItem/clear` in the page's world | About 45 call sites in 21 files write `localStorage` directly; one wrapper sees all of them, and the `storage` event never fires in the page that wrote | FR-1 |
| Restore channel | `ipcRenderer.sendSync("launcher:ui-settings-load")`, only when the store is empty | The keys must be back before the screen modules evaluate; an async load would race them | FR-2, NFR-1 |
| Save channel | `ipcRenderer.send("launcher:ui-settings-save", entries)` | Fire and forget; main coalesces and writes off the main thread | FR-1, NFR-2 |
| File write | `writePrivateFileAtomicAsync` + `saving`/`saveAgain` + last-written comparison (as app-layout.cjs) | Atomic, queued per file, never a synchronous flush on main | FR-1 |
| Key rule | Prefix allowlist + secret-word denylist, kept in both `src/ui-settings-mirror.ts` and `electron/ui-settings-mirror.cjs`; a test keeps them equal | The page filters before IPC, main filters again before disk | FR-3 |

### 架构设计

```
main.tsx
  import "./ui-settings-mirror-start"   (first import: runs before React and every screen)
    installUiSettingsMirror({ storage: localStorage, bridge: window.codexWebLauncher })
      1. store has an app key? -> skip restore
         else bridge.loadUiSettingsMirror()  --sendSync-->  main: mirror.load()  (readFileSync, small)
              ok + entries -> setItem each passing key
              ok + no file -> mirror from now on
              not ok       -> no mirroring this run (keep the old file)
      2. wrap Storage.prototype.{setItem,removeItem,clear} for this storage
         app key changed -> debounce 1.5 s (max 10 s) -> snapshot -> same as last sent? skip
                                                     -> bridge.saveUiSettingsMirror(entries)
         pagehide / beforeunload -> flush now
preload.cjs  codexWebLauncher.loadUiSettingsMirror / saveUiSettingsMirror
main.cjs     registerMinimalPreRendererIpc -> installUiSettingsMirrorIpc({ ipcMain, mirror, isAppFrame })
               (before the renderer loads, so the sync load always has a handler)
ui-settings-mirror.cjs  createUiSettingsMirror({ filePath })
               load(): ENOENT -> {ok, entries:null}; bad JSON/shape -> {ok, entries:null, damaged}; I/O error -> {ok:false}
               save(entries): clean -> compare with last written (first time: with the file) -> writePrivateFileAtomicAsync
```

## 数据模型

`ui-settings-mirror.json` (userData, mode 0600):

| 实体/字段 | 类型 | 约束 | 说明 |
|-----------|------|------|------|
| `version` | number | `1` | File format |
| `savedAt` | string | ISO time | When the copy was written; not compared |
| `entries` | object | keys sorted; each key passes the key rule, ≤ 512 chars; each value a string ≤ 256 KiB; total ≤ 2 MiB | The app keys and their `localStorage` values, unchanged |

## API 设计

| 方法/函数 | 路径/签名 | 入参 | 出参 | 关联需求 |
|-----------|-----------|------|------|----------|
| `isMirroredUiKey` | `src/ui-settings-mirror.ts`, `electron/ui-settings-mirror.cjs` | key | boolean | FR-3 |
| `installUiSettingsMirror` | `src/ui-settings-mirror.ts` | `{ storage, bridge, setTimer?, clearTimer?, now?, target? }` | `{ restored, mirroring, flush() }` | FR-1, FR-2 |
| `createUiSettingsMirror` | `electron/ui-settings-mirror.cjs` | `{ filePath, logger?, writeFile?, readFileSync?, readFile? }` | `{ load(), save(entries), saved() }` | FR-1, FR-2 |
| `installUiSettingsMirrorIpc` | `electron/ui-settings-mirror.cjs` | `{ ipcMain, mirror, isAppFrame }` | channels registered | FR-2, FR-3, NFR-3 |
| `loadUiSettingsMirror` | preload `codexWebLauncher` | none | `{ ok, entries?, reason? }` | FR-2 |
| `saveUiSettingsMirror` | preload `codexWebLauncher` | entries | none | FR-1 |

## 文件结构

```
desktop-electron/
├── electron/ui-settings-mirror.cjs          (new: key rule, file store, IPC wiring)
├── src/ui-settings-mirror.ts                (new: key rule, restore, change tracking)
├── src/ui-settings-mirror-start.ts          (new: installs it for the app window)
├── src/main.tsx                             (first import)
├── src/types.ts                             (LauncherApi: two optional members)
├── electron/preload.cjs                     (codexWebLauncher: two members)
├── electron/main.cjs                        (lazy store + IPC in registerMinimalPreRendererIpc)
├── tests/ui-settings-mirror.test.cjs        (new)
└── tests/ao-chat.test.cjs                   (split view survives an emptied store)
```

## 设计决策

### 决策 1: Wrap Storage writes instead of editing each call site（关联需求: FR-1）

**问题**: about 45 writes in 21 files; new screens keep adding keys.

**选项**:
1. Route every write through a helper: large diff, and the next new key that skips the helper is lost again.
2. Poll and diff `localStorage` on a timer: CPU while idle, and a minimised window still pays.
3. Wrap `Storage.prototype` once, in the page's own world.

**决策**: 选择 3.

**理由**: one place, no polling, and it covers keys added later. The wrapper calls the original first and only schedules a timer, so a write costs one prefix check. The preload cannot do this: with context isolation its prototypes are not the page's.

### 决策 2: Restore synchronously, only after a reset（关联需求: FR-2, NFR-1, NFR-3）

**问题**: screens read `localStorage` in `useState` initialisers and effects as soon as they render.

**选项**:
1. Async load, then render: React could wait, but the import graph and any future top-level read would not.
2. Sync load from the first import of `main.tsx`.

**决策**: 选择 2, gated on an empty store.

**理由**: an intact store costs nothing; after a reset one small file read blocks the page once. The handler is installed with the minimal pre-renderer IPC and sets `returnValue` in `finally`, so the page always gets an answer.

### 决策 3: Never let a failed restore overwrite the mirror（关联需求: FR-2）

**问题**: if the store was reset and the mirror could not be read (an antivirus scan holding it), the next write would replace the only copy with a nearly empty store.

**决策**: mirroring stays off for that run; it resumes on the next start. A damaged file (bad JSON) is no copy at all, so it is replaced.

### 决策 4: Secrets out by key, twice（关联需求: FR-3）

**问题**: settings keys carry no secrets today (provider instances hold names, URLs and models; native-codex keeps paths), but a later key might.

**决策**: allowlist the app's prefixes and deny any key naming a secret, in the page and again in main; restore applies the rule too. Values are never logged.

## 测试策略

- `tests/ui-settings-mirror.test.cjs`: the main store (write, no rewrite, load cases, damaged, busy, filtering), the IPC wiring (sync answer always set, foreign frames refused), the renderer module in a `vm` with a fake `Storage` (restore order, debounce, max wait, clear, pagehide flush, no load on an intact store, no save after a failed load), the key rule's parity between page and main, and every literal key the renderer writes being mirrored.
- `tests/ao-chat.test.cjs`: the Surface saves a split view, the mirror carries it to a new empty store, and the Surface restores the panes, weights and row split from it.
- Focused runs of the touched tests (preload boundary, bundled preload sandbox, launcher ready path, link preview) and `tsc --noEmit`.

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| An ATC rollback takes the mirror with the store (it took window-state.json on 2026-11-27) | 中 | Out of scope here; the av-quiet fixes reduce detections; signing is the user's call |
| `sendSync` with no handler freezes the page | 高 | Handler registered before the renderer loads; `returnValue` set in `finally`; preload catches a missing `sendSync` (web host) |
| Older main with a newer renderer (renderer hot update) | 低 | Missing bridge members mean no restore and no mirroring |
| Mirror grows with per-task keys | 低 | 2 MiB cap, largest values dropped first |

## 检查清单

- [x] 技术方案与现有架构一致
- [x] requirements.md 中每条 FR 都被本设计覆盖
- [x] 文件结构对照真实代码库，路径可定位
- [x] 数据模型 / 接口契约清晰
- [x] 关键设计决策已记录并关联需求
- [x] 测试策略可验证验收标准
