# 需求文档：pr-193-paseoanneal

## 功能概述

PR #193 是 Paseo↔Anneal + CommandCode 车道。在 #192 五栈 glue（in-memory `paseo_plan` → `anneal_preview`）之上补齐：Paseo 编排器在 CPA / Codex Router **可用时**把它们当 provider 后端；CommandCode 保持打包 loopback 9090/3050；Paseo review 发现需要新任务时，向 Anneal 真实 POST BACKLOG 并可预览。不重做 Bot GG #194 的 CPA :8317 / Router :4202 端口或 bundled Start。

**目标用户:** Desktop + MCP 操作员，在同一 App 内用 Paseo 编排、Anneal 预览任务，并把 CPA/Router 当已有 provider 后端。

**核心价值:** 不跳出 Desktop、不先下载；编排器走 in-app loopback；#194 仍是 CPA/Router SoT。

**历史经验规避:** 不改 8317/4202；不给 CPA/Router/MCP 设 `OPENAI_BASE_URL`；不收集 CommandCode `user_*`；不静默打开 autoStart。

## 术语定义

- **CPA backend:** `http://127.0.0.1:8317/v1`（端口由 #194 拥有，本车道只消费）
- **Router backend:** `http://127.0.0.1:4202/v1`（端口由 #194 拥有，本车道只消费）
- **CommandCode loopback:** 打包默认 `http://127.0.0.1:9090`，inspect 探测 `3050`
- **可用:** Integrations snapshot 中该服务 `status === "ready"` 或 `running === true`
- **Anneal handoff:** `POST /projects/{id}/tasks`，`status: BACKLOG`，`approvalGate: true`，`opensPullRequest: false`

## 范围边界

**In Scope（本次要做）**
- Paseo orchestrator / subagent 路由在 CPA :8317、Router :4202 可用时选用对应 `/v1`
- CommandCode provider 固定 9090（inspect 仍探测 3050）
- Paseo review findings → Anneal BACKLOG 创建 + GET preview/board
- 允许名单补 `/projects/{id}/tasks` 与 GET `/tasks`、`/tasks/{id}`
- 测试覆盖可用性分支与 BACKLOG 体，不改 8317/4202 字面端口

**Out of Scope（本次不做）**
- 重做 CPA/Router bundled Start、OpenAPI/IPC、keep-alive（#194）
- 改 Desktop 五栈 glue 入口或 MCP catalog 工具名（#192）
- 新开 Desktop HTTP 端口
- 把 CPA/Router 从 Install 改成本车道的 bundled-source

---

## 需求列表

### FR-1: Paseo 在 CPA/Router 可用时走 in-app provider 后端

**优先级:** Must
**用户故事:** 作为编排操作员，我想要 Paseo 主编排器与子代理在 CPA 或 Codex Router 已 Start 时走它们的 in-app `/v1`，以便不另装 provider。

#### 验收标准（EARS）

1. WHEN CPA snapshot 为 ready/running AND 所选 provider 属于 CPA 车道（`cliproxyapi-antigravity`、`gemini-oauth` 及同族 Gemini/CPA adapters）THEN 系统 SHALL 把该角色 `backend` 设为 `http://127.0.0.1:8317/v1`
2. WHEN Router snapshot 为 ready/running AND 所选 provider 属于 Router 车道（`codex-oauth`、`openai-api`、`chatgpt-web`）THEN 系统 SHALL 把该角色 `backend` 设为 `http://127.0.0.1:4202/v1`
3. IF 首选后端不可用 AND 另一 CPA/Router 后端可用 THEN 系统 SHALL 回退到那个可用的 in-app `/v1` 并标记 `backendFallback: true`
4. IF CPA 与 Router 都不可用 THEN 系统 SHALL 回退到 CommandCode `http://127.0.0.1:9090/v1` 且不得改 8317/4202 端口号
5. WHEN 计划完成 THEN `backends.cpa` SHALL 仍为 `http://127.0.0.1:8317/v1` 且 `backends.router` SHALL 仍为 `http://127.0.0.1:4202/v1`

### FR-2: CommandCode 保持打包 9090/3050

