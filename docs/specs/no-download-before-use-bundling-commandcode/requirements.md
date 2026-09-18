# 需求文档：no-download-before-use-bundling-commandcode

## 功能概述

CommandCode Proxy、Paseo、Anneal 必须打进 Coding Tools Desktop 安装包。使用者按 Start 即可从 App 内建 payload 启用，不得再走 Git clone、GitHub token 或「先下载 App/服务」闸门。CPA 与 Codex Router 维持既有安装/下载流程。保留原版 UI+功能、CommandCode Check/Copy/Apply、七日 keep-alive。工作落在 #193（base #192 rc.11 五栈）。

## 历史经验与坑

- #192 五栈仍用 `git-source`：运行时 `git clone` + Anneal `githubReadToken.required=true`，Integrations 面板把 Start 挡在 Install/Repair 之后。
- CommandCode `proxy.mjs` 无 npm 依赖，可整棵打进 `vendor/bundled/commandcode-proxy`。
- Paseo tarball 约 26MB、Anneal 约 4.4MB，不宜把完整上游树提交进 git；打包时写入 `extraResources/bundled-components`。
- Anneal 的 GitHub token 只服务 `setup:local`，不是克隆 Anneal 本体，不得挡住 Start。
- Docker / Postgres / WSL2 仍是主机基础设施，不是「下载 App」。
- 不得静默把 `autoStart` 翻成 true；不得收集 CommandCode `user_*`。
- CPA / Codex Router 由 #190 保活 SoT，本次不得改它们的安装策略。

## 术语定义

- **bundled-source**：从 Desktop 内建目录复制 pinned 上游，不在使用者机器上 git clone。
- **No download-before-use**：面板不得要求先下载该服务的安装包或仓库；Start 从已随 App 分发的 payload 复制并启动。
- **Host infra**：Docker、Postgres、WSL2 等本机运行时，不算「下载 App」。

---

## 范围边界

**In Scope**
- 将 commandcode-proxy、paseo、anneal 的 managed strategy 改为 `bundled-source`。
- 把 CommandCode 真实 `proxy.mjs` 树提交到 `desktop-electron/vendor/bundled/commandcode-proxy`。
- 打包时把三份 payload 放进 `process.resourcesPath/bundled-components`。
- Start 在尚未 copy 到 managed home 时自动从 bundle 复制；隐藏这三者的 Install/Repair 与必填 GitHub token 闸门。
- 更新 rc.11 五栈测试与新增 bundled-source 单测。

**Out of Scope**
- CPA / CLIProxyAPI 与 Codex Router 的 release/git 安装、keep-alive、原版 UI。
- 把 Anneal Docker/Postgres/WSL2 打进安装包。
- 把 Paseo/Anneal 完整 `node_modules` 提交进 git。
- 改变 loopback 边界或收集 `user_*`。
- 静默开启 `autoStart`。

---

## 需求列表

### FR-1: CommandCode Proxy 随 App 内建且可 Start

**优先级:** Must
**用户故事:** 作为 Desktop 使用者，我想直接 Start CommandCode Proxy，以便不必再下载或 clone 该仓库。

#### 验收标准（EARS）

1. WHEN Desktop 已安装 THEN `vendor/bundled/commandcode-proxy/proxy.mjs` 或 `process.resourcesPath/bundled-components/commandcode-proxy/proxy.mjs` SHALL 存在且为 pinned commit `c123a3ebe017415ef45e619600a1110198dea7f8`。
2. WHEN 使用者按 Start 且 managed home 尚无 marker THEN 系统 SHALL 从内建树复制 `proxy.mjs` 并以 `{runtime} {home}/proxy.mjs` 启动，HOST 为 `127.0.0.1`。
3. IF 内建 payload 缺失 THEN 系统 SHALL 报 `Bundled component payload is missing from this Desktop build`，不得提示去 GitHub 下载。

### FR-2: Paseo 与 Anneal 随 App 内建且可 Start

**优先级:** Must
**用户故事:** 作为 Desktop 使用者，我想在未单独下载 Paseo/Anneal 的情况下 Start 原版服务。

#### 验收标准（EARS）

1. WHEN 打包 Desktop THEN extraResources SHALL 含 pinned Paseo `1e4ba65c6d75a6b061a1d54141f2f105b5908a96` 与 Anneal `e43b72b10ad389f090a0be18eea5d2bcef468f5e` 源码树。
2. WHEN 使用者按 Start THEN 系统 SHALL 从内建树复制到 managed home，不得运行 `git clone`。
3. WHILE Windows 上启动 Anneal THE 系统 SHALL 仍走既有 WSL2 + Docker 主机基础设施，不得改成下载 Anneal 安装包。

### FR-3: 面板不得以下载/安装闸门挡住这三者

**优先级:** Must
**用户故事:** 作为使用者，我不想先填 GitHub token 或点 Install/Repair 才能 Start 这三者。

#### 验收标准（EARS）

1. WHEN Integrations 选中 commandcode-proxy、paseo 或 anneal THEN 系统 SHALL 不显示针对这三者的必点 Install/Repair 主按钮。
2. WHEN Anneal `githubReadToken` 未配置 THEN 系统 SHALL 仍允许 Start；token 仅为可选 `setup:local` 助手。
3. IF 服务为 CPA 或 Codex Router THEN 系统 SHALL 保留既有 Install/Repair 与下载安装流程。

### FR-4: 既有原版功能与保活不变

**优先级:** Must
**用户故事:** 作为使用者，我要继续用原版 UI+操作、CommandCode Check/Copy/Apply 与七日重连。

#### 验收标准（EARS）

1. WHEN CommandCode 面板打开 THEN 系统 SHALL 仍提供 Check、Copy plan、Apply non-secret，且永不收集 `user_*`。
2. WHILE 七日会话 THE 系统 SHALL 维持既有 keep-alive、12s inspect、9090↔3050 探测与 `keepAlive !== autoStart`。
3. WHEN Paseo/Anneal 原版功能按钮被按下 THEN 系统 SHALL 仍走既有 allowlisted RPC/POST。

---

## 非功能需求

- **NFR-1（性能）**: CommandCode 首次 Start 的本地复制应在数秒内完成；Paseo/Anneal 若需 `npm ci` 只在 bundle 缺 `node_modules` 时发生，且不得再 git clone。
- **NFR-2（安全）**: loopback-only；凭证加密；不收集 `user_*`；不把 GitHub token 标成 Start 前置。
- **NFR-3（兼容性）**: 基于 0.7.0-rc.11 五栈；CPA/Router 安装契约不变。

---

## 依赖关系

- LOL #192 rc.11 五栈 managed components。
- 已合并的 #190 CPA/Router keep-alive。
- 打包脚本 `prepare-package-resources.cjs` 与 electron-builder extraResources。

---

## 检查清单

- [x] 已消化历史经验并规避 git-source 闸门与 CPA/Router 碰撞
- [x] 需求覆盖核心场景与边界场景
- [x] 每条需求有唯一 ID（FR-n）
- [x] 验收标准使用 EARS 格式且可测
- [x] 已标注优先级（MoSCoW）
- [x] 范围边界（In/Out of Scope）明确
- [x] 非功能需求明确
- [x] 依赖关系完整
