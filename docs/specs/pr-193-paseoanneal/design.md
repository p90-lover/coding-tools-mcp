# 设计文档：pr-193-paseoanneal

## 概述

在 #192 `five-stack-control-plane.cjs` 的 in-memory Paseo→Anneal 循环上，增加 **服务可用性感知的 backend 选择** 与 **真实 Anneal BACKLOG HTTP 交接**。CPA :8317 与 Router :4202 只作为 URL 常量消费，端口归属 #194。CommandCode 继续 9090/3050。

**对应需求:** FR-1, FR-2, FR-3, FR-4, NFR-1, NFR-2, NFR-3

---

## 技术方案

### 技术选型

| 类别 | 选择 | 理由 | 关联需求 |
|------|------|------|----------|
| 控制面 | 扩展现有 `createFiveStackControlPlane` | 不复制 #192 工具名/MCP catalog | FR-1, NFR-3 |
| 可用性 | 读 `getServicesSnapshot()` 的 status/running | 避免每次 plan 再跑 12s inspect | NFR-1 |
| Anneal HTTP | `upstream-actions` 允许名单 + 可选 `handoffAnnealTask` | 与 Tauri protocol.rs BACKLOG 体对齐 | FR-3 |
| 端口 | 继续 `FIVE_STACK_ENDPOINTS` | 不改 8317/4202 | FR-4 |

### 架构设计

```
paseo_plan
  → provider-execution-router (unchanged catalog)
  → preferredBackend(providerId, availability)
       commandcode-proxy → 9090/v1
       CPA-lane + cpa ready → 8317/v1
       Router-lane + router ready → 4202/v1
       else other in-app /v1, last CommandCode 9090/v1
paseo_run / paseo_submit_result / paseo_review   (#192 loop, unchanged names)
anneal_open_from_review
  → local BACKLOG record
  → if Anneal ready: POST /projects/{id}/tasks (approvalGate, opensPullRequest false)
anneal_preview
  → GET /tasks/{id} when posted, else local record
```

---

## 数据模型

| 实体/字段 | 类型 | 约束 | 说明 |
|-----------|------|------|------|
| availability.cpa | boolean | derived | snapshot status ready or running |
| availability.router | boolean | derived | 同上 |
| availability.commandcode | boolean | derived | 不改变 9090 绑定 |
| route.backend | string URL | loopback `/v1` | 实际选用的后端 |
| route.backendKind | `cpa` / `router` / `commandcode` | required | 便于测试与 UI |
| route.backendFallback | boolean | default false | 非首选后端 |
| annealTask.state | `BACKLOG` | not TODO | owner 契约 |
| annealTask.handoff.posted | boolean | required | 是否打到 Anneal :3000 |
| annealTask.handoff.remoteId | string or null | optional | 远程 task id |
| annealTask.approvalGate | boolean | true | 与 protocol.rs 一致 |
| annealTask.opensPullRequest | boolean | false | 与 protocol.rs 一致 |

不涉及持久 DB；记录仍在 control-plane 内存 Map，另加 HTTP 副作用。

---

## API 设计

| 方法/函数 | 路径/签名 | 入参 | 出参 | 关联需求 |
|-----------|-----------|------|------|----------|
| preferredBackend | `preferredBackend(providerId, backends, availability)` | provider id + flags | `{ url, kind, fallback }` | FR-1, FR-2 |
| stackAvailability | `stackAvailability(snapshot)` | services snapshot | `{ cpa, router, commandcode, anneal }` | FR-1 |
| annealHandoffBody | `annealHandoffBody(review, findings, input)` | review + projectId | BACKLOG JSON | FR-3 |
| annealPost create | `POST /projects/{id}/tasks` | BACKLOG body | HTTP status + id | FR-3 |
| annealGet preview | `GET /tasks/{id}` | task id | JSON task | FR-3 |
| annealGet board | `GET /tasks` | view=board optional | list | FR-3 |

`paseo_plan` / `anneal_open_from_review` / `anneal_preview` 工具名不变。

---

## 文件结构

```
desktop-electron/
├── electron/five-stack-control-plane.cjs   修改 preferredBackend + handoff
├── electron/upstream-actions.cjs           允许名单 POST create + GET
├── electron/main.cjs                       注入 handoffAnnealTask
├── tests/five-stack-control-plane.test.cjs 可用性与 BACKLOG
└── tests/upstream-actions.test.cjs         create/preview 允许名单
docs/specs/pr-193-paseoanneal/              本规格
```

不修改 `vendor/managed-components/cpa.json`、`codex-router.json` 端口。

---

## 设计决策

### 决策 1: 可用性来自 snapshot 而非同步 inspect（关联需求: FR-1, NFR-1）

**问题:** 每次 `paseo_plan` 若 inspect CPA/Router 会叠加超时。

**选项:**
1. 每次 plan 调用 `inspectService`
2. 读已有 `getServicesSnapshot()`

**决策:** 选择 2

**理由:** Integrations 面板与 keep-alive 已刷新 status；plan 只消费，不抢 #194 健康检查。

### 决策 2: Anneal 不可用时本地 BACKLOG 而不是失败关闭（关联需求: FR-3）

**问题:** review 有 findings 但 Anneal 未 Start。

**选项:**
1. 直接 throw
2. 本地 BACKLOG + `handoff.posted: false`

**决策:** 选择 2

**理由:** 与 “when available” 一致；UI 仍能预览结构；Anneal Start 后可再 POST（本次不强制重试队列）。

### 决策 3: 不改 8317/4202（关联需求: FR-4）

**问题:** 编排器需要 CPA/Router 后端。

**选项:**
1. 本车道重绑端口
2. 只引用 `FIVE_STACK_ENDPOINTS`

**决策:** 选择 2

**理由:** #194 是 SoT。

---

## 测试策略

- 单测 `preferredBackend`：CPA ready → 8317；Router ready + chatgpt-web → 4202；commandcode-proxy → 9090；两者 down → 9090 fallback
- 单测 `anneal_open_from_review`：mock POST 收到 BACKLOG body；无 findings 拒绝；Anneal down 本地 BACKLOG
- 单测 upstream-actions 允许 `/projects/{id}/tasks` 与 GET `/tasks/{id}`
- 回归：现有 five-stack-control-plane、loopback-mesh、Check/Copy/Apply 端口断言仍过
- 静态：`cpa.json` health 仍含 `:8317`，router 仍含 `:4202`

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| #192 测试仍断言 Anneal `state: review` | 中 | 改为 BACKLOG 并注明 owner 契约 |
| Anneal projectId 缺失 | 中 | `projectId` 入参，缺省 workspaceId 的安全 token |
| 被误认为改 CPA/Router 端口 | 高 | 测试断言端口字面量不变 |

---

## 检查清单

- [x] 技术方案与现有架构一致
- [x] requirements.md 中每条 FR 都被本设计覆盖（或注明不涉及）
- [x] 文件结构对照真实代码库，路径可定位
- [x] 数据模型 / 接口契约清晰（含类型与约束）
- [x] 关键设计决策已记录并关联需求
- [x] 测试策略可验证验收标准