**优先级:** Must
**用户故事:** 作为 CommandCode 操作员，我想要 proxy 继续听 9090 并在 9090 失败时探测 3050，以便不与 #194 端口冲突。

#### 验收标准（EARS）

1. WHEN providerId 为 `commandcode-proxy` THEN 系统 SHALL 把 `backend` 设为 `http://127.0.0.1:9090/v1`，即使 CPA/Router 也可用
2. WHILE CommandCode inspect 运行 THE 系统 SHALL 继续探测 3050 作为备用 listen，且不得把 9090 改成 8317 或 4202
3. IF 请求试图把 CommandCode 后端改到非 loopback THEN 系统 SHALL 拒绝

### FR-3: Paseo review 向 Anneal 交接 BACKLOG 任务并可预览

**优先级:** Must
**用户故事:** 作为编排操作员，我想要 review 发现的 bug/issue 在 Anneal 建成 BACKLOG 任务并预览，以便后续在任务板上打开。

#### 验收标准（EARS）

1. WHEN `anneal_open_from_review` 且 review 有 findings AND Anneal 可用 THEN 系统 SHALL `POST /projects/{projectId}/tasks`，body 含 `status: "BACKLOG"`、`approvalGate: true`、`opensPullRequest: false`、`assigneeType: "AGENT"`
2. WHEN 交接成功 THEN 返回记录 `state` SHALL 为 `BACKLOG`，并带上远程 task id 与 preview 路径
3. WHEN `anneal_preview` THEN 系统 SHALL 优先 `GET /tasks/{id}`；IF Anneal 不可达 THEN 返回本地 BACKLOG 记录
4. IF review 没有 findings THEN 系统 SHALL 拒绝打开 Anneal 任务
5. IF Anneal 不可用 THEN 系统 SHALL 仍保存本地 `state: "BACKLOG"` 记录并标记 `handoff.posted: false`，不得改成 TODO

### FR-4: 不下载才能用，且不重做 #194 端口

**优先级:** Must
**用户故事:** 作为 Desktop 用户，我想要 Start Paseo/Anneal/CommandCode 无需另下 CPA/Router 安装包，以便本车道保持 focused。

#### 验收标准（EARS）

1. WHILE 本变更落地 THE 系统 SHALL 不修改 `vendor/managed-components/cpa.json` 或 `codex-router.json` 的 listen/health 端口
2. WHEN 面板文案提到 CPA/Router THEN 系统 SHALL 继续写 :8317 / :4202，不得改号
3. IF 本车道新增 Anneal/Paseo/CommandCode 行为 THEN 系统 SHALL 继续走 bundled-source / 已有 Start，不得加 download-before-use 闸门

---

## 非功能需求

- **NFR-1（性能）:** `paseo_plan` 可用性读取只用已有 services snapshot，不额外阻塞 >12s 的 inspect
- **NFR-2（安全）:** mesh/plan JSON 不含 `user_*`、`proxyApiKey`、caller keys；Anneal POST 仅 loopback
- **NFR-3（兼容性）:** 保留 #192 工具名 `paseo_plan` / `paseo_run` / `paseo_review` / `anneal_open_from_review` / `anneal_preview`；CPA/Router 端口与 #194 一致

---

## 依赖关系

- #192 `desktop-electron/electron/five-stack-control-plane.cjs` 工具循环与 MCP catalog
- #194 CPA :8317 / Router :4202 SoT（只消费，不改端口）
- Tauri `src-tauri/src/integrations/execution/protocol.rs` Anneal create BACKLOG 体为契约参考
- `desktop-electron/electron/upstream-actions.cjs` 原版功能允许名单

## 检查清单

- [x] 已消化记忆库的历史经验，并逐条规避「历史坑」
- [x] 需求覆盖核心场景与边界场景
- [x] 每条需求有唯一 ID（FR-n），将在 design.md / tasks.md 中被引用
- [x] 验收标准使用 EARS 格式且可测
- [x] 已标注优先级（MoSCoW）
- [x] 范围边界（In/Out of Scope）明确
- [x] 非功能需求明确、尽量可量化
- [x] 依赖关系完整
