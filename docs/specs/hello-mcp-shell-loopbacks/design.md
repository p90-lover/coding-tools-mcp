# 设计文档：hello-mcp-shell-loopbacks

## 概述

在 Electron Desktop shell 中增加一份冻结的五栈 loopback 图、无密钥健康探测、MCP catalog/call 覆盖，以及 MCP 面板上的监控块。Start 先连 in-app loopback。探测循环带退避、指纹去抖与崩溃重建。

**对应需求:** FR-1, FR-2, FR-3, FR-4, US-1, US-2, US-3, US-4, NFR-1, NFR-2, NFR-3, NFR-4

## 技术方案

### 技术选型

| 类别 | 选择 | 理由 | 关联需求 |
|------|------|------|----------|
| 端口图 | `desktop-electron/electron/five-stack-loopbacks.cjs` | 单一 SoT，shell 与 MCP 共用 | US-1, US-2 |
| 探测循环 | `desktop-electron/electron/five-stack-loopback-probes.cjs` | 只做 shell↔MCP 探测，不碰 #190 keep-alive | US-4 |
| MCP 暴露 | shell-bridge overlay `tools.catalog` / `tools.call` | 不新增五栈 glue 控制面 | US-2 |
| UI | MCP 表面内 `FiveStackLoopbackPanel` | 保留 Browser/Setup/MCP/Activity/Settings | NFR-3 |

### 架构设计

```
MCP panel / Live tools
  -> codingTools.integrations.snapshot  (health, no secrets)
  -> codingTools.tools.catalog/call     (five_stack_status, five_stack_loopbacks, five_stack_start)
  -> coding-tools-shell-bridge
       -> five-stack-loopbacks.probeAll
       -> existing startExternalService (loopback first; no install gate)
  -> five-stack-loopback-probes (quiet reconnect)
```

锁定端口：

| Stack | Origin | Probes |
|-------|--------|--------|
| CPA | `http://127.0.0.1:8317` | `GET /v1/models`；任意 HTTP 响应即 listening |
| Codex Router | `http://127.0.0.1:4202` | TCP/`GET /`；有 caller key 时另探 `/_codex-router/{key}/v1/models`，无 key 仍可报 listening |
| CommandCode | `http://127.0.0.1:9090` | `/health` 与 `/v1/models`；失败则 `127.0.0.1:3050` 同路径 |
| Paseo | `http://127.0.0.1:6768` | protocol v1 HTTP `/`；execution `ws://127.0.0.1:6768/ws`（不再默认 6767） |
| Anneal | `http://127.0.0.1:3000` | tasks API `GET /tasks`；preview `http://127.0.0.1:3000/#/tasks`；健康探测不发 POST |

## 数据模型

不持久化密钥。探测状态仅 RAM：

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | string | 五栈枚举 | cpa / codex-router / commandcode-proxy / paseo / anneal |
| origin | string | loopback URL | 无凭据 |
| listening | boolean | | TCP 或 HTTP 有响应 |
| fallbackUsed | boolean | 仅 CommandCode | 走了 :3050 |
| statusCode | integer or null | | 最近 HTTP 码 |
| error | string or null | 无密钥 | 去抖后的短错误 |

## API 设计

| 方法/函数 | 路径/签名 | 入参 | 出参 | 关联需求 |
|-----------|-----------|------|------|----------|
| probeAll | `five-stack-loopbacks.cjs` | optional fetch/headers | `{ stacks, generatedAt }` | US-1 |
| integrations.snapshot | `coding-tools:integrations:snapshot` | 无 | 五栈健康 JSON | US-1, US-2 |
| tools.catalog overlay | `coding-tools:tools:catalog` | workspaceId | headless catalog ∪ 五栈工具 | US-2 |
| tools.call five_stack_* | `coding-tools:tools:call` | tool + arguments | 无密钥 JSON | US-2, US-3 |
| start(serviceId) | managed-external-services | 栈 id | 先 inspect loopback，不要求 installed | US-3 |

## 文件结构

```
desktop-electron/
├── electron/five-stack-loopbacks.cjs          (new)
├── electron/five-stack-loopback-probes.cjs    (new)
├── electron/coding-tools-shell-bridge.cjs     (modify)
├── electron/external-services.cjs             (Paseo 6768, CommandCode health)
├── electron/managed-external-services.cjs     (Start without install gate)
├── electron/main.cjs                          (start probe supervisor)
├── src/features/FiveStackLoopbackPanel.tsx    (new)
├── src/features/McpLiveToolsPanel.tsx         (reconnect)
├── src/features/ExternalServicesSurface.tsx   (no download-first copy/gate)
├── src/App.tsx                                (mount panel)
├── tests/five-stack-loopbacks.test.cjs        (new)
├── tests/five-stack-loopback-probes.test.cjs  (new)
└── tests/hello-mcp-shell-loopbacks.test.cjs   (new)
```

## 设计决策

### 决策 1: 不复制 #192 control plane（关联需求: NFR-1）

**问题:** #192 已有 `five_stack_manage` / `paseo_plan` glue。

**选项:**
1. 把 control plane 拷进本 PR。
2. 只做端口图 + 健康/Start routing，MCP 工具限于 status/loopbacks/start。

**决策:** 选择 2。

**理由:** 任务明确禁止接管五栈 glue；本 lane 必须能独立 rebase 到 #192/#194。

### 决策 2: listening ≠ HTTP 2xx（关联需求: US-1）

**问题:** CPA/Router 常在无 Bearer/caller key 时返回 401。

**选项:**
1. 仅 2xx 算健康。
2. 任意 HTTP/TCP 响应算 listening。

**决策:** 选择 2，并在快照里保留 `statusCode`。

**理由:** 成功标准是 “when listening”，不是鉴权成功。密钥仍由其他 PR 持有。

## 测试策略

- 单测端口图冻结值与 CommandCode fallback 顺序。
- 单测探测循环：指纹不变不回调；抛错后仍 schedule。
- 契约测试：原始导航仍在；MCP catalog 含五栈工具；Integrations Start 不因 missingCredentials 禁用；Paseo 默认 WS 为 6768。
- 不跑 CPA/Router keep-alive 或 Paseo 引擎套件。

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 与 #192 的 `five_stack_status` 同名 | 中 | 本 lane 工具语义仅健康/loopback/start；rebase 时以只读健康为准，不引入 plan/run |
| 无捆绑运行时 Start 仍失败 | 低 | Start 先探测；失败返回 listening=false，UI 不要求先下载 |
| 探测过密 | 中 | 健康 30s、失败退避至 5min、仅指纹变化发布 |

## 检查清单

- [x] 技术方案与现有 Electron shell 架构一致
- [x] 每条 US/NFR 被覆盖
- [x] 文件结构对照真实代码库
- [x] 接口契约含类型与约束
- [x] 关键设计决策已记录
- [x] 测试策略可验证验收标准
