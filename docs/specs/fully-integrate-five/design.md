# 设计文档：fully-integrate-five

## 概述

在最新 `main` 上落地 already-approved **Option A — one-app managed**：Coding Tools Electron Desktop 作为唯一控制面，托管 Codex Router、CPA、CommandCode Proxy、Paseo、Anneal。实现路径是合并 `integration/v0.7.0-rc.9-one-app-tool-panels-merge`，再并入 #185 bootstrap，按 #189 纪律把产品身份改为 `0.7.0-rc.11`，并修掉仍让栈看起来“已完成”的半接线（错误默认端口、缺失 bootstrap、Paseo 执行口与 listen 口不一致）。

**对应需求:** FR-1, FR-2, FR-3, FR-4, FR-5, NFR-1, NFR-2, NFR-3, NFR-4

---

## 技术方案

### 技术选型

| 类别 | 选择 | 理由 | 关联需求 |
|------|------|------|----------|
| 产品线 | 把 Electron `desktop-electron/` 合入 main，保留 Tauri 0.4.11 | 五栈 supervisor 已在 Electron；Tauri 没有等价 `managed-components.cjs` | FR-1, NFR-3 |
| 架构 | 继续 one-app managed，不平行新写 Tauri supervisor | #182 已批准；用户禁止再发明架构 | FR-1, FR-2 |
| 生命周期 | `managed-components.cjs` + `managed-external-services.cjs` + `original-ui.cjs` | 已有 install/start/stop/inspect IPC | FR-2 |
| 编排 | 并入 #185 `managed-bootstrap.cjs` | tool-panels tip 还没有 Install-all 依赖图 | FR-3 |
| 发版身份 | 复制 #189 的 rc.10 lane 模式升 rc.11 | 避免 force-move 冻结 tag | FR-4 |
| 测试 | 现有 `desktop-electron/tests/*five-stack*`、bootstrap、identity、CommandCode 脚本 | 契约测试可在无真实上游二进制时锁端口与 IPC | FR-5 |

### 架构设计

```text
main (Tauri 0.4.11 Integrations)
  CommandCodeProxyPanel -> commandcode_proxy_status / apply  (保留 #181)
  Paseo/Anneal -> integration_read 唯读快照          (保留)

Electron Desktop 0.7.0-rc.11 (合入后的真实五栈控制面)
  App.tsx Integrations group
    OriginalUiSurface (CPA management.html + Codex Router Control Center)
    ExternalServicesSurface / UpstreamToolSurface
      CommandCodeProxySurface  start/stop/health banner
      Paseo iframe 真实 /sessions /open-project /settings
      Anneal iframe 真实 #/tasks ...
  preload.cjs
    installManagedComponent / startExternalService / startOriginalUi
    managed bootstrap install-all
  main.cjs IPC
    launcher:managed-component-*
    launcher:external-service-*
    launcher:original-ui-*
  managed-bootstrap.cjs
    CPA -> (Codex Router || CommandCode) -> Paseo -> Anneal
  managed-components.cjs
    vendor/managed-components/{codex-router,cpa,commandcode-proxy,paseo,anneal}.json
      prepare/run 写入 state + 生成密钥 + spawn loopback
```

冲突预期（merge-tree 已见）：

- `runtime-web/scripts/commandcode-proxy-provider.ts` add/add：保留双方导出，默认口与 Electron managed `9090` 对齐，同时保留 Tauri 计划函数。
- `src-tauri/src/lib.rs` / `integrations/mod.rs` / `data/mod.rs` / `oauth_authorization_response.rs`：保留 main 的 OAuth issuer 与 #181 CommandCode 命令，并保留 one-app execution 模块（若存在）。

---

## 数据模型

不新增用户可见 profile 密钥字段。沿用 managed state root：

| 实体/字段 | 类型 | 约束 | 说明 |
|-----------|------|------|------|
| `vendor/managed-components/*.json` | pinned manifest | schemaVersion 1，checksum/commit 固定 | 安装与健康的唯一权威 |
| CPA `state/config.yaml` | YAML | host 127.0.0.1 port 8317 | Start 时由 `cpa-managed.cjs` 写入 |
| CommandCode env | PROXY_HOST/PORT/API_KEY | PORT=9090 | 进程环境，密钥仅 main process |
| Paseo `PASEO_LISTEN` | `127.0.0.1:6768` | loopback | HTTP UI/health |
| Paseo `executionEndpoint` | WebSocket loopback | 必须等于实际 WS | 禁止广告未启动的 6767（除非测试证明双绑） |
| Anneal `{state}/config/.env` | dotenv | 600 权限 | 可替换源码之外的持久配置 |
| Electron `PRODUCT_IDENTITY.version` | `0.7.0-rc.11` | 与 package.json 一致 | 发版闸门 |
| Tauri `package.json` version | `0.4.11` | 稳定 X.Y.Z | 不随 rc.11 改写 |

---

## API 设计

