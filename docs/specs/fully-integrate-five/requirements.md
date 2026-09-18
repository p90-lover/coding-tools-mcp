# 需求文档：fully-integrate-five

## 功能概述

把 Codex Router、CPA / CLIProxyAPI、CommandCode Proxy、Anneal、Paseo 五条栈做成 Desktop 内真正可安装、可启停、可健康检查、配置能到达进程的功能，而不是装饰 UI。交付形态为一条合入 `main` 的 0.7.0-rc.11 PR：在最新 `main`（已含 #181 CommandCode 外科接入与 Paseo/Anneal 唯读观察）上继续既有 **one-app managed** 线（#182/#184/#186/#187/#188），补上尚未并入 tip 的 #185 自动 bootstrap，并按 #189 的发版纪律把 Electron 产品身份升到 `0.7.0-rc.11`，不得移动已冻结的 `v0.7.0-rc.8` / `v0.7.0-rc.9` / `v0.7.0-rc.10` tag。

## 历史经验与坑

- `main` 是 Tauri 0.4.11；五栈完整生命周期在 Electron `desktop-electron/`（0.7.0-rc.9/rc.10 线）。把 one-app 接到 `main` 是合并 Electron 产品，而不是在 Tauri Integrations 上平行再写一套 supervisor。
- #181 明确不把 `desktop-electron/**` 并回 main；本次是用户要求的下一步：完成 one-app 并合入 main，同时保留 #181 的 Tauri CommandCode 注册计划与 Paseo/Anneal `integration_read`。
- #189 证明：产品身份漂到 rc.9 而 workflow 仍打 rc.8 tag 会让 Windows 发版失败。下一版必须新建 rc.11 lane，并把 rc.10 workflow 的 `on.push` 冻成 `workflow_dispatch`。
- CommandCode 端口分叉：Tauri 默认 `3050`，managed Electron 默认 `9090`。Orchestrator 面板若仍写 `3050` 就是死端口。
- Paseo HTTP 健康口是 `127.0.0.1:6768`，执行 WS 仍广告 `ws://127.0.0.1:6767/ws`。若 managed `PASEO_LISTEN` 只绑 6768，执行通道必须指向实际进程，不能假装 6767 已启动。
- Anneal 在 Windows 走 WSL2+Docker；缺前置时必须 `action-required`，不能显示假 Ready。
- 密钥不得进 renderer 状态；CPA management key 只能经 focused-window IPC 复制。
- 不得递归删除既有 runtime；替换走 `Trash/` / `aiTemp/`。

## 术语定义

- **one-app managed**：Coding Tools 是唯一产品 UI；五栈由 `managed-components.cjs` 按 pinned manifest 安装、修复、启停。
- **CPA**：CLIProxyAPI 官方 release 二进制，loopback `127.0.0.1:8317`，多帐户 OAuth 权威。
- **Codex Router**：pinned `duolahypercho/codex-router`，loopback `127.0.0.1:4202`，原版 Control Center 嵌在主窗口。
- **CommandCode Proxy**：pinned git-source 代理，loopback `127.0.0.1:9090`，无 HTML dashboard。
- **Paseo**：pinned git-source daemon；原版 Web UI 走真实 Expo 路由；执行通道是 WebSocket。
- **Anneal**：pinned git-source；postgres + api + runner + web；原版看板是 hash routing。
- **release gate**：Electron `package.json` / `product.cjs` / verify-package / identity tests / exact-source Windows workflow / `docs/releases/v0.7.0-rc.11.md`。

---

## 范围边界

**In Scope（本次要做）**
- 将 `origin/integration/v0.7.0-rc.9-one-app-tool-panels-merge` 合入以最新 `main` 为基的功能分支，解决与 #181 / OAuth issuer 的冲突且不丢任一侧的真实 IPC。
- 并入 #185 的 `managed-bootstrap.cjs` 与契约测试，使 Install/Start 有统一编排而不是五张互不相关的死按钮。
- 五栈各自具备：discover/install-or-embed、start/stop（或等价）、Desktop 健康/状态、配置写入进程、聚焦回归测试。
- 修正已知半接线：CommandCode Orchestrator 默认口、Paseo 执行口与 managed listen 不一致、bootstrap 未进入 tip。
- Electron 身份升到 `0.7.0-rc.11`；新建 rc.11 Windows exact-source workflow；冻住 rc.10 自动 push。
- 保留 Tauri 0.4.11 身份与 #181 Integrations 外科面板。

