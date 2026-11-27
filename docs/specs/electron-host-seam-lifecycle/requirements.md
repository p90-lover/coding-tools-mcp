# 需求文档：electron-host-seam-lifecycle

## 功能概述 · Overview

Slice 4, the last slice of the electron host seam (parent: `docs/specs/electron-host-seam`, FR-5).
The app lifecycle and IPC (`app`, `ipcMain`, `net`, `webContents`, `webFrameMain`) reach the backend
only through the host interface. After it, neither `main.cjs` nor the package entry
`main-with-provider.cjs` loads Electron: only `electron/host/` and the preload do. The user's
interface and its look do not change.

## 历史经验与坑（来自记忆库） · Lessons

- Slices 1–3: methods are looked up when read (some services must not be touched before ready);
  classes pass through; properties are forwarded and read when read (`session.defaultSession`).
- A module that runs `browser-host.cjs` in a sandbox now answers `./host/current.cjs` with a host
  double, not `electron` (slice 3).
- `main.cjs` does real work when it loads: it resolves the launcher profile from
  `app.getPath("appData")`, creates and resolves the user-data folder, sets environment variables
  and builds registries under the home folder, `CODING_TOOLS_*` and `CODEX_HOME`. Tests read its
  source or run extracted functions; none loads it.

## 术语定义 · Terms

- **Entry**: `desktop-electron/electron/main-with-provider.cjs`, the package's `main`.
- **Current host**: the host registered in `electron/host/current.cjs` (slice 3).

## 范围边界 · Scope

In: `app`, `ipcMain`, `net`, `webContents`, `webFrameMain` in `main.cjs` and the entry, and every
module they are passed to (autostart, browser-debugging, mcp-connector-command, runtime-install,
smoke-exit, chatgpt-workspace, headless-host, runtime-supervisor, runtime, logging,
provider-bootstrap, control-server, cpa-panel-session). Out: the renderer bridge (`preload.cjs`,
phase 2); the instances' own methods (windows, page contents, sessions: recorded in slices 2–3).

## 需求列表 · Requirements

### FR-1: App lifecycle through the host
`app`, `ipcMain`, `net`, `webContents` and `webFrameMain` come from the host, each exposing only the
members the backend uses (design.md). `app.isPackaged` and `app.commandLine` are forwarded
properties; `commandLine` exposes only `appendSwitch`.

Acceptance:
- WHEN the app runs under Electron, start, single instance, paths, accessibility, autostart, quit,
  relaunch, IPC, native requests and renderer metrics SHALL behave exactly as before.
- `app.isPackaged` and `app.commandLine` SHALL be read from Electron each time they are read.
- Building the host SHALL read no `app` member.

### FR-2: `main.cjs` and the entry free of Electron
Acceptance:
- `main.cjs` and `main-with-provider.cjs` SHALL NOT load `electron`.
- The entry SHALL register one host before it loads the provider network and `main.cjs`, and both
  SHALL get that host.
- Every name `main.cjs` takes from the host SHALL exist on the host.
- IF either file loads Electron again, THEN the guard test SHALL fail.

### FR-3: The lifecycle surface is recorded
Acceptance: design.md SHALL list the `app`, `ipcMain`, `net`, `webContents` and `webFrameMain`
members the backend uses, with counts, as phase 3's contract.

### FR-4: The parent's FR-5 states what slice 4 proves
Acceptance: the parent spec's FR-5 SHALL state that slice 4 proves, without loading `main.cjs`,
that only `electron/host/` and the preload load Electron and that the entry hands one host to the
provider network and `main.cjs`; and that starting the backend on a stand-in host SHALL come with
the phase 0/3 spike, which runs it against a scratch profile.

## 非功能需求 · Non-functional

No new process, timer or disk write; identical behaviour; interface and style unchanged.

## 依赖关系 · Dependencies

Slices 1–3 (`feat/electron-host-seam` 8abaff3f3).

## 检查清单 · Checklist

- [x] FR-1 … FR-4
