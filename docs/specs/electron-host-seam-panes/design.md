# 设计文档：electron-host-seam-panes

## 概述 · Overview

`createElectronHost` gains `WebContentsView` (class) and `session` (picked, with one property). A
new `electron/host/current.cjs` holds the host `main.cjs` registers. `browser-host.cjs` asks it for
each service when used, so it no longer loads Electron, and a WebView2 host registered in phase 3
is picked up with no change to `browser-host.cjs`.

## 技术方案 · Approach

### 技术选型 · Choices

Same pattern as slices 1–2. `pick()` gains property forwarding (getter only) for `defaultSession`.

### 架构设计 · Structure

```
main.cjs: host = createElectronHost(require("electron")); setCurrentHost(host); { …, WebContentsView, session } = host
browser-host.cjs: const desktop = () => currentHost();  …  new (desktop().WebContentsView)(…), desktop().shell.openExternal(…)
current.cjs: currentHost() = registered host ?? createElectronHost(require("electron"))
```

| Host name | Kind | Exposed |
|---|---|---|
| `WebContentsView` | class, passed through | `new` |
| `session` | picked | `fromPartition`; property `defaultSession` |

## 数据模型 · Data

None. Saved profiles (`persist:` partitions), cookies and storage are untouched: the same Electron
sessions serve them.

## API 设计 · Interface

`setCurrentHost(host)`, `currentHost()` in `electron/host/current.cjs`.

**Pane surface (phase 3 contract)**, measured across all backend files on 2026-11-27.

Page contents (`webContents`): isDestroyed 42 · executeJavaScript 31 · on 25 · getURL 22 ·
session 15 · loadURL 10 · close 10 · focus 9 · setWindowOpenHandler 8 · setZoomFactor 6 ·
setBackgroundThrottling 4 · send 4 · mainFrame 4 · isFocused 4 · navigationHistory 3 · id 3 ·
removeListener 2 · isCrashed 2 · debugger 2 · reloadIgnoringCache · reload · once ·
disableDeviceEmulation · capturePage

Sessions: webRequest 13 (onCompleted, onBeforeRequest, onHeadersReceived, onErrorOccurred,
onBeforeSendHeaders) · cookies 11 (get, set, flushStore, on, removeListener, off) · fetch 8 ·
getUserAgent 4 · setProxy 3 · setPermissionRequestHandler 3 · setPermissionCheckHandler 3 · on 3 ·
flushStorageData 3 · clearStorageData 3 · setUserAgent 2 · resolveProxy 2 · storagePath ·
setCertificateVerifyProc · clearCache

## 文件结构 · Files

- new: `desktop-electron/electron/host/current.cjs`
- changed: `electron/host/electron-host.cjs`, `electron/browser-host.cjs`, `electron/main.cjs`,
  `tests/electron-host.test.cjs`

## 设计决策 · Decisions

### 决策 1: A registered current host for browser-host.cjs（关联需求: FR-2, FR-3）
`BrowserHost` uses its services through file-level names across many methods; passing a host into
every one would change dozens of call sites. One lookup at the moment of use keeps the change to
those lines and lets phase 3 swap the host by registering it.

### 决策 2: No cache when nothing is registered（关联需求: FR-2）
Under plain Node, `currentHost()` builds from `require("electron")` on each call, so a test that
installs an Electron stand-in, at any point, gets that stand-in.

### 决策 3: `defaultSession` as a forwarded property（关联需求: FR-1）
Electron's `session.defaultSession` is a property; a getter keeps reads unchanged.

### 决策 4: Tests inject a host double, not an Electron double（关联需求: FR-3）
A test that runs `browser-host.cjs` in a sandbox and answered `require("electron")` with a fake
view now answers `require("./host/current.cjs")` with a fake host (`browser-home-tab.test.cjs`).
This is the seam working as intended: the file depends on the host, not on Electron.

## 测试策略 · Tests

`electron-host.test.cjs`: session picking with the property, `WebContentsView` pass-through,
current host (registered, unregistered, stand-in installed later), ratchet. Suites: browser-*,
chat-preview, provider-network, agent-orchestrator-upstream, main-related, backend-bundle.

## 风险评估 · Risks

- `shell` is also a local window variable in `browser-host.cjs` (`shell.isDestroyed()`,
  `shell.focus()`): only the module's `shell.openExternal` calls change.
- Electron services read later than before? No: the old file-level names were the module objects,
  whose methods were read at use; the new lookup reads the same objects at use.

## 检查清单 · Checklist

- [ ] host + current.cjs
- [ ] browser-host.cjs and main.cjs switched
- [ ] tests green
