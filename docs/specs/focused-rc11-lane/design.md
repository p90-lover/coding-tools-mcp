# 设计文档：focused-rc11-lane

## 概述

在 #192 的 0.7.0-rc.11 五栈 Start+health 之上，补齐 #192 没有的 Check status / Copy plan / Apply non-secret、12s inspect、9090↔3050、keepAlive≠autoStart、Paseo/Anneal 允许名单原版功能，以及 CommandCode session revive。Tauri 车道仍保留 lease/live/actions，与 #192 的 execution/provider/orchestrator 加性共存。不合并 CPA / Codex Router 独占编辑器（#190），不改 Desktop 主壳。

**对应需求:** FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, NFR-1, NFR-2, NFR-3

---

## 技术方案

### 技术选型

| 类别 | 选择 | 理由 | 关联需求 |
|------|------|------|----------|
| UI 宿主 | 现有 Svelte 5 面板 + loopback iframe | 原版 Web 已由上游进程提供，嵌入即可功能对等，不必重画整个 Expo/Hono 应用 | FR-2, FR-3, FR-1 |
| 协议 | 现有 tokio-tungstenite + reqwest | 已通过 loopback、无代理、无重定向、2 MiB 边界 | FR-2, FR-3, NFR-2 |
| 进程 | 仅 owned `tokio::process::Child` | 与 RuntimeSupervisor 一样只管理自己 spawn 的进程 | FR-4 |
| 持久化 | `AppData.integration_leases` 加性字段 | 与 `control_board` 相同，旧档案可加载 | FR-5, NFR-3 |
| 退避 | 1→60s 指数 + 抖动，稳定 120s 清零 | 复用隧道 Recovery 语义，避免 7 天刷屏 | FR-5 |
| CSP | `frame-src` 仅字面 loopback | 现配置 `frame-src 'none'` 会挡住原版 UI | FR-2, FR-3, NFR-2 |

### 架构设计

```
Svelte Integrations / Sessions / Work
  ├─ OriginalFrame (iframe, loopback only)
  ├─ native controls (send/resume/approve/start/stop)
  └─ invoke IPC (main window only)
        │
        ▼
commands/control_center.rs
  ├─ integration_read          (unchanged one-shot snapshot)
  ├─ integration_live_status
  ├─ integration_live_connect / disconnect
  ├─ integration_act
  └─ commandcode_proxy_status / apply / control
        │
        ▼
integrations/
  ├─ mod.rs            observation snapshot (GET / WS hello+fetch only)
  ├─ lease.rs          persisted keep-alive lease + stale math
  ├─ live.rs           supervisor: ping, poll, reconnect, resume after crash
  ├─ actions.rs        allowlisted Paseo RPC + Anneal POST
  └─ commandcode.rs    health/models + owned process + registration plan
        │
        ▼
DataStore profiles.json
  ├─ control_board          (unchanged)
  └─ integration_leases     (new, default empty)
app_secrets["integration"]  (optional Remember credentials)
```

Keep-alive 循环在 `setup()` 里启动，不依赖页面可见性。Paseo 使用稳定 `clientId`（`coding-tools-observer-<uuid>` 写入租约）。重连只刷新目录，不创建 agent。

---

## 数据模型

| 实体/字段 | 类型 | 约束 | 说明 |
|-----------|------|------|------|
| IntegrationLease.endpoint | String | 字面 loopback，最长 512 | daemon/API/proxy |
| IntegrationLease.web_ui | String | 可空，字面 loopback HTTP | iframe 源 |
| IntegrationLease.keep_alive | bool | 默认 false | 崩溃后是否恢复 |
| IntegrationLease.client_id | Option\<String\> | Paseo 稳定 id | 防漂移 |
| IntegrationLease.last_ok_at | Option\<u64\> | unix 秒 | 计算 stale |
| IntegrationLease.last_error | Option\<String\> | 最长 512，无凭据 | 操作员可见 |
| IntegrationLease.status | String | connected/reconnecting/stale/disconnected/error | UI 状态 |
| IntegrationLease.commandcode_bin | Option\<String\> | 安全可执行路径 | owned start |
| Item.persistence_session | Option\<String\> | 来自 agent.persistence.sessionId | resume handle |
| Item.pending_permission_id | Option\<String\> | 首个 pending permission id | approve/deny |
| Snapshot.read_only | bool | 一次性 read 仍为 true；live 为 false | 不再写死前端字面量 |

