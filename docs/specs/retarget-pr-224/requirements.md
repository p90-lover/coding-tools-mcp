# 需求文档：retarget-pr-224

## 功能概述

Retarget pull request #224 onto LOL pull request #221 (`cursor/desktop-ui-ipc-proxy-fix-dc79`) so CommandCode Proxy, Paseo, and Anneal share #221’s `modules/` root and `handler-registry.cjs` instead of stacking on #214 or forking a second registry.

## 历史经验与坑

- **可复用经验**: #221 already owns `modules/handler-registry.cjs`, `modules/host.cjs`, `modules/lib/*`, and in-process `codingTools.apps` IPC. Keep those files verbatim.
- **必须规避的坑**: A second `handler-registry.cjs` or asserting `modules/cpa` / `modules/codex-router` do not exist will fail on #221. Do not create those folders in this lane. Do not invent apps HTTP listen ports.

## 术语定义

- **#221**: LOL PR `https://github.com/p90-lover/coding-tools-mcp/pull/221`, branch `cursor/desktop-ui-ipc-proxy-fix-dc79`. Shared module host.
- **#224**: This lane’s PR for CommandCode / Paseo / Anneal, currently `cursor/rc11-cc-paseo-anneal-original-ui-7a2a`.
- **in-process handler**: `modules/<id>/handler.cjs` `invoke`, reached through `window.codingTools.apps.call` / `invoke`. No product listen port.

---

## 范围边界

**In Scope（本次要做）**
- Change #224 base from `feature/rc11-managed-app-api-handles` to `cursor/desktop-ui-ipc-proxy-fix-dc79`.
- Keep this lane’s unique trees under `modules/commandcode-proxy/`, `modules/paseo/`, and `modules/anneal/` (in-tree `source/` plus #221 handlers).
- Use #221’s `modules/handler-registry.cjs` without duplicating or forking it.
- Keep in-process handlers and Coding Tools embedded visuals from #221.
- Focused tests and the lane workflow must pass against the new base; mark #224 ready when CI is green.

**Out of Scope（本次不做，避免过度实现）**
- Do not create `modules/cpa` or `modules/codex-router` in this lane (those folders already come from #221).
- Do not expand `original-ui.cjs` TOOL_IDS for CommandCode.
- Do not add an apps HTTP listener or dedicated product ports.
- Do not rewrite CPA / Codex Router visuals or ProxyBridge.

---

## 需求列表

### FR-1: Retarget #224 onto #221

**优先级:** Must
**用户故事:** 作为仓库维护者，我想要把 #224 叠在 #221 上，以便三个应用共用同一套模块根与 registry。

#### 验收标准（EARS）

1. WHEN GitHub PR #224 is inspected THEN 系统 SHALL 以 `cursor/desktop-ui-ipc-proxy-fix-dc79` 为 base branch。
2. WHEN the #224 head is compared to #221 THEN 系统 SHALL 不包含第二份 `modules/handler-registry.cjs` 分叉。
3. IF rebase/reset 与 #221 产生冲突 THEN 系统 SHALL 保留 #221 的 registry、host、lib、cpa、codex-router 与既有 handler 包装。

### FR-2: Own only CommandCode, Paseo, and Anneal module content

**优先级:** Must
**用户故事:** 作为 Coding Tools 宿主，我想要这三个应用的 in-tree source 落在 `modules/<app>/`，以便与 #221 的 in-process handler 一起加载。

#### 验收标准（EARS）

1. WHEN the registry loads modules THEN 系统 SHALL 继续通过 #221 的 `handler-registry.cjs` 发现 `commandcode-proxy`、`paseo`、`anneal`。
2. WHILE this lane’s diff is reviewed THE 系统 SHALL 仅新增或修改 `modules/commandcode-proxy|paseo|anneal` 内容，不得新增 `modules/cpa` 或 `modules/codex-router`。
3. IF `modules/commandcode-proxy/source/proxy.mjs` 存在 THEN 系统 SHALL 把它当作 in-tree source，而不是另起 `apps/`、`vendored/`、`integrations/` 根目录。

### FR-3: Keep in-process handlers and CT-hosted visuals

**优先级:** Must
**用户故事:** 作为桌面用户，我想要通过 `codingTools.apps` 调用这三个模块，并在 Coding Tools 视窗内看到视觉，而不是新的 listen port 产品面。

#### 验收标准（EARS）

1. WHEN `codingTools.apps.invoke` / `call` 调用这三个 handle THEN 系统 SHALL 走 in-process handler，不新增 apps HTTP port。
2. WHILE Paseo 或 Anneal 画面打开 THE 系统 SHALL 继续使用 #221 已嵌入的 CT GUI（含 native orchestrator/tasks chrome）。
3. IF Anneal Postgres 不可用 THEN 系统 SHALL 软失败并保持 Coding Tools 可操作。

---

## 非功能需求

- **NFR-1（性能）**: Registry load stays a local `require` of `handler.cjs`; no extra network hop for `apps.call`.
- **NFR-2（安全）**: Legacy loopbacks stay `127.0.0.1` only; do not advertise them as the product API.
- **NFR-3（兼容性）**: Preserve #221 `FOREIGN_SLOTS` `cpa` / `codex-router` and existing `modules-apps-host.test.cjs` contracts.

---

## 依赖关系

- Depends on #221 head `cursor/desktop-ui-ipc-proxy-fix-dc79`.
- Reuses #221 `modules/handler-registry.cjs`, `modules/host.cjs`, and `modules/lib/*`.
- Focused GitHub workflow `.github/workflows/rc11-cc-paseo-anneal-original-ui.yml` must target the new base.

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
