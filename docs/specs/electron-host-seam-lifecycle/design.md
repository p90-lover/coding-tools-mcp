# 设计文档：electron-host-seam-lifecycle

## 概述 · Overview

`createElectronHost` gains `app`, `ipcMain`, `net`, `webContents` and `webFrameMain`. The entry takes
the current host, registers it, hands it to the provider network and loads `main.cjs`, which takes
every Electron name from the current host. Only `electron/host/` and `preload.cjs` load Electron.

## 技术方案 · Approach

### 技术选型 · Choices

Same pattern as slices 1–3: picked methods looked up when read, properties forwarded read-only.
`pick()` gains forwarded properties that are themselves picked (`app.commandLine`).

### 架构设计 · Structure

```
main-with-provider.cjs: clean env → host = currentHost(); setCurrentHost(host) → installProviderNetwork(host) → require("./main.cjs")
main.cjs: runningHost = currentHost(); setCurrentHost(runningHost); { app, ipcMain, net: electronNet, … } = runningHost
current.cjs: currentHost() = registered host ?? createElectronHost(require("electron"))
```

| Host name | Kind | Exposed |
|---|---|---|
| `app` | picked | 21 methods (below); properties `isPackaged`, `commandLine` (`appendSwitch` only) |
| `ipcMain` | picked | `handle`, `on` |
| `net` | picked | `request` |
| `webContents` | picked | `getAllWebContents` |
| `webFrameMain` | picked | `fromId` |

## 数据模型 · Data

None. Profiles, user data, logs and the single-instance lock are untouched: the same Electron `app`
serves them.

## API 设计 · Interface

**Lifecycle surface (phase 3 contract)**, measured across all backend files on 2026-11-27,
including `app` passed on (`this.app`, `options.app`):

`app`: getPath 79 · isPackaged 36 (property) · getVersion 23 · on 14 · exit 9 · commandLine 6
(property; `appendSwitch` ×6) · quit 5 · getAppMetrics 4 · whenReady 3 · once 3 · getFileIcon 3 ·
setAccessibilitySupportEnabled 2 · relaunch 2 · isReady 2 · getLoginItemSettings 2 · setPath ·
setName · setLoginItemSettings · setAppUserModelId · setAppLogsPath · requestSingleInstanceLock ·
isAccessibilitySupportEnabled · getAccessibilitySupportFeatures. Nothing assigns an `app` property.

`ipcMain`: handle 2 (one is `logging.cjs` `registerLoggedIpc`, which carries most channels) · on 1.
`net`: request 2 (`control-server.cjs` `fetchNativeWithProxyAuth`). `webContents`:
getAllWebContents 1 (renderer metrics). `webFrameMain`: fromId 3 (`cpa-panel-session.cjs`).

The provider network (`installProviderNetwork`) uses `app` (getPath, on, once, whenReady),
`BrowserWindow` (class), `ipcMain.handle`, `safeStorage`, `session` (fromPartition,
defaultSession) and `shell.openExternal`: all on the host.

## 文件结构 · Files

- changed: `electron/host/electron-host.cjs`, `electron/host/current.cjs` (comments), `electron/main.cjs`,
  `electron/main-with-provider.cjs`,
  `tests/electron-host.test.cjs`, `docs/specs/electron-host-seam/requirements.md` (FR-5)

## 设计决策 · Decisions

### 决策 1: `commandLine` exposes only `appendSwitch`（关联需求: FR-1, FR-3）
Six Chromium switches are the backend's whole use. A picked `commandLine`, read when read, keeps the
contract to that one method; a WebView2 host maps it to the browser arguments it starts with.

### 决策 2: The entry registers; `main.cjs` asks（关联需求: FR-2）
The provider network is installed before `main.cjs` loads, so the entry must hold the host first.
`main.cjs` asks for the current host and registers it again, so loading `main.cjs` alone (no entry)
still gives `browser-host.cjs` the same host. A WebView2 entry registers its own host in the same
place and nothing after it changes.

### 决策 3: `app` is a picked object, not Electron's（关联需求: FR-1）
Measured: no file assigns an `app` property, compares it to Electron's, or reads a member off the
list. `app.on` returns Electron's `app`, so a chained `.on` still reaches Electron.

### 决策 4: FR-5 is proven without loading `main.cjs`（关联需求: FR-4）
Loading `main.cjs` resolves the profile and creates folders from `app.getPath("appData")`, sets
environment variables and builds registries under the home folder, `CODING_TOOLS_*` and
`CODEX_HOME`. A test that did so could reach the user's real data. Slice 4 proves the boundary
statically (the ratchet) and the entry's hand-over with stubs; the phase 0/3 spike starts the
backend against a scratch profile.

## 测试策略 · Tests

`electron-host.test.cjs`: app pick (methods, properties read when read, `commandLine` with
`appendSwitch` only, `this` kept), the other four services, laziness, the entry's hand-over (stubbed
modules), every name `main.cjs` destructures exists on the host, ratchet. Suites: main-related
source checks, provider-network, browser-*, cpa-panel, control-server, backend-bundle.

## 风险评估 · Risks

- A module calling an `app` member off the list gets `undefined` and throws at that call. Mitigated
  by measuring by name across all backend files, including `this.app` and `options.app`.
- The entry's first code line must stay the environment clean-up (agent-session-env test).

## 检查清单 · Checklist

- [x] host gains the five names
- [x] entry and main.cjs switched
- [x] tests green
