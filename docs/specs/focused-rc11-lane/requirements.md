# 需求文档：focused-rc11-lane

## 功能概述

在当前 `main`（0.4.11 / Coding Tools Desktop，rc.10 已装到业主 Windows）上做一次聚焦 rc.11+ 交付：把 Integrations 里的 **Paseo、Anneal、CommandCode Proxy** 从「观察快照 / 注册计划」升级到 **原版 UI 可嵌入 + 原版可调用功能**，并加上可撑过 **7 天长任务** 的保活、断线重连、崩溃恢复与过期状态。不并入 CPA / Codex Router 独占编辑器，不改 Desktop 主壳 sidebar-only 工作。

## 历史经验与坑

- **可复用经验**: `#181` 已在 main 接入 CommandCode 可调用注册计划与 loopback GET；Paseo/Anneal 已有协议 v1 hello + `fetch_agents_request`、Anneal `GET /tasks?view=board&archived=false`、loopback 端点校验、主窗口 Tauri 命令、`control_board` 加性字段与 `scripts/check-control-center.mjs`。隧道 `Recovery` 已有退避上限与稳定后清零。
- **必须规避的坑**: 不要把 `#178` / `#188` 的 0.7 Electron iframe 整树并回 main；不要改 CPA、Codex Router 专属栏、extension HUD；Coding Tools 永不接收 CommandCode `user_*`；不要打包 Paseo daemon / Anneal runner / merge-executor；Anneal 上游非原生 Windows，远程 API 仍须使用者自管 loopback 转发；`frame-src 'none'` 必须只对字面 loopback 放开，不能变成任意站点 iframe。

## 术语定义

- **原版 UI**: 已运行的上游 Web 表面。Paseo Expo 路由 `/sessions`、`/open-project`、`/settings`（默认 `http://127.0.0.1:6768`）。Anneal hash 路由 `#/tasks`、`#/projects`、`#/inbox`（默认 `http://127.0.0.1:3000/`）。CommandCode Proxy 无 HTML dashboard，原版表面是 CLI banner（version、listen、Cursor `/v1`、`ANTHROPIC_BASE_URL`）。
- **原版功能**: 上游已暴露、且本应用以允许名单调用的控制。Paseo protocol v1：`send_agent_message_request`、`resume_agent_request`、`cancel_agent_request`、`archive_agent_request`、`agent_permission_response`、`create_agent_request`。Anneal HTTP：`POST /tasks/:id/start|retry|archive|unarchive`、`POST /tasks/:id/chain/hold|resume`、`GET /inbox/messages`、`POST /inbox/messages/:id/decision|reply|close`。CommandCode：`GET /health`、`GET /v1/models`、本机已配置二进制的 Start/Stop/Restart、既有 generic-provider 注册计划。
- **Keep-alive**: 操作员打开后由桌面进程维持的连接，不依赖 Integrations 页是否可见。
- **Stale**: 上次成功 round-trip 超过阈值后，UI 必须标明过期，不得把旧快照当 live。
- **Owned process**: 仅 Coding Tools 自己 spawn 的 CommandCode 子进程可 Stop；不杀端口上的外来 PID。

---

## 范围边界

**In Scope（本次要做）**

- 盘点并在功能文档写清与原版 Paseo / Anneal / CommandCode Proxy 的差距。
- Integrations / Sessions / Work board 内嵌原版 loopback Web UI（服务可达时全幅显示），同时保留原生连接与允许名单控件。
- 接通上述允许名单原版功能；权限批准、发消息、resume/cancel/archive、Anneal start/hold/resume/inbox decision 必须是真实 IPC，不是装饰按钮。
- CommandCode 面板显示原版 banner，Check 读 `/health` 与 `/v1/models`，可选 Start/Stop/Restart 仅针对 owned loopback 进程；保留 `#181` 注册计划。
- 7 天耐久：WS/HTTP 断开后指数退避重连（封顶、抖动、无刷屏日志）、崩溃后按已保存 keep-alive 租约恢复、过期状态可见。凭据默认仍只在 RAM；显式 Remember 才写入既有 `app_secrets`。
- 契约测试与 focused PR（rc.11+ lane，分支名不与 CPA / Desktop-shell 冲突）。

**Out of Scope（本次不做）**

