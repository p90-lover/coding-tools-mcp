# 需求文档：surgical-commandcode-proxy-integration

## 功能概述

在当前 `main`（0.4.11 / HEAD `546fbb37`）上做一次外科式接入：把 0.7 分支上的 CommandCode Proxy Codex Router generic-provider 注册计划移植过来，并在 Integrations 增加可调用的 loopback 状态与复制/执行注册计划。Paseo 与 Anneal 保持既有 `integration_read` 唯读 Connect/snapshot。不合并 0.7 Electron、执行引擎或多帐户栈。

## 历史经验与坑

- **可复用经验**: Integrations 已有 loopback-only 端点校验、主窗口 Tauri 命令和 `scripts/check-control-center.mjs` 纯模块契约检查。
- **必须规避的坑**: 不要把 `#178` 的 Electron iframe/banner 栈并回 main；不要改 `Source` 枚举以免破坏 Paseo/Anneal；Coding Tools 永不接收 CommandCode `user_*` 密钥；`#121` 已关闭，应开聚焦新 PR 而不是复用冲突的 0.7 union。

## 术语定义

- **CommandCode Proxy**: 上游包 `MAXeaglet/commandcode-proxy`，本机 OpenAI 兼容代理。注册计划默认 `http://127.0.0.1:3050/v1`；常见监听亦可能是 `http://127.0.0.1:9090/`。
- **注册计划**: `model-router codex providers generic add/credential/enable` 再加 `curate-models` 的 argv 序列。
- **Dry run**: 只生成并展示计划，不执行 CLI。
- **Non-secret apply**: 只执行 add、enable、curate；永不在应用内执行 credential set，也不收集 `user_*`。

---

## 范围边界

**In Scope（本次要做）**
- 移植 `commandcode-proxy-provider.ts` 与等价测试到从 main 拉出的功能分支。
- Integrations 增加 CommandCode Proxy 面板：loopback 状态、生成/复制/执行注册计划。
- 独立 Tauri 状态探测（GET，不改 `Source` / `integration_read`）。
- Paseo/Anneal 仅做小的 UI 保真（Windows 端口转发复制），保持唯读。
- 用现有 control-center 契约脚本覆盖新计划与页面断言。

**Out of Scope（本次不做）**
- 合并 `desktop-electron/**`、Paseo/Anneal 执行引擎、CPA、Codex Router 独占编辑器、extension HUD、多帐户 Provider Hub。
- 在应用内收集或保存 CommandCode `user_*` / proxy API key。
- 把 CommandCode 做成聊天客户端或伪造 HTML dashboard。
- 重开或扩写已关闭的 `#121`。

---

## 需求列表

### FR-1: 移植 generic-provider 注册计划

**优先级:** Must
**用户故事:** 作为维护者，我想在 main 上拥有与 0.7 相同的 CommandCode Proxy 注册计划函数，以便 Codex Router generic provider 可以按同一 argv 序列接入。

#### 验收标准（EARS）

1. WHEN 以 loopback `http://127.0.0.1:3050/v1/` 调用 `commandCodeProxyRegistrationPlan` THEN 系统 SHALL 产出 id `commandcode-proxy`、adapter `openai-chat`、规范化 `baseUrl` `http://127.0.0.1:3050/v1`，且 add 命令含 `--allow-private`。
2. WHEN 以 HTTPS 远程 URL 调用该函数 THEN 系统 SHALL 不在 add 命令中加入 `--allow-private`。
3. WHEN 渲染计划 THEN 系统 SHALL 说明密钥只在 Codex Router 隐藏提示中输入，且输出不得包含任何 `user_` 前缀密钥。

### FR-2: Integrations loopback 状态

**优先级:** Must
**用户故事:** 作为桌面用户，我想检查本机 CommandCode Proxy 是否在监听，以便确认注册计划指向的服务是活的。

#### 验收标准（EARS）

1. WHEN 用户在 Integrations 点击 Check status 且端点是 `127.0.0.1` 或 `[::1]` THEN 系统 SHALL 对该 loopback HTTP(S) 发起有界 GET（`/v1/models` 或与 base URL 对应的 models 路径），不发送 Authorization。
2. WHEN 连接被拒绝 THEN 系统 SHALL 显示不可达，而不是假装已连接。
3. WHEN 服务返回 HTTP 401 或 200 THEN 系统 SHALL 将服务标为可达（进程在监听）；200 时可显示有界 model 计数。
4. IF 端点不是字面 loopback THEN 系统 SHALL 拒绝探测并提示需要本机端口转发。

### FR-3: 可调用的复制与执行注册计划

**优先级:** Must
**用户故事:** 作为用户，我想复制或执行注册计划，而不是对着装饰性按钮。

#### 验收标准（EARS）

1. WHEN 用户点击 Copy plan THEN 系统 SHALL 把 `renderCommandCodeProxyPlan` 的文本写入剪贴板。
2. WHEN 用户点击 Run dry-run THEN 系统 SHALL 调用同一计划函数并在面板中展示命令，不执行 CLI。
3. WHEN 用户点击 Apply non-secret steps 且 `model-router` / `curate-models` 可执行 THEN 系统 SHALL 只运行 add、enable、curate，永不运行 credential set。
4. IF CLI 不在 PATH 或不满足安全可执行名规则 THEN 系统 SHALL 返回可读错误，按钮保持可点。

### FR-4: 保持 Paseo/Anneal 唯读保真

**优先级:** Must
**用户故事:** 作为用户，我想继续用既有 Connect & read 观察 Paseo/Anneal，而不被改成执行引擎。

#### 验收标准（EARS）

1. WHEN 打开 Integrations THEN 系统 SHALL 仍为 Paseo/Anneal 提供 `integration_read` Connect/snapshot，且 `upstreams.json` 保持 `mode=read_only`。
2. WHEN 渲染 Anneal 面板 THEN 系统 SHALL 提供可复制的本机端口转发示例，因为上游不支持原生 Windows。
3. IF 未发现属于应用内的原版写 API THEN 系统 SHALL 不增加 create/resume/approve/send 控件。

---

## 非功能需求

- **NFR-1（性能）**: 状态 GET 总时限不超过 8 秒，连接超时 2 秒，响应不超过 2 MiB。
- **NFR-2（安全）**: 只允许字面 loopback；不持久化 CommandCode 密钥；apply 不允许任意 argv。
- **NFR-3（兼容性）**: 不修改 `Source` 枚举；现有 Paseo/Anneal Rust 夹具测试必须继续通过。

---

## 依赖关系

- 0.7 来源：`runtime-web/scripts/commandcode-proxy-provider.ts`（`#98` 已合并到 0.7，`#121` 已关闭）。
- 上游包：`MAXeaglet/commandcode-proxy`。
- 既有 main：`integration_read`、`scripts/check-control-center.mjs`、Integrations 页面。

---

## 检查清单

- [x] 已消化历史经验，并规避 0.7 整树合并与密钥收集
- [x] 需求覆盖核心场景与边界场景
- [x] 每条需求有唯一 ID（FR-n），将在 design.md / tasks.md 中被引用
- [x] 验收标准使用 EARS 格式且可测
- [x] 已标注优先级（MoSCoW）
- [x] 范围边界（In/Out of Scope）明确
- [x] 非功能需求明确、尽量可量化
- [x] 依赖关系完整
