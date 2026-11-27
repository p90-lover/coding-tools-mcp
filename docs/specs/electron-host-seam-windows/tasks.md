# 任务清单：electron-host-seam-windows

## 概述 · Overview

Slice 2 of the electron host seam: window modules through the host.

## 交付物清单（Scope-lock） · Deliverables

- `desktop-electron/electron/host/electron-host.cjs` (window modules)
- `desktop-electron/electron/main.cjs` (seven names from the host)
- `desktop-electron/tests/electron-host.test.cjs` (window cases, ratchet)
- Rides the 0.8.172 batch with slice 1

## 任务列表 · Tasks

### 阶段 1: 准备工作 · Preparation
- [x] Measure the module and window surfaces (design.md)
- [x] Spec (this folder)

### 阶段 2: 核心实现 · Implementation
- [x] Host: classes passed through, `screen`, `dialog`, `Menu`, `nativeImage` picked
- [x] `main.cjs`: take the seven names from the host

### 阶段 3: 集成测试 · Tests
- [x] `electron-host.test.cjs` window cases and ratchet: 6/6
- [x] Suites of every module that receives these objects: 85 files, 2,076/2,085. The 9 failures
      are environmental: `playwright-core` absent (7), `runtime-web` packages absent (1), and the
      Keysmith test, whose `python` resolves to an empty Python-manager shim here (1).

## 检查点 · Checkpoints

- No window name left in `main.cjs`'s Electron import.
- Suites green, then commit.

## 需求覆盖矩阵 · Coverage

| Requirement | Tasks |
|---|---|
| FR-1 | host extended, main.cjs switched |
| FR-2 | ratchet update |
| FR-3 | window surface in design.md |

## 文件变更清单 · Files changed

- changed: `electron/host/electron-host.cjs`, `electron/main.cjs`, `tests/electron-host.test.cjs`

## 检查清单 · Checklist

- [x] Implementation done
- [x] Tests green
- [x] Committed
