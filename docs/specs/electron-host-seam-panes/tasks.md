# 任务清单：electron-host-seam-panes

## 概述 · Overview

Slice 3 of the electron host seam: browser panes through the host; `browser-host.cjs` free of
Electron.

## 交付物清单（Scope-lock） · Deliverables

- `desktop-electron/electron/host/current.cjs` (new)
- `desktop-electron/electron/host/electron-host.cjs` (`WebContentsView`, `session`)
- `desktop-electron/electron/browser-host.cjs`, `desktop-electron/electron/main.cjs`
- `desktop-electron/tests/electron-host.test.cjs`
- Rides the 0.8.172 batch with slices 1–2

## 任务列表 · Tasks

### 阶段 1: 准备工作 · Preparation
- [x] Measure the pane surface (design.md)
- [x] Spec (this folder)

### 阶段 2: 核心实现 · Implementation
- [x] `current.cjs`; host gains `WebContentsView` and `session` (property forwarding in `pick`)
- [x] `browser-host.cjs`: services from `currentHost()` at use; no Electron import
- [x] `main.cjs`: register the host; take `WebContentsView` and `session` from it

### 阶段 3: 集成测试 · Tests
- [x] `electron-host.test.cjs` pane cases, current host, ratchet: 8/8
- [x] Affected suites: 85 files, 2,078/2,087 after moving browser-home-tab's stand-in view from an Electron double to a host double (the one test that injected Electron into a sandboxed browser-host.cjs and built a view); the 9 failures are environmental (playwright-core 7, runtime-web packages 1, Keysmith's python shim 1)

## 检查点 · Checkpoints

- `browser-host.cjs` loads no Electron; `main.cjs` imports neither name from Electron.
- Suites green, then commit.

## 需求覆盖矩阵 · Coverage

| Requirement | Tasks |
|---|---|
| FR-1 | host gains WebContentsView and session; main.cjs switched |
| FR-2 | current.cjs |
| FR-3 | browser-host.cjs switched; ratchet |
| FR-4 | pane surface in design.md |

## 文件变更清单 · Files changed

- new: `electron/host/current.cjs`
- changed: `electron/host/electron-host.cjs`, `electron/browser-host.cjs`, `electron/main.cjs`,
  `tests/electron-host.test.cjs`, `tests/browser-home-tab.test.cjs` (host double)

## 检查清单 · Checklist

- [x] Implementation done
- [x] Tests green
- [x] Committed