- 打包或启动完整 Paseo daemon、Anneal runner/scheduler/merge-executor、CommandCode 上游推理引擎。
- 收集或保存 CommandCode `user_*` / 把本应用做成第二个聊天客户端去转发 `/v1/chat/completions`。
- 修改 CPA、Codex Router 独占编辑器、Desktop 主壳导航信息架构、extension HUD。
- 合并 `desktop-electron/**` 或重开已关闭的 `#121`。
- Paseo relay/voice/pairing、Anneal `DELETE` 任务、merge-tail repair、任意 HTTP 方法。

---

## 需求列表

### FR-1: 原版差距盘点可见

**优先级:** Must
**用户故事:** 作为维护者，我想在仓库里看到 Paseo / Anneal / CommandCode 当前 Integrations 与原版的差距表，以便评审这次是功能对等而不是装饰。

#### 验收标准（EARS）

1. WHEN 打开 `docs/features/paseo-anneal-commandcode-longrun.md` THEN 系统 SHALL 列出每个应用的原版表面、当前 main 缺口、本次接通的允许名单，以及明确未打包的引擎。
2. WHEN 打开 Integrations THEN 系统 SHALL 不再把三个面板标成「Read-only adapters」总徽章。

### FR-2: Paseo 原版 UI 与原版会话功能

**优先级:** Must
**用户故事:** 作为操作员，我想在 Coding Tools 里看到并操作已运行的 Paseo 会话，而不只是目录快照。

#### 验收标准（EARS）

1. WHEN Paseo Web UI 在字面 loopback（默认 `http://127.0.0.1:6768/sessions`）可达 THEN 系统 SHALL 在 Integrations 与 Agent sessions 嵌入该原版路由，且不得使用虚构路径 `/agents` 或 `/voice`。
2. WHEN 操作员对已连接 daemon 发送消息、Resume、Cancel、Archive、Allow/Deny 待批准、或 Create（provider+cwd+prompt）THEN 系统 SHALL 只发送对应 protocol v1 RPC（`send_agent_message_request`、`resume_agent_request`、`cancel_agent_request`、`archive_agent_request`、`agent_permission_response`、`create_agent_request`），并使用关联 `requestId`。
3. IF 端点不是字面 `127.0.0.1` / `[::1]` THEN 系统 SHALL 拒绝连接与 iframe。
4. IF daemon 拒绝 RPC THEN 系统 SHALL 显示错误，且不得假装已执行。

### FR-3: Anneal 原版 UI 与看板 / Inbox 功能

**优先级:** Must
**用户故事:** 作为操作员，我想在 Coding Tools 里打开原版 Anneal 看板并执行 start/hold/resume/inbox 决策。

#### 验收标准（EARS）

1. WHEN Anneal Web 在 loopback 可达 THEN 系统 SHALL 嵌入 hash 路由 `#/tasks`（可切换 `#/projects`、`#/inbox`），不得打开会 404 的 `/tasks` 路径式 iframe。
2. WHEN 操作员对已连接 API 执行 start、retry、archive、unarchive、chain hold、chain resume、inbox decision/reply/close THEN 系统 SHALL 只对允许名单路径发 POST，并带上 operator token（若已配置）。
3. IF Anneal 返回非成功 HTTP THEN 系统 SHALL 显示状态码/拒绝原因，任务不得被标成已完成。
4. WHEN 渲染 Windows 说明 THEN 系统 SHALL 保留可复制的 `ssh -N -L 3000:127.0.0.1:3000 user@host` 提示，因为上游不是原生 Windows。

### FR-4: CommandCode Proxy 原版 banner 与进程控制

**优先级:** Must
**用户故事:** 作为操作员，我想在 Integrations 看到原版 CLI banner，并检查 / 启动 / 停止本机代理，同时继续复制非密钥注册计划。

#### 验收标准（EARS）

1. WHEN 打开 CommandCode 面板 THEN 系统 SHALL 显示 version（若可知）、listen URL、Cursor `.../v1`、`ANTHROPIC_BASE_URL` 等价环境行，而不是只显示 generic 表单。
2. WHEN 点击 Check THEN 系统 SHALL 对 loopback 发 `GET /health` 与 `GET …/v1/models`，不发送 Authorization。
3. WHEN 操作员提供通过安全规则的本机二进制并 Start THEN 系统 SHALL 以 `HOST=127.0.0.1` spawn owned 子进程；Stop/Restart 只作用于该子进程。
4. IF 端口上的进程不是 owned THEN 系统 SHALL 拒绝 Stop，并说明需要在原启动处停止。
5. WHEN Copy / Dry-run / Apply non-secret THEN 系统 SHALL 保持 `#181` 行为：永不执行 `credential set`，永不收集 `user_*`。