凭据：默认只在 `live` 监督器 RAM；Remember 时写入 `app_secrets["integration"][source]`，永不写入 localStorage 或日志。

---

## API 设计

| 方法/函数 | 路径/签名 | 入参 | 出参 | 关联需求 |
|-----------|-----------|------|------|----------|
| integration_live_connect | Tauri | source, endpoint, web_ui, credential, keep_alive, remember | LiveStatus | FR-2, FR-3, FR-5 |
| integration_live_disconnect | Tauri | source | LiveStatus | FR-6 |
| integration_live_status | Tauri | 无 | 三个来源的 LiveStatus | FR-6 |
| integration_act | Tauri | source, action, payload | ActResult | FR-2, FR-3 |
| commandcode_proxy_status | Tauri | endpoint | 含 health、banner、models | FR-4 |
| commandcode_proxy_control | Tauri | action, endpoint, bin | 进程状态 | FR-4 |
| commandcode_proxy_apply | Tauri | 不变 | 不变 | FR-4 |
| backoff_delay | Rust | attempts | Duration ≤ 60s | FR-5 |
| classify_status | Rust | last_ok, now, error | status enum | FR-6 |

Paseo `integration_act` payload 例子：

- `{ "op":"send", "agent_id":"…", "text":"…" }`
- `{ "op":"resume", "agent_id":"…", "provider":"codex", "session_id":"…" }`
- `{ "op":"cancel"|"archive", "agent_id":"…" }`
- `{ "op":"permission", "agent_id":"…", "request_id":"…", "behavior":"allow"|"deny" }`
- `{ "op":"create", "provider":"codex", "cwd":"…", "prompt":"…" }`

Anneal：

- `{ "op":"start"|"retry"|"archive"|"unarchive"|"hold"|"resume", "task_id":"…" }`
- `{ "op":"inbox_decision"|"inbox_reply"|"inbox_close", "message_id":"…", "text":"…" }`

未在允许名单的 op 直接拒绝。

---

## 文件结构

```
docs/specs/focused-rc11-lane/requirements.md
docs/specs/focused-rc11-lane/design.md
docs/specs/focused-rc11-lane/tasks.md
docs/features/paseo-anneal-commandcode-longrun.md
src-tauri/src/integrations/lease.rs
src-tauri/src/integrations/live.rs
src-tauri/src/integrations/actions.rs
src-tauri/src/integrations/commandcode.rs          (修改)
src-tauri/src/integrations/mod.rs                  (修改)
src-tauri/src/integrations/tests.rs                (修改)
src-tauri/src/commands/control_center.rs           (修改)
src-tauri/src/commands/mod.rs                      (修改)
src-tauri/src/lib.rs                               (修改)
src-tauri/src/data/model.rs                        (修改)
src-tauri/tauri.conf.json                          (CSP)
src/lib/control-center/model.ts                    (修改)
src/lib/control-center/state.ts                    (修改)
src/lib/control-center/upstreams.json              (修改)
src/lib/components/control-center/OriginalFrame.svelte
src/lib/components/control-center/PaseoPanel.svelte
src/lib/components/control-center/AnnealPanel.svelte
src/lib/components/control-center/CommandCodeProxyPanel.svelte (修改)
src/lib/components/control-center/SourceDetail.svelte (修改)
src/routes/integrations/+page.svelte               (修改)
src/routes/sessions/+page.svelte                   (修改)
src/routes/work/+page.svelte                       (修改)
src/app.css                                        (修改)
scripts/check-control-center.mjs                   (修改)
```

---

