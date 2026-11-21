# 任务清单：add-codex-cli

## 概述

Add the stable Codex CLI updater without changing reviewer routing.

## 交付物清单（Scope-lock）

- 3 implementation/test additions: `electron/codex-cli.cjs`, `patches/agent-orchestrator/managed-codex.patch`, `tests/codex-cli.test.cjs` under `desktop-electron`.
- 4 modifications: `electron/app-plugins.cjs`, `electron/main.cjs`, `scripts/build-agent-orchestrator.cjs`, `tests/app-plugins.test.cjs`.
- 3 specification files, including this checklist.

## 任务列表

### 阶段 1: 准备工作

- [x] 1.1 Identify the updater, upstream package, and native/AO launch seams.
  - **证据块:** `app-plugins.cjs:652` filters `item.updateAvailable && item.canUpdate`; the official npm platform alias identifies Windows x64 and arm64.
  - **涉及文件:** requirements and design, 70 lines total.
  - _需求: FR-1, FR-2_ ｜ _设计: 技术方案_

### 阶段 2: 核心实现

- [ ] 2.1 Stage and verify the stable package and register the App Plugins entry.
  - **证据块:** `app-plugins.cjs:706` runs `updateAll((item) => item.autoUpdate)`; the old version remains untouched.
  - **涉及文件:** `codex-cli.cjs`, 185 lines; `app-plugins.cjs`, 45 changed lines.
  - _需求: FR-1, FR-2_ ｜ _设计: 技术方案_
- [ ] 2.2 Use the managed executable without interrupting active chats.
  - **证据块:** `agent-orchestrator-workflow.cjs:501` has the `findCodexExecutable` injection; `build-agent-orchestrator.cjs:128` builds the pinned daemon.
  - **涉及文件:** `main.cjs`, build script and AO patch, 60 changed lines total.
  - _需求: FR-2_ ｜ _设计: 设计决策_

### 阶段 3: 集成测试

- [ ] 3.1 Verify stable upgrades, opt-in, corrupt archive refusal, and the bundled launcher seam.
  - **证据块:** `app-plugins.test.cjs:15` defines the existing fake registry/release check boundary.
  - **涉及文件:** `app-plugins.test.cjs` and `codex-cli.test.cjs`, 150 test lines total.
  - _需求: FR-1, FR-2_ ｜ _设计: 测试策略_

## 检查点

- [x] Source and official package identity traced.
- [x] `node --test` passed 19 App Plugins tests and 3 installer tests. The official 193,373,309-byte Windows x64 package staged in isolation, passed the registry SHA-512 and archive checks, and reported `codex-cli 0.171.0`. The pinned AO resolver patch applies. No installed app or account was changed during verification.

## 需求覆盖矩阵

| 需求 ID | 设计章节 | 任务编号 | 状态 |
| --- | --- | --- | --- |
| FR-1 | 技术方案 | 1.1, 2.1, 3.1 | Planned |
| FR-2 | 设计决策 | 1.1, 2.1, 2.2, 3.1 | Planned |

## 文件变更清单

See the scoped deliverables and per-task budgets above.

## 检查清单

- [x] All requirements map to implementation and verification.
