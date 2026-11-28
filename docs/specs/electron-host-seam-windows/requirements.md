# 需求文档：electron-host-seam-windows

## 功能概述 · Overview

Slice 2 of the electron host seam (parent: `docs/specs/electron-host-seam`, FR-3). Windows and the
modules around them reach the backend only through `electron/host/electron-host.cjs`. The user's
interface and its look do not change.

## 历史经验与坑（来自记忆库） · Lessons

- Slice 1: Electron services must not be touched before the app is ready, and the host is built at
  load, so module methods are looked up when read. `screen` in particular is ready-only.
- Slice 1: each file builds its host from the Electron it loads; no shared instance.
- Window objects must stay real Electron windows in this phase: code checks `isDestroyed()`, reads
  `webContents` (76 uses) and hooks native window messages.

## 术语定义 · Terms

- **Module surface**: the static methods and classes taken from Electron (`dialog.showMessageBox`,
  `new BrowserWindow`).
- **Window surface**: the methods called on a window object, recorded here as the contract the
  WebView2 host meets in phase 3.

## 范围边界 · Scope

In: `BrowserWindow`, `BaseWindow`, `Tray`, `screen`, `dialog`, `Menu`, `nativeImage` in `main.cjs`
and the modules it passes them to. Out: `WebContentsView`, sessions and other browser-pane parts
(slice 3); `app`, `ipcMain`, `net`, `webContents`, `webFrameMain` (slice 4).

## 需求列表 · Requirements

### FR-1: Window modules through the host
`main.cjs` takes `BrowserWindow`, `BaseWindow`, `Tray`, `screen`, `dialog`, `Menu` and
`nativeImage` from the host and passes those on, as it passed Electron's before.

Acceptance:
- WHEN the app starts under Electron, every window, tray, menu, dialog, image and display call SHALL
  behave exactly as before.
- `screen`, `dialog`, `Menu` and `nativeImage` SHALL expose only the methods listed in design.md,
  each looked up when read.
- The window classes SHALL be Electron's own classes, so `new`, statics and `instanceof` work.

### FR-2: The guard covers slice 2
Acceptance:
- IF `main.cjs` imports any of these seven names from Electron, THEN the guard test SHALL fail and
  name it.

### FR-3: The window surface is recorded
Acceptance: design.md SHALL list the window methods the backend calls, as phase 3's contract.

## 非功能需求 · Non-functional

No new process starts, timers or disk writes; identical behaviour; interface unchanged.

## 依赖关系 · Dependencies

Slice 1 (commit 8790f6ac8) on `feat/electron-host-seam`.

## 检查清单 · Checklist

- [ ] FR-1 implemented
- [ ] FR-2 guard updated
- [ ] FR-3 inventory recorded