| 方法/函数 | 路径/签名 | 入参 | 出参 | 关联需求 |
|-----------|-----------|------|------|----------|
| installComponent | `managed-components.installComponent(id)` | 组件 id | 红acted snapshot | FR-2 |
| start/stop/restart | `managed-external-services` / `original-ui` | 组件 id | snapshot + health | FR-2 |
| bootstrap | `managed-bootstrap` install-and-start-all | 无密钥 | 分组件 progress | FR-3 |
| inspect | HTTP(S) loopback GET | 允许状态码列表 | ready/degraded/error | FR-2 |
| commandcode_proxy_status | Tauri invoke | loopback endpoint | reachable + model_count | FR-1 |
| commandcode_proxy_apply | Tauri invoke | router/curate CLI | 非密钥 add/enable/curate | FR-1 |
| Windows publish | `RELEASE_TAG=v0.7.0-rc.11` | 源 SHA | GitHub prerelease | FR-4 |

---

## 文件结构

```text
coding-tools-mcp/
├── desktop-electron/                          # 从 one-app 合入
│   ├── electron/managed-components.cjs
│   ├── electron/managed-external-services.cjs
│   ├── electron/managed-bootstrap.cjs         # 从 #185 并入
│   ├── electron/cpa-managed.cjs
│   ├── electron/codex-router-managed.cjs
│   ├── electron/original-ui.cjs
│   ├── electron/product.cjs                   # version -> 0.7.0-rc.11
│   ├── vendor/managed-components/*.json
│   └── tests/rc9-managed-five-stack.test.cjs 等
├── src/routes/integrations/+page.svelte       # 保留 Tauri #181
├── src-tauri/src/integrations/                # 冲突时两边真实 IPC 都保留
├── .github/workflows/codex-router-multiprovider-release-rc11.yml
├── aiTemp/rc11-release/
├── docs/releases/v0.7.0-rc.11.md
└── docs/specs/fully-integrate-five/
```

---

## 设计决策

### 决策 1: 合入 Electron one-app，而不是在 Tauri 重写 supervisor（关联需求: FR-1, FR-2）

**问题**: main 没有 CPA/Codex Router 进程托管；one-app 有完整 Electron 实现。

**选项**:
1. 在 Tauri 重写五栈 install/start/stop。
2. 把 one-app Electron 线 rebase/merge 到 main，补缺口。

**决策**: 选择选项 2。

**理由**: 用户要求继续既有 one-app 设计，禁止平行架构；merge-tree 仅约 5 个冲突文件，可行。

### 决策 2: 新建 rc.11 lane，冻住 rc.10（关联需求: FR-4）

**问题**: rc.8/rc.9/rc.10 tag 已发布；Windows rc.10 已成功。

**选项**:
1. 在 rc.10 workflow 上改 version 并重打 tag。
2. 复制 #189 模式新增 rc.11 workflow 与 notes。

**决策**: 选择选项 2。

**理由**: #189 的失败模式就是 workflow 仍指向旧 tag。

### 决策 3: CommandCode 默认口统一 9090（关联需求: FR-3）

**问题**: Tauri 计划默认 3050，managed 监听 9090，Orchestrator 仍可能显示 3050。

**选项**:
1. 让 managed 改听 3050。
2. 所有 Desktop 默认与托管口 9090 对齐，3050 仅作高级覆盖。

**决策**: 选择选项 2。

**理由**: one-app manifest 与 health 已经钉在 9090；改回 3050 会打坏已有五栈测试。

### 决策 4: Paseo 执行口必须命中 managed 进程（关联需求: FR-3）

**问题**: health 6768 vs execution 6767。

**选项**:
1. 保持双口并额外启动 6767。
2. 若 `PASEO_LISTEN` 只绑一个端口，把 executionEndpoint 改到该端口的 `/ws`。

**决策**: 以进程实际 listen 为准（选项 2，除非代码证明双绑）。

**理由**: 广告未启动端口等于半接线。

---

## 测试策略

- 契约：`rc9-managed-five-stack.test.cjs`、`managed-components-runtime.test.cjs`、`managed-bootstrap.test.cjs`、`original-upstream-panels.test.cjs`、`rc9-managed-cpa-runtime.test.cjs`、`five-stack-routing-completion.test.cjs`、identity tests。
- Tauri：`scripts/check-commandcode-proxy.mjs`、`src-tauri` integrations 测试（若本环境可编）。
- Identity：新 `rc11-release-identity.test.cjs` 断言 workflow 不含 force、tag 为 v0.7.0-rc.11。
- Live smoke：无 CLIProxyAPI 二进制 / 无 WSL 时不假装通过；写在 PR 验证步骤。

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 954 commits 合入 main 体积大 | 高 | 只解决已识别冲突；不改无关壳层 |
| Paseo 6767 测试锁定 | 中 | 若改口则同步更新契约测试 |
| Anneal Windows 前置 | 中 | action-required，不显示假 Ready |
| 误 bump Tauri 0.4.11 | 高 | 发版闸门分开；check:version 仍走稳定版 |
| 误移动 rc.10 tag | 高 | 新 lane + 冻 push |

---

## 检查清单

- [x] 技术方案与现有架构一致
- [x] requirements.md 中每条 FR 都被本设计覆盖（或注明不涉及）
- [x] 文件结构对照真实代码库，路径可定位
- [x] 数据模型 / 接口契约清晰（含类型与约束）
- [x] 关键设计决策已记录并关联需求
- [x] 测试策略可验证验收标准