**Out of Scope（本次不做）**
- 改 Browser / Setup / MCP / Activity / Settings 壳层 chrome，除非 Integrations 页生命周期按钮缺 IPC。
- 把 CommandCode `/v1/chat/completions` 做成聊天客户端。
- 把 Paseo 语音/Relay 或 Anneal 完整 merge engine 伪称为已嵌入。
- 重打或 force-move `v0.7.0-rc.8` / `v0.7.0-rc.9` / `v0.7.0-rc.10`。
- 把 Tauri `package.json` 改成 0.7.0-rc.11。
- 新开第六条半合并 draft PR。

---

## 需求列表

### FR-1: 一条 PR 承接 one-app managed 并合入 main

**优先级:** Must
**用户故事:** 作为维护者，我想在最新 main 上继续已审核的 one-app 设计，以便 Desktop 拥有完整五栈而不是再发明平行架构。

#### 验收标准（EARS）

1. WHEN 功能分支基于 `origin/main` 并合并 `integration/v0.7.0-rc.9-one-app-tool-panels-merge` THEN 仓库 SHALL 同时包含 `desktop-electron/` 托管五栈与 main 上的 Tauri 0.4.11 / #181 CommandCode 注册计划。
2. WHEN 合并冲突出现在 `src-tauri` 或 `runtime-web/scripts/commandcode-proxy-provider.ts` THEN 解决结果 SHALL 保留 main 的 OAuth issuer / RFC 9728 修复，以及 one-app 的 execution / managed 接线。
3. IF 打开 PR THEN 目标 SHALL 是 `main`，标题包含 `feat(rc.11)` 与五栈名称，且不再额外开重叠 draft。

### FR-2: 五栈均可 install/start/stop/health，配置到达进程

**优先级:** Must
**用户故事:** 作为桌面用户，我想从 Coding Tools 安装并启停五条本机栈，并看到真实健康状态，而不需要自己 clone 和手动起服务。

#### 验收标准（EARS）

1. WHEN 用户对 Codex Router、CPA、CommandCode Proxy、Paseo、Anneal 任一组件执行 Install THEN `managed-components` SHALL 按 pinned manifest 完成 discover/install-or-embed，失败时 fail closed 并把失败 staging 移到 Trash 而不是递归删除。
2. WHEN 用户执行 Start 或 Stop THEN Desktop SHALL 通过既有 `launcher:external-service-*` / `launcher:original-ui-*` / managed bootstrap IPC 真正拉起或终止进程，不得留下无 IPC 的死按钮。
3. WHEN 进程已监听 THEN Desktop SHALL 在 Integrations / Original UI / External Services 显示健康或可达状态（Codex Router `127.0.0.1:4202` caller-secret models；CPA `127.0.0.1:8317/v1/models` Bearer；CommandCode `127.0.0.1:9090/v1/models` Bearer；Paseo HTTP `127.0.0.1:6768`；Anneal web `127.0.0.1:5173`）。
4. WHEN Start 成功 THEN 写入进程的配置 SHALL 包含该栈 pinned 端口、loopback host、以及 manifest 声明的密钥/env（CPA `config.yaml`；CommandCode `PROXY_HOST/PORT/API_KEY`；Paseo `PASEO_LISTEN`；Anneal state `.env`；Codex Router caller secret / wrappers）。
5. IF 前置缺失（例如 Anneal 无 WSL2/Docker 或无 GitHub token）THEN 系统 SHALL 报告 `action-required` 或等价错误，不得显示 Ready。

### FR-3: 补齐 #185 bootstrap 与已知半接线

**优先级:** Must
**用户故事:** 作为用户，我想一次 Install and start 按依赖图编排五栈，并且面板上的默认端口就是实际监听端口。

#### 验收标准（EARS）