### FR-5: 7 天保活、重连与崩溃恢复

**优先级:** Must
**用户故事:** 作为操作员，我想这三个整合在多日任务中自动重连，崩溃后能按租约恢复，而不是刷屏或漂移出新的 agent。

#### 验收标准（EARS）

1. WHEN keep-alive 已打开且 WS/HTTP 断开 THEN 系统 SHALL 用指数退避重连（1s 起、封顶 60s、加抖动），成功稳定 120s 后清零计数。
2. WHEN 重连 Paseo THEN 系统 SHALL 复用已保存的 `clientId`，只做 hello + 目录/订阅刷新，不得自动 `create_agent_request`。
3. WHEN 桌面进程重启且租约 `keep_alive=true` THEN 系统 SHALL 自动恢复连接；若凭据未 Remember THEN 系统 SHALL 进入需要凭据的可见状态而不是静默成功。
4. WHILE keep-alive 运行 THE 系统 SHALL 不因 Integrations 页不可见而停止 ping/poll。
5. IF 同一来源已有进行中的连接 THEN 系统 SHALL 不并行再开第二条，避免漂移。

### FR-6: 过期状态对操作员可见

**优先级:** Must
**用户故事:** 作为操作员，我想在快照不再 live 时立刻看到 Stale，以免按过期会话做批准。

#### 验收标准（EARS）

1. WHEN 上次成功 round-trip 超过 90s（Paseo live）或 120s（HTTP poll）THEN 系统 SHALL 把状态标为 `stale`，并在 Sessions / Work / Integrations 显示警告。
2. WHEN 连接失败 THEN 系统 SHALL 保留上一份快照并标明失败时间，不得清空证据式记录，也不得把失败显示成绿色可达。
3. IF 操作员 Clear / Disconnect THEN 系统 SHALL 停止 keep-alive 并把状态打成 `disconnected`。

### FR-7: 范围隔离

**优先级:** Must
**用户故事:** 作为并行代理的协调者，我想这次 diff 只动这三个整合，以免和 CPA / Codex Router / Desktop shell 车道碰撞。

#### 验收标准（EARS）

1. WHEN 审查本次 diff THEN 变更 SHALL 限于 control-center 整合、其契约测试与本规格/功能文档。
2. IF 文件属于 `desktop-electron/**`、Codex Router 独占编辑器或主壳导航信息架构 THEN 系统 SHALL 不修改它们。

---

## 非功能需求

- **NFR-1（性能）**: 单次探测/RPC 总时限不超过 8s；keep-alive ping 间隔 20s；HTTP poll 间隔 30s；响应/帧不超过 2 MiB；同时最多两个一次性 integration_read。
- **NFR-2（安全）**: 只允许字面 loopback；iframe CSP 仅 `http://127.0.0.1:*` 与 `http://[::1]:*`；CommandCode Start 强制 `HOST=127.0.0.1`；不持久化 `user_*`；Remember 凭据走既有 `app_secrets`，不写 localStorage。
- **NFR-3（兼容性）**: 不修改 `Source` 枚举值；既有 `control_board` 与 `#181` 注册计划测试继续通过；`integration_leases` 必须是加性默认字段，旧 `profiles.json` 可加载。

---

## 依赖关系

- 上游协议：getpaseo/paseo `da8c1b5c94e752b01d451645e5fa52aba2c1b2f0`；mosonlab/anneal `088f0d5971a1692134aaa3db0230cc541b014c07`；MAXeaglet/commandcode-proxy（`GET /health`、`GET /v1/models`）。
- 既有 main：`integration_read`、`commandcode_proxy_status` / `apply`、`DataStore`、隧道 Recovery 退避模式。
- 并行车道：CPA/Codex Router 由其他代理负责；Desktop shell-only 不在本 PR。

---

## 检查清单

- [x] 已消化记忆库的历史经验，并逐条规避「历史坑」
- [x] 需求覆盖核心场景与边界场景
- [x] 每条需求有唯一 ID（FR-n），将在 design.md / tasks.md 中被引用
- [x] 验收标准使用 EARS 格式且可测
- [x] 已标注优先级（MoSCoW）
- [x] 范围边界（In/Out of Scope）明确
- [x] 非功能需求明确、尽量可量化
- [x] 依赖关系完整
