# 设计文档：electron-host-seam-windows

## 概述 · Overview

`createElectronHost` gains the window modules. Module objects are picked as in slice 1; the three
classes pass through, because their instances must stay real Electron windows until phase 3.

## 技术方案 · Approach

### 技术选型 · Choices

Same pattern as slice 1: Electron's names, only the methods in use, lazy lookup.

### 架构设计 · Structure

| Host name | Kind | Exposed (measured 2026-11-27) |
|---|---|---|
| `BrowserWindow` | class, passed through | `new`, `fromWebContents`, `getAllWindows` |
| `BaseWindow` | class, passed through | `new` |
| `Tray` | class, passed through | `new` |
| `screen` | picked | `getPrimaryDisplay`, `getDisplayNearestPoint`, `getCursorScreenPoint`, `getAllDisplays`, `dipToScreenRect` |
| `dialog` | picked | `showMessageBox`, `showOpenDialog`, `showSaveDialog`, `showErrorBox` |
| `Menu` | picked | `buildFromTemplate` |
| `nativeImage` | picked | `createFromPath`, `createFromDataURL` |

A missing class reads as `null` (plain Node).

## 数据模型 · Data

None.

## API 设计 · Interface

`HOST_SERVICES` gains `screen`, `dialog`, `Menu`, `nativeImage`; `HOST_CLASSES` lists
`BrowserWindow`, `BaseWindow`, `Tray` with their statics in use.

**Window surface (phase 3 contract).** Methods the backend calls on a window or tray object, with
use counts across `main.cjs`, `chat-windows`, `chat-preview`, `mcp-connector-setup`,
`chatgpt-workspace`, `antigravity-auth-browser`, `computer-control`, `renderer-accessibility`,
`agent-orchestrator-upstream` and `keysmith-ipc`:

webContents 76 · isDestroyed 59 · on 13 · isMinimized 13 · once 11 · isFocused 11 · show 10 ·
isVisible 10 · loadURL 8 · destroy 8 · restore 4 · focus 4 · close 4 · flashFrame 3 ·
contentView 3 · maximize 2 · loadFile 2 · isMaximized 2 · hookWindowMessage 2 ·
getNativeWindowHandle 2 · unmaximize · setToolTip · setTitle · setMenuBarVisibility ·
setFullScreen · setContextMenu · minimize · isFullScreen · hide · getContentBounds · center

## 文件结构 · Files

- `desktop-electron/electron/host/electron-host.cjs`
- `desktop-electron/electron/main.cjs` (import trimmed)
- `desktop-electron/tests/electron-host.test.cjs`

## 设计决策 · Decisions

### 决策 1: Pass the window classes through（关联需求: FR-1）
Wrapping window instances would touch about 300 call sites and the objects Electron hands back
(events carry the real window). Passing the class keeps instances real; the window surface above is
what phase 3 implements.

### 决策 2: Pick the module objects（关联需求: FR-1, FR-2）
`screen`, `dialog`, `Menu` and `nativeImage` are plain modules: picking them limits the backend to
the methods in use, as for slice 1.

### 决策 3: Record the window surface in the spec（关联需求: FR-3）
The counts come from a search of the files listed; phase 3 re-measures before it starts.

## 测试策略 · Tests

`electron-host.test.cjs`: classes pass through with their statics, picked modules expose exactly
their lists, lazy lookup for `screen`, plain-Node nulls, ratchet without the seven names. Existing
suites for chat windows, preview, connector setup, workspace, computer control, tray and main.

## 风险评估 · Risks

- A module method in use but missed by the measurement throws at run time. Mitigation: the
  measurement searched every backend file for each name; the affected suites run.
- `dialog.showMessageBox(window, options)` takes a window first: forwarded unchanged.

## 检查清单 · Checklist

- [ ] host extended
- [ ] main.cjs switched
- [ ] tests green