## 设计决策

### 决策 1: 嵌入原版 Web，而不是重写整个 UI（关联需求: FR-2, FR-3）

**问题**: 原版 Paseo/Anneal 是完整应用；在 Svelte 里复刻每一屏会漏功能和漂移视觉。

**选项**:
1. Iframe 原版 loopback Web，原生控件做连接/允许名单动作。
2. 完整移植 Expo/Hono 前端到 Svelte。

**决策**: 选择选项 1。

**理由**: 业主要求原版 UI + 原版功能，同时禁止不安全地打包整套引擎。iframe 使用正在运行的上游 UI；原生 RPC/POST 覆盖 iframe 不可用时的会话/看板操作。CSP 只放行字面 loopback。

### 决策 2: 允许名单动作，而不是开放任意 RPC（关联需求: FR-2, FR-3, NFR-2）

**问题**: Paseo messages.ts 含 shutdown_server、write_project_config、checkout_pr_merge 等；Anneal 含 DELETE 与 merge-tail。

**选项**:
1. 透传任意 JSON。
2. 固定允许名单。

**决策**: 选择选项 2。

**理由**: 外科式对等「原版暴露且操作员日常需要的控制」，不把 Coding Tools 变成上游超级客户端。

### 决策 3: CommandCode Start 强制 loopback 且只杀 owned 进程（关联需求: FR-4）

**问题**: 上游默认 `HOST=0.0.0.0`；端口上可能已有用户自己启动的代理。

**选项**:
1. 按上游默认绑 0.0.0.0，并按端口杀进程。
2. 强制 `HOST=127.0.0.1`，Stop 只杀自己 spawn 的 Child。

**决策**: 选择选项 2。

**理由**: 与现有 Integrations 的 loopback 边界一致；避免误杀或把代理暴露到局域网。

### 决策 4: 观察路径与动作路径分文件（关联需求: FR-7, NFR-3）

**问题**: `check-control-center.mjs` 现在断言 `integrations/mod.rs` 不含 POST/create_agent。

**选项**:
1. 放宽整文件断言。
2. 把动作放到 `actions.rs`，观察快照仍保持只读。

**决策**: 选择选项 2。

**理由**: 一次性 snapshot 契约可继续测；允许名单动作有独立测试夹具。

---

## 测试策略

- Rust：退避封顶与稳定清零；stale 阈值；lease 加性反序列化；Paseo 夹具断言只发送允许名单 RPC 且 requestId 关联；Anneal 夹具断言只打允许名单 POST；CommandCode health 无 Authorization、Start 环境含 `HOST=127.0.0.1`、非 owned Stop 失败。
- Node：`scripts/check-control-center.mjs` 覆盖 iframe 路由、banner 字段、状态机、且 `mod.rs` 仍无任意 POST。
- 手测（有本机服务时）：Paseo iframe `/sessions`；Anneal `#/tasks`；CommandCode Check/Start；断网后看 reconnect/stale。

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| iframe 把上游 XSS 引进 WebView | 中 | 仅 loopback CSP；sandbox 限制；不嵌入非本机 URL |
| 允许名单仍可能驱动外部 agent 消耗配额 | 中 | UI 明示；不自动 create；重连不发 prompt |
| Remember 凭据写入 profiles.json | 中 | 默认关闭；与现有 app_secrets 同档；文档说明 |
| GitNexus 运行时在本环境不可用 | 低 | 人工限定 diff 到 control-center；不碰 CPA/shell |
| 与 `#178` Electron 车道语义重叠 | 低 | 本 PR 只改 main Svelte/Tauri；分支名含 longrun-939e |

---

## 检查清单

- [x] 技术方案与现有架构一致
- [x] requirements.md 中每条 FR 都被本设计覆盖（或注明不涉及）
- [x] 文件结构对照真实代码库，路径可定位
- [x] 数据模型 / 接口契约清晰（含类型与约束）
- [x] 关键设计决策已记录并关联需求
- [x] 测试策略可验证验收标准
