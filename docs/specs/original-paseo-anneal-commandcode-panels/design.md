# 设计文档：original-paseo-anneal-commandcode-panels

## 概述

本次不重做 Desktop shell。Paseo / Anneal 继续走 `UpstreamToolSurface` iframe；修正 URL 并在 ready 时自动全幅嵌入。commandcode-proxy 没有网页，因此在 Integrations 选中该服务时渲染原版 banner 面板，并复用 external-services 的 inspect / start / stop / restart。

**对应需求:** FR-1, FR-2, FR-3, FR-4, NFR-1, NFR-2, NFR-3, NFR-4

---

## 技术方案

### 技术选型

| 类别 | 选择 | 理由 | 关联需求 |
|------|------|------|----------|
| Paseo / Anneal 主画面 | 既有 iframe + 修正 section URL | 1:1 原版视觉只能来自 pinned 上游 UI | FR-1, FR-2 |
| Anneal 路由 | hash `#/<section>` | 上游 `apps/web/src/lib/router.tsx` 是 hash router | FR-2 |
| Paseo 路由 | 真实 Expo path | pinned app 没有 `/agents` 等虚构 path | FR-1 |
| commandcode-proxy | 原版 banner 面板 + `GET /` health | 上游只有 CLI banner 与 JSON health | FR-3 |
| 生命周期 | 既有 external-services / upstream-tools IPC | 避免新 IPC 面与死按钮 | FR-3, FR-4 |

### 架构设计

```text
Paseo / Anneal 页
  App surface paseo|anneal
    -> UpstreamToolSurface
         inspect() -> ready? openEmbeddedTool(section)
         sectionUrl(manifest, endpoint, section)
           Paseo: /sessions | /open-project | /settings
           Anneal: #/tasks | #/projects | ...
         iframe src = loopback URL（全幅）
         native orchestration 留在 <details>

Integrations 选中 commandcode-proxy
  ExternalServicesSurface
    -> CommandCodeProxySurface
         inspectExternalService + GET / health projection
         start/stop/restartExternalService
         copy OpenAI / Anthropic base URL
    高级手动设定仍在既有 details
```

---

## 数据模型

| 实体/字段 | 类型 | 约束 | 说明 |
|-----------|------|------|------|
| `vendor/upstream/paseo.json` sectionPaths | string map | 必须是 loopback-relative path | agents/sessions -> `/sessions`；workspaces -> `/open-project`；其余设定类 -> `/settings` |
| `vendor/upstream/anneal.json` sectionPaths | string map | `#/` hash | 每个现有 section 映射 `#/<section>` |
| `ExternalServiceSnapshot.health` | optional object | 有界字段 | commandcode-proxy 的 `/` 或 `/health` 投影：status、proxy、version、endpoints、user、credits、models |
| iframe URL | absolute http(s) loopback | 禁止凭据、禁止非 loopback | `sectionUrl` 继续执行 hostname 检查 |

不新增持久化 profile 字段。health 只留在内存 snapshot。

---

## API 设计

| 方法/函数 | 路径/签名 | 入参 | 出参 | 关联需求 |
|-----------|-----------|------|------|----------|
| `sectionUrl` | `sectionUrl(manifest, endpoint, section)` | pinned manifest + loopback endpoint + section id | 绝对 loopback URL，Anneal 带 hash | FR-1, FR-2, FR-4 |
| `openEmbeddedTool` | 既有 IPC | toolId, section | `{ tool, section, url, embedded }` | FR-1, FR-2 |
| `inspect` (external-services) | 既有 inspect | service id | snapshot；commandcode-proxy 额外附 `health` | FR-3 |
| CommandCode 面板动作 | 既有 start/stop/restart/inspect IPC | service id `commandcode-proxy` | 更新后的 snapshot | FR-3 |

不新增 renderer 可调用的任意 URL fetch IPC。commandcode health 由 main-process inspect 附带请求 `/`。

---

## 文件结构

```
desktop-electron/
├── vendor/upstream/paseo.json
├── vendor/upstream/anneal.json
├── electron/upstream-tools.cjs
├── electron/external-services.cjs
├── src/types.ts
├── src/features/UpstreamToolSurface.tsx
├── src/features/upstream-tool.css
├── src/features/CommandCodeProxySurface.tsx
├── src/features/commandcode-proxy.css
├── src/features/ExternalServicesSurface.tsx
└── tests/original-upstream-panels.test.cjs
docs/specs/original-paseo-anneal-commandcode-panels/
docs/features/paseo-anneal-commandcode-original-panels.md
```

不修改 `src/App.tsx` 侧边栏、Provider Hub、Codex Router 专属栏、extension 程式码。

---

## 设计决策

### 决策 1: iframe 原版 UI 优先于 native orchestration 壳（关联需求: FR-1, FR-2）

**问题**: 现有 PaseoOrchestratorSurface / AnnealTasksSurface 是 Coding Tools 重新设计的执行壳，不是原版视觉。

**选项**:
1. 继续把 native 壳当主画面，只改文案。
2. 把 pinned 上游 Web UI 当主画面，native 壳留在 details。

**决策**: 选择选项 2。

**理由**: 需求明确要求 1:1 原版视觉。原版按钮与导航只存在于上游 UI。Native 壳仍可作 Coding Tools 编排辅助，但不得挡住原版。

### 决策 2: Anneal 使用 hash URL（关联需求: FR-2）

**问题**: 现有 `sectionUrl` 把 `/tasks` 接到 origin，Anneal 实际读 `location.hash`。

**选项**:
1. 改写 Anneal（超出范围）。
2. 把 sectionPaths 改成 `#/tasks` 并让 `sectionUrl` 支持 hash。

**决策**: 选择选项 2。

**理由**: 这是对 pinned 上游契约的最小修正。

### 决策 3: commandcode-proxy 复现 banner，不伪造 dashboard（关联需求: FR-3）

**问题**: 树上没有 HTML dashboard；kalpeshe 版有 dashboard，但 managed pin 是 zahidhussaina2l。

**选项**:
1. 嵌入不存在的网页。
2. 复现官方 banner + health JSON 功能。

**决策**: 选择选项 2。

**理由**: 1:1 必须对 pinned 原件负责，不能换成另一个 fork 的装饰壳。

---

## 测试策略

- 单元：`sectionUrl` 对 Paseo `/sessions` 与 Anneal `#/tasks`。
- 契约：`UpstreamToolSurface` 在 ready 时调用 `openEmbeddedTool`；Anneal 文案含 port-forward。
- 契约：CommandCode 面板含 banner 字段与 start/inspect IPC 使用。
- 回归：既有 `rc7-full-integration-contract` section 名称、`upstream-tools` loopback、`external-services` 401 health 行为保持。

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 上游之后改路由 | 中 | pin 在 manifest commit；测试锁住路径 |
| iframe 被上游 CSP / X-Frame-Options 挡住 | 中 | 保留 Open externally；不假装已渲染 |
| Windows 上 Anneal 本机不可用 | 中 | 明确 port-forward 文案；UI 在服务可达时仍可用 |
| health 含敏感字段 | 低 | 只投影有界字段，不显示完整 proxy key |

---

## 检查清单

- [x] 技术方案与现有架构一致
- [x] requirements.md 中每条 FR 都被本设计覆盖
- [x] 文件结构对照真实代码库，路径可定位
- [x] 数据模型 / 接口契约清晰
- [x] 关键设计决策已记录并关联需求
- [x] 测试策略可验证验收标准
