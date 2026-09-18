# 任务清单：hello-mcp-shell-loopbacks

## 概述

实现 hello Desktop shell / MCP loopback 硬编码、健康面板、无下载 Start、以及 7 日探测重连。

## 交付物清单（Scope-lock）

- **预计新建文件数:** 8
- **预计修改文件数:** 14
- **预计新增/修改函数数:** 约 18
- **交付物逐项列举:**
  1. `desktop-electron/electron/five-stack-loopbacks.cjs`
  2. `desktop-electron/electron/five-stack-loopback-probes.cjs`
  3. `desktop-electron/src/features/FiveStackLoopbackPanel.tsx`
  4. `desktop-electron/tests/five-stack-loopbacks.test.cjs`
  5. `desktop-electron/tests/five-stack-loopback-probes.test.cjs`
  6. `desktop-electron/tests/hello-mcp-shell-loopbacks.test.cjs`
  7. `docs/handoff/hello-mcp-shell-loopbacks.md`
  8. `docs/specs/hello-mcp-shell-loopbacks/*`
  9. 修改 shell-bridge / external-services / managed-external-services / main / App / MCP panel / Integrations UI / i18n / styles / paseo defaults / tests asserting 6767

## 任务列表

### 阶段 1: 准备工作

- [x] 1.1 选定 starting ref 为 `origin/release/codex-router-multiprovider-0.7.0-rc.8`（已含 #177 原始 shell），新建 `cursor/hello-mcp-shell-loopbacks-96b6`
  - **证据块:** PR #177 恢复 Browser/Setup/MCP/Activity/Settings；GitHub `main` 仍是 Tauri 0.4.11，无 `desktop-electron/`
  - **涉及文件:** git branch only
  - _需求: NFR-4_ ｜ _设计: 概述_

### 阶段 2: 核心实现

- [ ] 2.1 落地冻结端口图与 probeAll（含 CommandCode 9090→3050、Paseo 6768、Anneal `#/tasks`）
  - **证据块:** `external-services.cjs` DEFAULTS 仍把 Paseo execution 指到 `ws://127.0.0.1:6767/ws`；CommandCode inspect 只打 `/v1/models`
  - **涉及文件:** `five-stack-loopbacks.cjs` ~180 行；`external-services.cjs` DEFAULTS/healthUrl；`managed-external-services.cjs` Paseo WS；`vendor/managed-components/paseo.json`
  - _需求: US-1_ ｜ _设计: 锁定端口_

- [ ] 2.2 MCP shell-bridge overlay 与静默探测循环
  - **证据块:** `coding-tools-shell-bridge.cjs` `integrationsSnapshot` 返回 sibling-owned；`toolsCatalog` 直通 headless
  - **涉及文件:** shell-bridge、main.cjs、loopback-probes.cjs、contracts 不新增敏感字段
  - _需求: US-2, US-4_ ｜ _设计: API 设计_

- [ ] 2.3 MCP 面板健康块 + Integrations Start 去掉下载门闸
  - **证据块:** `ExternalServicesSurface.tsx` 标题为 Install/repair；Anneal GitHub token 禁用 Install；MCP 表面只有 `McpLiveToolsPanel`
  - **涉及文件:** FiveStackLoopbackPanel、App.tsx、McpLiveToolsPanel、ExternalServicesSurface、i18n、styles
  - _需求: US-1, US-3, NFR-3_ ｜ _设计: UI_

### 阶段 3: 集成测试

- [ ] 3.1 单测端口图、探测去抖/崩溃恢复、shell 导航与无下载 Start 契约
  - **证据块:** `desktop-shell-fidelity.test.cjs` 已锁导航；`five-stack-routing-completion.test.cjs` 现断言 6767
  - **涉及文件:** 三个新测试文件 + 更新 6767 断言
  - _需求: US-1..US-4_ ｜ _设计: 测试策略_

## 检查点

- [ ] 阶段 1 完成后：工作分支基于 rc.8 Electron shell
- [ ] 阶段 2 完成后：MCP 面板可列出五端口；Start 不要求 token/install
- [ ] 阶段 3 完成后：相关 node:test 通过

## 需求覆盖矩阵

| 需求 ID | 设计章节 | 任务编号 | 状态 |
|---------|----------|----------|------|
| FR-1 | 锁定端口 / UI | 2.1, 2.3 | 进行中 |
| FR-2 | API 设计 | 2.2 | 进行中 |
| FR-3 | Start without install | 2.3 | 进行中 |
| FR-4 | 探测循环 | 2.2, 3.1 | 进行中 |
| US-1 | 锁定端口 / UI | 2.1, 2.3 | 进行中 |
| US-2 | API 设计 | 2.2 | 进行中 |
| US-3 | Start without install | 2.3 | 进行中 |
| US-4 | 探测循环 | 2.2, 3.1 | 进行中 |
| NFR-1 | 决策 1 | 全部 | 进行中 |
| NFR-3 | UI | 2.3, 3.1 | 进行中 |
| NFR-4 | 概述 | 1.1 | 完成 |

## 文件变更清单

| 文件 | 操作 | 行数预算 | 说明 |
|------|------|----------|------|
| desktop-electron/electron/five-stack-loopbacks.cjs | 新建 | 220 | 冻结端口 + probeAll |
| desktop-electron/electron/five-stack-loopback-probes.cjs | 新建 | 120 | 去抖重连 |
| desktop-electron/src/features/FiveStackLoopbackPanel.tsx | 新建 | 180 | MCP 健康块 |
| desktop-electron/electron/coding-tools-shell-bridge.cjs | 修改 | 80 | catalog/call overlay |
| desktop-electron/electron/external-services.cjs | 修改 | 60 | 6768 与 CommandCode probes |
| desktop-electron/electron/managed-external-services.cjs | 修改 | 40 | Start 不要求 installed |
| desktop-electron/src/features/ExternalServicesSurface.tsx | 修改 | 50 | 去掉下载门闸文案 |
| desktop-electron/tests/*.cjs | 新建/修改 | 250 | 契约与探测 |

## 检查清单

- [x] 交付物清单已填
- [x] 任务标题具体
- [x] 每条任务含证据块
- [x] 每条任务标注涉及文件
- [x] 任务回链到需求与设计
- [x] 全文无占位符
