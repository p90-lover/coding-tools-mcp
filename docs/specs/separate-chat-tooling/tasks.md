# 任务清单：separate-chat-tooling

## 概述

Extract chat add-on ownership, controls and diagnostics while leaving conversation state and transport alone.

## 交付物清单（Scope-lock）

- New production files: 3 (`chat-tool-addons.cjs`, `ChatAddonSettings.tsx`, `ChatAddonPicker.tsx`).
- Production edits: 8 (tool service, server adapter, logging, backend closure, app surface, workbench, chat header, narrow chat CSS).
- Verification: focused runtime and renderer tests, plus these three spec files. No dependency update or settings migration.

## 任务列表

### 阶段 1: 准备工作

- [ ] 1.1 Bind the v0.8.161 source and map callers before changing the tool catalog and chat surfaces.
  - **证据块**: `desktop-electron/electron/chat-agent-tools.cjs:581` defines `GROUPS`; `desktop-electron/src/features/AgentOrchestratorChat.tsx:3112` renders a separate Preview button.
  - **涉及文件**: the specs and local graph receipt only.
  - _需求: FR-1, FR-2_ ｜ _设计: 架构设计_

### 阶段 2: 核心实现

- [ ] 2.1 Register fixed group ownership and show conflicting claims without altering permissions.
  - **证据块**: `desktop-electron/electron/chat-mcp-servers.cjs:310` silently excludes `names.has(server.name.toLowerCase())`.
  - **涉及文件**: tool add-on registry (120 lines); tool service (45 changed lines), server adapter (20), logging (8), backend closure (2).
  - _需求: FR-2, FR-3_ ｜ _设计: API 设计_
- [ ] 2.2 Move duplicate settings into Plugins and open optional panels from one launch button.
  - **证据块**: `desktop-electron/src/App.tsx:2932` repeats settings; `desktop-electron/src/features/ChatWorkbench.tsx:528` renders a flat tool chooser.
  - **涉及文件**: add-on settings (120 lines), picker (95), app surface (110 changed or removed), workbench (45), chat header (35).
  - _需求: FR-1, FR-3_ ｜ _设计: 架构设计_

### 阶段 3: 集成测试

- [ ] 3.1 Verify runtime conflict suppression, privacy, and existing dispatch and panel behavior.
  - **证据块**: `desktop-electron/tests/chat-mcp-servers.test.cjs:116` already exercises filtering and session limits.
  - **涉及文件**: focused Node tests with fixture data only, renderer behavior checks, backend dependency-closure checks.
  - _需求: FR-1, FR-2, FR-3_ ｜ _设计: 测试策略_

## 检查点

- Verify applicable impacted callers before editing. Use the required release CI gates after focused checks.

## 需求覆盖矩阵

| 需求 ID | 设计章节 | 任务编号 | 状态 |
|---|---|---|---|
| FR-1 | 架构设计 | 1.1, 2.2, 3.1 | Planned |
| FR-2 | API 设计 | 1.1, 2.1, 3.1 | Planned |
| FR-3 | 数据模型 | 2.1, 2.2, 3.1 | Planned |

## 文件变更清单

Listed by task above. The chat send engine, third-party plugins, and renderer test data are not changed.

## 检查清单

- [x] Each requirement maps to concrete work and verification.
