# 需求文档：hello-mcp-shell-loopbacks

## 功能概述

Hello Desktop shell / MCP lane. Coding Tools Electron Desktop 的原始导航（Browser / Setup / MCP / Activity / Settings）与 in-app MCP 面板，必须通过硬编码的 in-app loopback 管理与监控五栈，不经过单独下载/安装门闸。

本 lane 不重做 CPA/Router keep-alive（#190/#194）、不重做 Paseo↔Anneal 契约（#193）、不接管五栈 glue（#192）。

## 需求列表

- **FR-1**: MCP 面板列出五栈 in-app loopback 的 listening/offline 状态（锁定端口见 US-1）。
- **FR-2**: MCP `tools.catalog` / `tools.call` 暴露 `five_stack_status`、`five_stack_loopbacks`、`five_stack_start`，响应无密钥；headless 失败时 shell 回退仍可用。
- **FR-3**: Start 先探测 in-app loopback，不得因未 Install 或缺少 GitHub token 而禁用。
- **FR-4**: shell↔MCP 探测循环支持 7 日重连、指纹去抖与崩溃重建，不重做 CPA/Router keep-alive。

## 用户故事

### US-1: 操作者在 MCP 面板查看五栈 loopback 健康

**优先级:** Must
**用户故事:** 作为 Desktop 操作者，我想在 MCP 面板看到五个 in-app loopback 是否在监听，以便不离开原始 shell 就能监控 CPA、Codex Router、CommandCode、Paseo 与 Anneal。

#### 验收标准（EARS）

1. WHEN MCP 表面打开 THEN 系统 SHALL 列出 CPA `127.0.0.1:8317`、Codex Router `127.0.0.1:4202`、CommandCode Proxy `127.0.0.1:9090`（`/health` 与 `/v1/models`，回退 `127.0.0.1:3050`）、Paseo `127.0.0.1:6768` protocol v1、Anneal `127.0.0.1:3000` tasks API `#/tasks` 的 listening/offline 状态。
2. IF 某端点 TCP/HTTP 有响应（含 401/403/404）THEN 系统 SHALL 将该栈标记为 listening，不得要求 2xx 才算监听。
3. IF CommandCode `:9090` 无响应且 `:3050` 有响应 THEN 系统 SHALL 报告 fallback listening，且不得把下载外部代理当作前置条件。

### US-2: MCP 工具与 shell 共享同一端口图

**优先级:** Must
**用户故事:** 作为 MCP 调用方，我想通过 catalog/call 读取同一份 loopback 图与健康快照，以便 Desktop 面板与 MCP 组合同一套 API。

#### 验收标准（EARS）

1. WHEN `tools.catalog` 被调用 THEN 系统 SHALL 至少暴露只读工具 `five_stack_status` 与 `five_stack_loopbacks`。
2. WHEN `tools.call` 调用 `five_stack_status` THEN 系统 SHALL 返回无密钥的五栈健康 JSON（不得包含 `callerKey`、`proxyApiKey`、`managementKey`）。
3. IF headless catalog 失败 THEN 系统 SHALL 仍返回上述五栈工具（shell 本地回退），以便 shell↔MCP 探测崩溃后可恢复。

### US-3: Start 命中 in-app loopback，无下载门闸

**优先级:** Must
**用户故事:** 作为 Desktop 操作者，我想直接 Start 五栈 loopback，以便使用已捆绑/本机监听的服务，而不是先下载或先填 GitHub token。

#### 验收标准（EARS）

1. WHEN 操作者在 Integrations 或 MCP 五栈面板按 Start THEN 系统 SHALL 先探测锁定 loopback；若已 listening 则立即返回 ready。
2. IF managed 组件尚未 `installed` THEN 系统 SHALL 仍允许 Start 走 loopback 探测/既有 start，不得因 missing GitHub token 禁用 Start。
3. IF 面板文案描述五栈 THEN 系统 SHALL 说明 in-app loopback，不得把 “Install / GitHub token first” 写成使用前置条件。

### US-4: 7 日长跑下的 shell↔MCP 探测

**优先级:** Must
**用户故事:** 作为长时间开着 Desktop 的操作者，我想探测自动重连且不刷日志，以便 7 日运行期间状态不漂移。

#### 验收标准（EARS）

1. WHEN 探测循环抛错或定时器丢失 THEN 系统 SHALL 重建探测循环（crash recovery）。
2. IF 健康指纹未变化 THEN 系统 SHALL 不重复发布状态、不逐次写错误日志。
3. WHEN 端点从 offline 变为 listening 或反向变化 THEN 系统 SHALL 发布一次状态变更。

## 非功能需求

- **NFR-1（范围）**: 只改 shell / MCP / panel routing。不得改 CPA/Router 引擎 keep-alive、Paseo/Anneal 引擎协议实现、或 #192 的 `five-stack-control-plane` glue。
- **NFR-2（安全）**: loopback 探测与 MCP 响应不得回传密钥；端点必须限制在 loopback host。
- **NFR-3（视觉）**: 保留原始 Coding Tools 导航顺序：Workspace → Browser，Configuration → Setup / MCP，Runtime → Activity，Settings；五栈健康块加在 MCP 表面，不替换主导航。
- **NFR-4（兼容）**: 本 PR 基于 Electron `release/codex-router-multiprovider-0.7.0-rc.8`（已含 #177 shell），便于 rebase 到 #192/#194。

## 依赖关系

- 原始 shell 与 live MCP wiring：PR #177 / #183
- CPA/Router 捆绑与 keep-alive：#194 / #190（本 lane 只消费端口，不重做）
- CommandCode/Paseo/Anneal 契约：#193（本 lane 只硬编码端口与探测）
- 五栈 glue：#192（本 lane 不复制 `paseo_plan` / `five_stack_manage` glue）

## 检查清单

- [x] 需求覆盖核心场景与边界场景
- [x] 每条需求有唯一 ID（FR 通过 US 验收）
- [x] 验收标准使用 EARS 格式且可测
- [x] 已标注优先级（MoSCoW）
- [x] 范围边界明确
- [x] 非功能需求明确
- [x] 依赖关系完整
