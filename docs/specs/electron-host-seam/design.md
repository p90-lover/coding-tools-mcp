# 设计文档：electron-host-seam

## 概述 · Overview

One module, `electron/host/electron-host.cjs`, is the backend's only door to Electron's desktop
services. It builds a plain object with the methods the backend actually calls, under the same
names and shapes as Electron's, and nothing else. `main.cjs` and `browser-host.cjs` each build it
from the `require("electron")` they load, and use it where Electron's modules went before. A later
Tauri host builds an object of the same shape.

## 技术方案 · Approach

### 技术选型 · Choices

Plain CommonJS, no new dependency. The interface mirrors Electron's method names for the subset in
use, so call sites change only in where the object comes from, and behaviour cannot drift.

### 架构设计 · Structure

```
main.cjs, browser-host.cjs ──createElectronHost(require("electron"))──▶ host
   │                                                   ├─ safeStorage   { isEncryptionAvailable, encryptString, decryptString }
   ├─ main passes host.safeStorage to the 9 stores      ├─ clipboard     { writeText }
   └─ both use host.* for notices, theme, power, links  ├─ shell         { openExternal, openPath, showItemInFolder }
                                                        ├─ nativeTheme   { themeSource (get/set) }
                                                        ├─ Notification  class: isSupported(), new (options), show(), on()
                                                        ├─ powerMonitor  { on, removeListener, getSystemIdleTime }
                                                        └─ powerSaveBlocker { start, stop, isStarted }
```

Under plain Node (`require("electron")` is a path string) every service is `null`, as the code
already tolerates for `powerMonitor` and `powerSaveBlocker`.

## 数据模型 · Data

None. No stored format changes: secrets encrypted by `host.safeStorage` are byte-identical,
because it calls Electron's own `safeStorage`.

## API 设计 · Interface

`createElectronHost(electron) → host` (frozen object; absent services are `null`).
`ELECTRON_HOST_SERVICES`: the service names and their methods, used by the ratchet test.

## 文件结构 · Files

- `desktop-electron/electron/host/electron-host.cjs` (new)
- `desktop-electron/electron/main.cjs` (imports trimmed; uses `host.*`)
- `desktop-electron/electron/browser-host.cjs` (receives `host`; imports only `WebContentsView`)
- `desktop-electron/tests/electron-host.test.cjs` (new: shape, plain-Node behaviour, ratchet)

## 设计决策 · Decisions

### 决策 1: Mirror Electron's names for the methods in use（关联需求: FR-1）
A new vocabulary would touch every call site and invite behaviour drift. Mirroring keeps slice 1
a change of where objects come from. Phase 3's Tauri host implements this small surface.

### 决策 2: Wrap, don't pass Electron objects through（关联需求: FR-1, FR-2）
Passing Electron's modules through would let the backend reach any Electron method again. The
wrapper exposes only the listed methods, so a new use fails loudly in tests.

### 决策 3: No shared host instance（关联需求: FR-1）
Each file builds its host from the Electron module it loaded, as it destructured Electron before.
A shared, build-once host would hand a test that reloads a module with another Electron stand-in
the previous stand-in's services.

### 决策 4: A shrinking allow-list test（关联需求: FR-2）
The guard names the files that may load Electron and the names each may import; each slice
removes entries. A forgotten import fails CI instead of surfacing in Phase 3.

## 测试策略 · Tests

`electron-host.test.cjs` (shape, forwarding, plain-Node nulls, ratchet), plus the existing suites
that cover these paths: browser-host, notifications, secret stores (external-services,
managed-components, provider-network, email-host), launcher/main wiring tests.

## 风险评估 · Risks

- A missed reference to a removed import throws at run time: `node --check` plus a search for each
  removed name in `main.cjs` and `browser-host.cjs`, and the main wiring tests.
- `new Notification(...).on("click")` users must keep working: the wrapper returns Electron's
  notification object's `show` and `on`.

## 检查清单 · Checklist

- [ ] electron-host.cjs with the seven services
- [ ] main.cjs and browser-host.cjs switched
- [ ] ratchet test green
- [ ] affected suites green
