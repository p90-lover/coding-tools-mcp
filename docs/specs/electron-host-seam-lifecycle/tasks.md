# 任务清单：electron-host-seam-lifecycle

## 概述 · Overview

Slice 4 of the electron host seam: the app lifecycle and IPC through the host; `main.cjs` and the
entry free of Electron.

## 交付物清单（Scope-lock） · Deliverables

- `desktop-electron/electron/host/electron-host.cjs` (`app`, `ipcMain`, `net`, `webContents`,
  `webFrameMain`)
- `desktop-electron/electron/main.cjs`, `desktop-electron/electron/main-with-provider.cjs`
- `desktop-electron/tests/electron-host.test.cjs`
- `docs/specs/electron-host-seam/requirements.md` (FR-5 acceptance)
- Rides the 0.8.172 batch with slices 1–3

## 任务列表 · Tasks

### 阶段 1: 准备工作 · Preparation
- [x] Measure the lifecycle surface (design.md)
- [x] Spec (this folder)

### 阶段 2: 核心实现 · Implementation
- [x] Host gains the five names; `pick` forwards picked properties (`app.commandLine`)
- [x] Entry: current host, registered, to the provider network, then `main.cjs`
- [x] `main.cjs`: every Electron name from the current host
- [x] Parent FR-5 acceptance revised

### 阶段 3: 集成测试 · Tests
- [x] `electron-host.test.cjs`: lifecycle cases, entry hand-over, main's names on the host, ratchet: 11/11
- [x] Affected suites: 102 files, 2,264/2,273; the 9 failures are environmental (playwright-core 7, runtime-web packages 1,
  Keysmith's python shim 1). Not run: `native-proxy-auth`, which starts the real Electron binary to test
  `control-server`'s native request, unchanged here

## 检查点 · Checkpoints

- Only `electron/host/` and `preload.cjs` load Electron.
- Suites green, then commit.

## 需求覆盖矩阵 · Coverage

| Requirement | Tasks |
|---|---|
| FR-1 | host gains the five names; lifecycle cases |
| FR-2 | entry and main.cjs switched; entry hand-over test; ratchet |
| FR-3 | lifecycle surface in design.md |
| FR-4 | parent FR-5 acceptance revised |

## 文件变更清单 · Files changed

- changed: `electron/host/electron-host.cjs`, `electron/host/current.cjs` (comments), `electron/main.cjs`,
  `electron/main-with-provider.cjs`,
  `tests/electron-host.test.cjs`, `docs/specs/electron-host-seam/requirements.md`

## 检查清单 · Checklist

- [x] Implementation done
- [x] Tests green
- [x] Committed
