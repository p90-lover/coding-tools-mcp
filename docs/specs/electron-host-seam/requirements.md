# 需求文档：electron-host-seam

## 功能概述 · Overview

Phase 1 of the WebView2 rewrite plan: every Electron dependency of the desktop backend
(`desktop-electron/electron`) goes behind one host interface. Electron implements that interface
for now, so the app behaves exactly as before. Phase 3 then gives the same interface a Tauri 2 /
WebView2 implementation, and the backend runs on plain Node.

User requests (2026-11-27): "Plan WebView2 rewrite", then "Start Phase 1", and "can u keep the
original coding tools ui and style ?" — yes: the interface (`desktop-electron/src`) and its look do
not change in this phase or the next ones.

Measured on main 9ae200d56 (0.8.170): 181 backend files, 86,480 lines. Only four load Electron:
`main.cjs` (6,201 lines), `browser-host.cjs` (4,928), `preload.cjs` (398) and
`main-with-provider.cjs` (8). Twenty-four more receive Electron objects passed in, `safeStorage`
among them in ten files.

## 历史经验与坑（来自记忆库） · Lessons

- `require("electron")` under plain Node (the test harness) returns the binary's path, not the API
  (`browser-host.cjs` already guards for this). The host must work, with services absent, there too.
- In `browser-host.cjs`, `shell.isDestroyed()` / `shell.focus()` act on a local window named
  `shell`, not Electron's `shell` module.
- Bitdefender quarantined the unsigned app on 2026-11-27; this phase adds no new process starts.

## 术语定义 · Terms

- **Host**: the program that owns windows and OS services (Electron today; Tauri/WebView2 later).
- **Host interface**: the object the backend receives instead of Electron modules.
- **Slice**: one part of the seam, shipped through the normal release batch on its own.

## 范围边界 · Scope

In: `desktop-electron/electron/**` and its tests. Out: the interface (`desktop-electron/src`),
the AO daemon, CPA, `src-tauri`, packaging. No user-visible change.

## 需求列表 · Requirements

### FR-1: Desktop services behind the host interface (slice 1)
Encrypted secrets (`encryptString`, `decryptString`, `isEncryptionAvailable`), clipboard
(`writeText`), shell (`openExternal`, `openPath`, `showItemInFolder`), theme (`themeSource`),
notifications (`isSupported`, create, `show`, `on`), power events (`on`, `removeListener`,
`getSystemIdleTime`) and the sleep blocker (`start`, `stop`, `isStarted`) reach `main.cjs` and
`browser-host.cjs` only through the host interface. Only the methods listed are exposed.

Acceptance:
- WHEN the app starts under Electron, the backend SHALL receive these services from the host
  interface, and they SHALL behave exactly as Electron's (same calls, same results).
- WHEN `require("electron")` exposes no API (plain Node), the host SHALL report each service as
  `null` instead of throwing.
- The host interface SHALL expose only the methods listed above.

### FR-2: A ratchet against new Electron use
A test fails when a backend file outside the allowed list loads `electron`, and when an allowed
file imports a name its slice has already moved behind the host. The list only shrinks.

Acceptance:
- IF a backend file outside the allow-list loads `electron`, THEN the guard test SHALL fail and
  name the file.
- IF `main.cjs` or `browser-host.cjs` imports a name already moved behind the host, THEN the guard
  test SHALL fail and name it.

### FR-3: Windows behind the host interface (slice 2)
`BrowserWindow`, `BaseWindow`, window controls, `screen`, `dialog`, `Menu`, `Tray`,
`nativeImage`, `hookWindowMessage`.

Acceptance: WHEN slice 2 lands, `main.cjs` SHALL create and control windows only through the host
interface, and the guard SHALL forbid those names.

### FR-4: Browser panes behind the host interface (slice 3)
`WebContentsView`, session partitions, cookies, page scripts, captures and request hooks in
`browser-host.cjs` and the preview and Orchestrator views.

Acceptance: WHEN slice 3 lands, `browser-host.cjs` SHALL NOT load `electron`, and every browser
pane SHALL keep its saved profile, cookies and scripts working as before.

### FR-5: App lifecycle behind the host interface (slice 4)
`app` events, paths, single instance, `ipcMain`, `net`, `webContents`, `webFrameMain` (the backend
registers no protocol handlers). Done when no backend file outside `electron/host/` and the preload
loads Electron (`docs/specs/electron-host-seam-lifecycle`).

Acceptance (revised in slice 4):
- WHEN slice 4 lands, only `electron/host/` and `preload.cjs` SHALL load `electron` (the ratchet), and
  the entry SHALL hand one registered host to the provider network and `main.cjs`, proven without
  loading `main.cjs`; the existing test suites SHALL pass.
- Starting the backend under plain Node on a stand-in host SHALL come with the phase 0/3 spike,
  against a scratch profile: loading `main.cjs` creates folders, sets environment variables and
  builds registries under the user's real data paths, so no test does it.

## 非功能需求 · Non-functional

- Behaviour identical: every existing test passes unchanged except where it injects Electron
  doubles, which then inject the host doubles.
- No new process starts, timers or disk writes.
- Interface and style untouched.

## 依赖关系 · Dependencies

None for slice 1. Slices 2–4 follow in order; Phase 2 (bridge over WebSocket) can run alongside 3.

## 检查清单 · Checklist

- [ ] FR-1 implemented and tested (slice 1)
- [ ] FR-2 guard test in place
- [ ] FR-3 … FR-5 in later slices
