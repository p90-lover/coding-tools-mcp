# 需求文档：original-paseo-anneal-commandcode-panels

## 功能概述

在 Coding Tools 0.7 Electron 桌面中，把 Paseo、Anneal 与 commandcode-proxy 三个面板做成「原版界面 + 原版可用操作」，而不是重新设计的装饰壳。Paseo / Anneal 以内嵌 pinned 上游 Web UI 为主画面；commandcode-proxy 没有 HTML dashboard，因此复现其 CLI banner / health JSON 所暴露的功能。CPA、Codex Router、主壳导航与 extension HUD 不在本次范围。

## 历史经验与坑

- 现有 `UpstreamToolSurface` 已能 iframe 上游服务，但默认要手动点「Open full UI」，且外层是 Coding Tools 装饰壳。
- Anneal `apps/web` 使用 hash routing（`#/tasks`）。把 path `/tasks` 塞进 iframe 会错过原版看板。
- Paseo Expo 真实路由是 `/`、`/sessions`、`/settings`、`/open-project`、`/new`、`/schedules`。manifest 里的 `/agents`、`/workspaces`、`/providers`、`/plugins`、`/voice` 不是原版路由。
- commandcode-proxy（zahidhussaina2l @ c123a3e）只提供 `GET /`、`GET /health`、`GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/messages`。没有独立网页控制台。
- Anneal 上游支持 macOS / Linux，不是原生 Windows。Windows 上要用使用者自行管理的 loopback port-forward。
- 端点必须维持 loopback-only；凭证不得写入 renderer 明文日志。

## 术语定义

- **原版界面**：pinned 上游自己的 Web UI，或 commandcode-proxy 启动 banner / health 契约所呈现的资讯。
- **可用操作**：原版已经暴露、且本整合能对已运行或 App 管理的本机服务执行的动作。
- **装饰壳**：看起来像控制台、但按钮不连到上游真实行为，或导航到不存在的上游路径。

---

## 范围边界

**In Scope**
- 修正 Paseo / Anneal 内嵌 URL，使其打开原版路由。
- 服务可达时自动嵌入原版 UI，并以接近全幅方式显示。
- 为 commandcode-proxy 增加可运作的原版 banner 面板：Check / Start / Stop / Restart、health / models、复制 OpenAI 与 Anthropic base URL。
- Anneal Windows / 远端服务的 port-forward 说明。
- 聚焦测试覆盖路由、自动嵌入与 proxy health 面板。

**Out of Scope**
- CPA Provider Hub、Codex Router 前端、主 Desktop shell 导航、fast-access-extension HUD / popup。
- 重写 Paseo / Anneal 完整引擎，或把 native orchestration details 提升成主画面。
- 把 commandcode-proxy 的 `/v1/chat/completions` 做成聊天客户端。
- 改变 loopback 安全边界或把密钥写进 profile。

---

## 需求列表

### FR-1: Paseo 内嵌原版路由

**优先级:** Must

#### 验收标准（EARS）

1. WHEN 使用者打开 Paseo 面板且本机服务为 ready THEN 系统 SHALL 自动嵌入 pinned Paseo Web UI，不必先点装饰性「Open full UI」才能看到原版。
2. WHEN 内嵌 section 为 agents 或 sessions THEN 系统 SHALL 打开真实 Expo 路径 `/sessions`，不得打开不存在的 `/agents`。
3. WHEN 内嵌 section 为 settings、providers、plugins 或 voice THEN 系统 SHALL 打开 `/settings`。
4. WHEN 内嵌 section 为 workspaces THEN 系统 SHALL 打开 `/open-project`。
5. IF 原版 UI 已嵌入 THEN 系统 SHALL 让 iframe 占满面板工作区，而不是把重新设计的 session rail 当作主画面。

### FR-2: Anneal 内嵌原版看板

**优先级:** Must

#### 验收标准（EARS）

1. WHEN 使用者打开 Anneal 面板且本机服务为 ready THEN 系统 SHALL 自动嵌入 pinned Anneal Web UI。
2. WHEN 内嵌 section 为 tasks THEN 系统 SHALL 打开 `http://127.0.0.1:<port>/#/tasks`（hash routing），不得打开无 hash 的 `/tasks` 当作原版看板。
3. WHEN 内嵌其他 Anneal section THEN 系统 SHALL 使用对应 `#/<section>` hash，例如 `#/projects`、`#/inbox`、`#/settings`。
4. WHEN 面板显示 Anneal 连接说明 THEN 系统 SHALL 写明上游不是原生 Windows，远端 API 需使用者自行做安全的本机 port-forward 到 loopback。

### FR-3: commandcode-proxy 原版可操作面板

**优先级:** Must

#### 验收标准（EARS）

1. WHEN 使用者在 Integrations 选中 CommandCode Proxy THEN 系统 SHALL 显示与 zahidhussaina2l/commandcode-proxy banner 对等的面板（版本、监听位址、Cursor Base URL、Claude Code `ANTHROPIC_BASE_URL`）。
2. WHEN 使用者按 Check 且 `GET /` 或 `GET /health` 成功 THEN 系统 SHALL 显示 status、endpoints、models，以及 health 回传的 user / credits（若有）。
3. WHEN 使用者按 Start / Stop / Restart THEN 系统 SHALL 调用既有 external-services 生命周期，不得留下无 IPC 的死按钮。
4. WHEN 使用者复制 OpenAI 或 Anthropic base URL THEN 系统 SHALL 复制 `http://127.0.0.1:<port>/v1`（OpenAI）与 `http://127.0.0.1:<port>` 或 `/v1`（Anthropic），不得要求使用者手写不存在的 dashboard 路径。
5. IF proxy API key 由 App 管理 THEN 系统 SHALL 不在 renderer 展示完整密钥。

### FR-4: 安全与范围不变

**优先级:** Must

#### 验收标准（EARS）

1. WHEN 解析或探测 Paseo / Anneal / commandcode-proxy 端点 THEN 系统 SHALL 继续限制为 127.0.0.1 或 [::1]。
2. WHEN 本次改动落地 THEN 系统 SHALL 不修改 CPA Provider Hub、Codex Router 专属编辑栏、主壳 sidebar 项目，以及 extension HUD。
3. IF 服务仍在进程外 THEN 面板文案 SHALL 说明这是本机 / App 管理的外部服务，而不是把按钮做成假装已内嵌执行引擎。

---

## 非功能需求

- **NFR-1（安全）**：loopback-only；health payload 只投影有界字段；不把 PROXY_API_KEY 或 GitHub token 写入 UI / 日志。
- **NFR-2（兼容）**：Paseo 默认 `http://127.0.0.1:6768/`，执行通道仍可为 `ws://127.0.0.1:6767/ws`；Anneal 默认 `http://127.0.0.1:3000/`；commandcode-proxy 默认 `http://127.0.0.1:9090/`。
- **NFR-3（体验）**：原版 UI 可达时自动出现；离线时 Check / Start 仍可用，没有死按钮。
- **NFR-4（测试）**：既有 rc7 section 名称契约保留；新增路由 / health / auto-embed 聚焦测试。

## 依赖关系

- 依赖既有 `electron/upstream-tools.cjs`、`electron/external-services.cjs`、`UpstreamToolSurface` 与 managed component manifests。
- 不依赖新的 Codex Router 或 CPA 功能。

## 检查清单

- [x] 每条需求有唯一 ID（FR-n），将在 design.md / tasks.md 中被引用
- [x] 范围边界（In/Out of Scope）明确
- [x] 非功能需求明确、尽量可量化
- [x] 依赖关系完整
