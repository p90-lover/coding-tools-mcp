# 需求文档：electron-host-seam-panes

## 功能概述 · Overview

Slice 3 of the electron host seam (parent: `docs/specs/electron-host-seam`, FR-4). The built-in
browser panes reach the backend only through the host interface, and `browser-host.cjs` stops
loading Electron. The user's interface and its look do not change.

## 历史经验与坑（来自记忆库） · Lessons

- Slices 1–2: module methods are looked up when read (some services are ready-only); classes pass
  through because Electron hands real objects back in events.
- `browser-host.cjs` uses its services through file-level names in 4,928 lines; changing where they
  come from must not change when they are read.
- `runtime-web/launcher/electron/browser-host.cjs` is a separate, older copy; out of scope.

## 术语定义 · Terms

- **Current host**: the host `main.cjs` registers at start; modules that cannot receive it by
  argument ask for it when they need a service.

## 范围边界 · Scope

In: `WebContentsView` and `session` in `main.cjs`, `browser-host.cjs` and the modules they are passed
to (`chat-preview`, the Orchestrator view, `provider-network`). Out: `app`, `ipcMain`, `net`,
`webContents`, `webFrameMain` (slice 4); the renderer bridge (phase 2).

## 需求列表 · Requirements

### FR-1: Browser panes through the host
`WebContentsView` and `session` come from the host. `session` exposes `fromPartition` and the
`defaultSession` property; `WebContentsView` is Electron's own class.

Acceptance:
- WHEN the app runs under Electron, every pane, saved profile, cookie, page script and request
  hook SHALL behave exactly as before.
- `session.defaultSession` SHALL read Electron's default session each time it is read.

### FR-2: A current host
Acceptance:
- WHEN `main.cjs` registers its host, `currentHost()` SHALL return that host.
- WHEN no host is registered (tests under plain Node), `currentHost()` SHALL build one from
  `require("electron")` at that moment.

### FR-3: `browser-host.cjs` free of Electron
Acceptance:
- `browser-host.cjs` SHALL NOT load `electron`; it SHALL take each service from `currentHost()` when
  it uses it.
- IF it, or `main.cjs` importing `WebContentsView` or `session`, loads them from Electron again,
  THEN the guard test SHALL fail.

### FR-4: The pane surface is recorded
Acceptance: design.md SHALL list the page-contents and session methods the backend calls, as phase
3's contract.

## 非功能需求 · Non-functional

No new process starts, timers or disk writes; identical behaviour; interface unchanged.

## 依赖关系 · Dependencies

Slices 1 and 2 (`feat/electron-host-seam` a2b0c6a24).

## 检查清单 · Checklist

- [ ] FR-1 … FR-4