1. WHEN 合并完成后 THEN `desktop-electron/electron/managed-bootstrap.cjs` 与 `desktop-electron/tests/managed-bootstrap.test.cjs` SHALL 存在于功能分支。
2. WHEN CommandCode 在 Provider Orchestrator 或等价面板显示默认 base URL THEN 该 URL SHALL 使用 managed 监听口 `http://127.0.0.1:9090`，不得再指向未托管的 `3050`。
3. WHEN managed Paseo 以 `PASEO_LISTEN=127.0.0.1:6768` 启动 THEN 执行通道广告的 WebSocket SHALL 指向该进程实际提供的 WS（若 daemon 只绑 6768 则为 `ws://127.0.0.1:6768/ws`；若文档化双绑 6767 则测试必须证明 6767 随 Start 出现）。
4. WHILE 五栈由 bootstrap 编排 THE 系统 SHALL 先 CPA，再并行安全的 Codex Router 与 CommandCode，再 Paseo，最后 Anneal（前置满足时），单个失败不得回滚已健康的独立组件。

### FR-4: 0.7.0-rc.11 发版身份与冻结旧 tag

**优先级:** Must
**用户故事:** 作为发版负责人，我想用新的 rc.11 身份发 Windows 包，以免误改已经成功的 rc.10 tag。

#### 验收标准（EARS）

1. WHEN 检查 Electron 产品身份 THEN `desktop-electron/package.json`、`electron/product.cjs`、prepare/verify-package 脚本与对应 identity 测试 SHALL 均为 `0.7.0-rc.11`。
2. WHEN 添加 exact-source Windows workflow THEN 它 SHALL 设置 `RELEASE_VERSION=0.7.0-rc.11` 与 `RELEASE_TAG=v0.7.0-rc.11`，notes 为 `docs/releases/v0.7.0-rc.11.md`，且不得包含 force-move tag。
3. IF 仓库仍含 rc.10 workflow THEN 其 `on.push` SHALL 被关闭或改为仅 `workflow_dispatch`，避免再打 `v0.7.0-rc.10`。
4. IF 运行 Tauri `npm run check:version` THEN 根 `package.json` SHALL 仍为稳定 `0.4.11`，与 Electron rc.11 分开。

### FR-5: 回归测试覆盖变更包

**优先级:** Must
**用户故事:** 作为维护者，我想用现有契约测试证明五栈不是装饰面板。

#### 验收标准（EARS）

1. WHEN 运行 `desktop-electron` 五栈 / bootstrap / original-ui / CPA / identity 契约测试 THEN 它们 SHALL 通过，或对无法在本环境启动的真实二进制给出书面 blocker。
2. WHEN 变更触及 Tauri Integrations / CommandCode 计划 THEN `scripts/check-commandcode-proxy.mjs` 与相关 Rust 测试 SHALL 通过。
3. IF 某项 live smoke 需要外部二进制或 Windows 签名 THEN 文档 SHALL 写明未跑原因，且不得把未跑当成已验证。

---

## 非功能需求

- **NFR-1（性能）**: Install/Start 进度必须可取消等待的有界步骤；健康探测超时与现有 managed inspect 一致，不得无限挂起 UI。
- **NFR-2（安全）**: 默认仅 loopback；renderer 不持有 management/proxy/caller 明文密钥；OAuth token 不进 snapshot。
- **NFR-3（兼容性）**: 保留 Tauri 0.4.11 发版闸门；Electron 使用独立 0.7.0-rc.11 闸门；冻结 v0.4.10 rollback 与 rc.8/rc.9/rc.10 tag。
- **NFR-4（范围）**: 不改 Browser/Setup/MCP/Activity/Settings 壳，除非 Integrations 生命周期 IPC 缺失。

---

## 依赖关系

- `origin/main` @ #181 / v0.4.11
- `origin/integration/v0.7.0-rc.9-one-app-tool-panels-merge`（#188 tip，含 #178/#184/#186/#187）
- `origin/feature/rc9-one-app-managed-bootstrap-core`（#185，尚未是 tool-panels 祖先）
- #189 rc.10 identity 模式（`cursor/windows-release-rc10-4958`）
- 上游 pinned manifests：Codex Router、CLIProxyAPI v7.3.7、zahidhussaina2l/commandcode-proxy、getpaseo/paseo、mosonlab/anneal

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
