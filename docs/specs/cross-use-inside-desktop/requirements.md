# 需求文档：cross-use-inside-desktop

## 功能概述

CommandCode Proxy、Paseo、Anneal 必须共用 Desktop 内建的同一组 managed loopback，以便互相调用，并被 Codex Router、CPA、MCP 调用，而不是跳到另行安装的 App。保持 no-download-before-use、原版 UI+功能、七日保活；工作落在 #193（base #192）；不复制 #190 CPA/Router keep-alive。

## 历史经验与坑

- `runtimeEnvironment()` 已把部分 `CODING_TOOLS_*` URL 注入 MCP/runtime-supervisor，但未注入 managed 组件子进程。
- 缺少 `CODING_TOOLS_PASEO_URL` 与 `CODING_TOOLS_ANNEAL_URL`（上游 manifest 已声明这些环境变量）。
- Paseo/Anneal 启动环境只有自身 listen，不知道 in-app CommandCode `127.0.0.1:9090`。
- 不得把 `OPENAI_BASE_URL` 灌进 CPA/Router/MCP 全局，以免劫持 #190 与 ChatGPT Web harness。
- 不得收集 CommandCode `user_*`；mesh JSON 不得写入 API key。

## 术语定义

- **In-app loopback mesh**: Desktop 管理的五栈 loopback 目录（URL only）。
- **Cross-use**: 进程通过 mesh 环境变量调用同一 Desktop 内的兄弟服务，而不是外部安装包。
- **Peer environment**: 启动某个 managed 组件时注入的兄弟 URL（及仅限 Paseo/Anneal 的 OpenAI/Anthropic 别名）。

---

## 范围边界

**In Scope**
- 规范化五栈 in-app loopback mesh，并写入 `loopback-mesh.json`。
- 把 mesh URL 注入 CommandCode/Paseo/Anneal（以及同控制器启动的 CPA/Router）子进程。
- Paseo/Anneal 启动时把 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` 指向 in-app CommandCode `/v1`。
- 补齐 MCP `runtimeEnvironment` 的 Paseo/Anneal origin URL 与 CommandCode OpenAI/Anthropic base。
- runtime-web 从 env 解析 in-app CommandCode loopback。

**Out of Scope**
- 修改 CPA/Codex Router keep-alive（#190）。
- 把 Paseo/Anneal 的 Docker/WSL 打进安装包。
- 在 renderer 展示 proxy API key。
- 静默把 `autoStart` 设为 true（本功能不改该字段）。

---

## 需求列表

### FR-1: 共享 in-app loopback mesh

**优先级:** Must
**用户故事:** 作为 Desktop 运行时，我想有一份权威 loopback 目录，以便五栈指向同一组本机端口。

#### 验收标准（EARS）

1. WHEN Desktop 生成 mesh THEN 系统 SHALL 包含 commandcode-proxy `http://127.0.0.1:9090`、paseo `http://127.0.0.1:6768` 与 `ws://127.0.0.1:6768/ws`、anneal `http://127.0.0.1:5173` 与 `http://127.0.0.1:3000`、以及既有 CPA `8317` 与 Codex Router `4202`。
2. IF 使用者把某服务改到另一个 loopback THEN 系统 SHALL 在 mesh 中使用该 loopback，并拒绝非 loopback。
3. IF 写入 `loopback-mesh.json` THEN 文件 SHALL 不含 API key 或 `user_*`。

### FR-2: 三者互相调用不离开 Desktop

**优先级:** Must
**用户故事:** 作为 Paseo/Anneal/CommandCode 进程，我想在 Start 时拿到兄弟 loopback，以便调用同一 App 内的服务。

#### 验收标准（EARS）

1. WHEN Start Paseo 或 Anneal THEN 其环境 SHALL 含 `CODING_TOOLS_COMMANDCODE_URL` 与 `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` 指向 in-app CommandCode `/v1`。
2. WHEN Start CommandCode THEN 其环境 SHALL 含 Paseo/Anneal/CPA/Router 的 `CODING_TOOLS_*` URL，且不得覆盖自身 `PROXY_HOST`/`PROXY_PORT`。
3. IF 某兄弟尚未安装 THEN 系统 SHALL 仍注入默认 in-app loopback，不得改成外部下载地址。

### FR-3: Codex Router / CPA / MCP 调用同一组 loopback

**优先级:** Must
**用户故事:** 作为 MCP 或 Router/CPA，我想调用 Desktop 内建的 CommandCode/Paseo/Anneal，而不是外部安装包。

#### 验收标准（EARS）

1. WHEN MCP runtime 启动 THEN `runtimeEnvironment()` SHALL 提供 CommandCode origin 与 `/v1`、Paseo URL 与 execution URL、Anneal URL 与 execution URL。
2. WHEN runtime-web 读取 `CODING_TOOLS_COMMANDCODE_URL` THEN 系统 SHALL 解析为 loopback CommandCode provider profile。
3. IF 本功能改动 THEN 系统 SHALL 不修改 CPA/Router keep-alive 轮询实现。

---

## 非功能需求

- **NFR-1（性能）**: mesh 构建与 env 合并为同步内存操作，不得在 Start 时发网。
- **NFR-2（安全）**: loopback-only；密钥只进子进程 env，不进 mesh JSON 与 renderer。
- **NFR-3（兼容性）**: 既有 `CODING_TOOLS_CODEX_ROUTER_URL` 与 `CODING_TOOLS_CPA_URL` 键名保持。

---

## 依赖关系

- #193 bundled-source Start 路径。
- #192 managed five-stack 与 `runtimeEnvironment`。
- #190 CPA/Router keep-alive（只读，不改）。

---

## 检查清单

- [x] 已消化历史经验
- [x] 需求覆盖核心与边界
- [x] 每条需求有唯一 ID
- [x] 验收标准使用 EARS
- [x] 已标注优先级
- [x] 范围边界明确
- [x] 非功能需求明确
- [x] 依赖关系完整
