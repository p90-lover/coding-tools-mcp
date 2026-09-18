# 设计文档：surgical-commandcode-proxy-integration

## 概述

在 main 的 Svelte/Tauri Integrations 上接入 CommandCode Proxy：纯 TypeScript 注册计划（从 0.7 移植）、loopback GET 状态、复制/dry-run/非密钥 apply。Paseo/Anneal 继续走 `integration_read`。

**对应需求:** FR-1, FR-2, FR-3, FR-4, NFR-1, NFR-2, NFR-3

---

## 技术方案

### 技术选型

| 类别 | 选择 | 理由 | 关联需求 |
|------|------|------|----------|
| 计划逻辑 | 移植 0.7 TS 函数到 `$lib`，runtime-web CLI 再导出 | Svelte 不能安全导入 `node:child_process`；CLI 仍保持 0.7 路径 | FR-1 |
| 状态探测 | 新 Tauri 命令 `commandcode_proxy_status` | 与 `integration_read` 隔离，避免改 `Source` | FR-2, NFR-3 |
| Apply | 新 Tauri 命令 `commandcode_proxy_apply`，allowlist argv | 禁止前端传入任意命令 | FR-3, NFR-2 |
| 测试 | 扩展 `scripts/check-control-center.mjs` + Rust 单元/夹具 | 跟随 main 现有契约，不引入 bun | FR-1, FR-2, NFR-3 |

### 架构设计

```
Integrations page
  Paseo/Anneal cards  -> integration_read (unchanged, read_only)
  CommandCodeProxyPanel
      commandCodeProxyRegistrationPlan / renderCommandCodeProxyPlan
      invoke commandcode_proxy_status   -> GET loopback /v1/models
      invoke commandcode_proxy_apply    -> add + enable + curate only
  runtime-web/scripts/commandcode-proxy-provider.ts
      dry-run print or --apply CLI (stdio; credential stays in router prompt)
```

---

## 数据模型

不持久化 CommandCode 状态或密钥。仅内存字段：

| 实体/字段 | 类型 | 约束 | 说明 |
|-----------|------|------|------|
| CommandCodeProxyProviderProfile.id | `"commandcode-proxy"` | 固定 | Codex Router provider id |
| CommandCodeProxyProviderProfile.baseUrl | string | 规范化、无凭据 | 默认 `http://127.0.0.1:3050/v1` |
| CommandCodeProxyProviderProfile.adapter | `"openai-chat"` | 固定 | 与 0.7 一致 |
| CommandCodeProxyStatus.reachable | bool | 由 HTTP 连接/状态得出 | 401 仍算可达 |
| CommandCodeProxyStatus.model_count | Option usize | 仅 200 JSON 成功时 | 有界投影 |
| CommandCodeProxyRegistrationPlan.credentialPromptRequired | true | 固定 | UI 永不收集密钥 |

---

## API 设计

| 方法/函数 | 路径/签名 | 入参 | 出参 | 关联需求 |
|-----------|-----------|------|------|----------|
| commandCodeProxyProviderProfile | TS | baseUrl: string | profile | FR-1 |
| commandCodeProxyRegistrationPlan | TS | baseUrl, routerCli, curateCli | plan | FR-1, FR-3 |
| renderCommandCodeProxyPlan | TS | plan | string | FR-1, FR-3 |
| commandcode_proxy_status | Tauri | endpoint: string | status object | FR-2 |
| commandcode_proxy_apply | Tauri | base_url, router_cli, curate_cli | step results | FR-3 |

`commandcode_proxy_apply` 只重建 add / enable / curate。credential 命令不出现在 Rust 执行列表。

---

## 文件结构

```
coding-tools-mcp/
├── src/lib/control-center/commandcode-proxy-provider.ts
├── src/lib/components/control-center/CommandCodeProxyPanel.svelte
├── src/routes/integrations/+page.svelte
├── runtime-web/scripts/commandcode-proxy-provider.ts
├── scripts/check-commandcode-proxy.mjs
├── scripts/check-control-center.mjs
├── src-tauri/src/integrations/commandcode.rs
├── src-tauri/src/integrations/mod.rs
├── src-tauri/src/integrations/tests.rs
├── src-tauri/src/commands/control_center.rs
├── src-tauri/src/commands/mod.rs
├── src-tauri/src/lib.rs
├── docs/features/commandcode-proxy-control-center.md
└── docs/specs/surgical-commandcode-proxy-integration/
```

---

## 设计决策

### 决策 1: 不扩展 Source 枚举（关联需求: FR-2, FR-4, NFR-3）

**问题**: 把 commandcode 加进 `Source` 会改 `Record<Source,string>`、`integration_read` 和既有夹具。

**选项**:
1. 扩展 `Source` 并复用 `integration_read`
2. 独立 status/apply 命令

**决策**: 选择选项 2

**理由**: Paseo/Anneal 是观察适配器；CommandCode 是 provider 注册。混在同一枚举会扩大 blast radius。

### 决策 2: 计划函数放 `$lib`，CLI 走 runtime-web 路径（关联需求: FR-1）

**问题**: 0.7 脚本顶层导入 `node:child_process`，Svelte/Vite 不能直接吃。

**选项**:
1. 只放 runtime-web，给 Vite 开 extra alias
2. `$lib` 纯函数 + runtime-web 再导出/CLI

**决策**: 选择选项 2

**理由**: 保持 0.7 文件路径，同时让 Integrations 安全导入。

### 决策 3: Apply 永不跑 credential set（关联需求: FR-3, NFR-2）

**问题**: 0.7 `--apply` 会交互式执行 credential。

**选项**:
1. 在 GUI 里复现隐藏提示并收集 `user_*`
2. GUI 只跑非密钥步骤，credential 留在复制的计划里

**决策**: 选择选项 2

**理由**: Coding Tools 明确永不接受 CommandCode 密钥。

---

## 测试策略

- Node 契约：加载 TS 计划模块，复现 0.7 bun 测试的三个断言；页面含 CommandCode 面板；`upstreams.json` 仍为 read_only。
- Rust：拒绝非 loopback；loopback GET `/v1/models` 夹具；apply 命令列表不含 credential。
- 既有 `control_center_*` Paseo/Anneal 测试必须通过。

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 默认端口 3050 与部分文档 9090 不一致 | 中 | 端点可编辑；帮助文本同时写明 |
| 本机没有 model-router | 低 | Apply 返回可读错误；Copy/dry-run 仍可用 |
| GitNexus 运行时不可用 | 低 | 不改 `integration_read`/`Source`，blast radius 保持低 |

---

## 检查清单

- [x] 技术方案与现有架构一致
- [x] requirements.md 中每条 FR 都被本设计覆盖
- [x] 文件结构对照真实代码库，路径可定位
- [x] 数据模型 / 接口契约清晰
- [x] 关键设计决策已记录并关联需求
- [x] 测试策略可验证验收标准
