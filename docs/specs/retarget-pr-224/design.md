# 设计文档：retarget-pr-224

## 概述

Retarget PR #224 onto LOL PR #221. This lane does not own the shared registry. It only adds CommandCode / Paseo / Anneal in-tree source under `modules/<app>/source/` and lane tests/CI while consuming #221 handlers and CT-hosted visuals.

**对应需求:** FR-1, FR-2, FR-3, NFR-1, NFR-2, NFR-3

---

## 技术方案

### 技术选型

| 类别 | 选择 | 理由 | 关联需求 |
|------|------|------|----------|
| Git base | `cursor/desktop-ui-ipc-proxy-fix-dc79` | User locked shared root to #221, not #214 | FR-1 |
| Registry | #221 `modules/handler-registry.cjs` verbatim | Do not fork or duplicate | FR-1, NFR-3 |
| Module folders | `commandcode-proxy`, `paseo`, `anneal` only in this diff | CPA/Router stay LOL slots | FR-2 |
| Transport | in-process `codingTools.apps` | No apps HTTP port product | FR-3, NFR-1 |

### 架构设计

```
#221 base
  modules/handler-registry.cjs     (unchanged)
  modules/host.cjs                 (unchanged)
  modules/lib/*                    (unchanged)
  modules/cpa|codex-router         (unchanged; not this lane)
  modules/commandcode-proxy|paseo|anneal/handler.cjs + handlers.cjs  (keep #221)
#224 delta
  modules/commandcode-proxy/source/*   in-tree proxy.mjs
  modules/paseo/source/BUNDLE.json
  modules/anneal/source/BUNDLE.json
  module.json source pointers
  lane tests + workflow + docs
```

After reset onto #221, drop the #214 Managed Apps files (`managed-app-api.cjs`, `ManagedAppsSurface.tsx`, forked `handler-registry.cjs`). Those files do not exist on #221. Visuals remain the #221 CT embeddings: CommandCodeProxySurface, UpstreamToolSurface + PaseoOrchestratorSurface / AnnealTasksSurface.

---

## 数据模型

不涉及持久化实体。`module.json` 增加只读 `source` 指针：

| 实体/字段 | 类型 | 约束 | 说明 |
|-----------|------|------|------|
| module.json.id | string | 必须等于文件夹名 | 由 #221 registry 校验 |
| module.json.transport | string | `in-process` | 产品传输 |
| module.json.source.path | string | `modules/<id>/source` | in-tree 源码 |
| module.json.legacyLoopback | object | 127.0.0.1 only | 兼容已绑定的 child socket |

---

## API 设计

不新增 IPC。沿用 #221：

| 方法/函数 | 路径/签名 | 入参 | 出参 | 关联需求 |
|-----------|-----------|------|------|----------|
| defaultRegistry.invoke | `invoke(id, operation, args, ctx)` | module id + op | `{ transport: "in-process", ... }` | FR-3 |
| codingTools.apps.call | IPC `apps.call` | `{ moduleId, operation, arguments }` | sanitized result | FR-3 |
| codingTools.apps.invoke | 同频道，`handle` 映射 `moduleId` | `{ handle, operation }` | sanitized result | FR-3 |

---

## 文件结构

```
coding-tools-mcp/
├── modules/handler-registry.cjs          # 保留 #221，不改
├── modules/commandcode-proxy/source/     # 本 lane 新增 in-tree
├── modules/paseo/source/                 # 本 lane 新增 BUNDLE
├── modules/anneal/source/                # 本 lane 新增 BUNDLE
├── desktop-electron/tests/rc11-cc-paseo-anneal-original-ui.test.cjs
├── .github/workflows/rc11-cc-paseo-anneal-original-ui.yml
└── docs/features/paseo-anneal-commandcode-original-panels.md
```

---

## 设计决策

### 决策 1: Reset onto #221 instead of replaying #214 commits（关联需求: FR-1）

**问题**: #224 的三笔 commit 改的是 #214 的 Managed Apps 文件，#221 没有那些路径。

**选项**:
1. `git rebase --onto #221 #214`: 大量 add 不存在的文件，会把 Managed Apps 壳带进 #221。
2. `git reset --hard #221` 后只恢复三个模块的 source 与 lane 测试：diff 干净。

**决策**: 选择选项 2。

**理由**: 用户要求共用 #221 registry，且不要第二套模块根。把 #214 的 `managed-app-api.cjs` 带过来会分叉宿主。

### 决策 2: Keep #221 handlers.cjs（关联需求: FR-2, FR-3）

**问题**: 本 lane 曾写过较简的 `handler.cjs`（只有 health/models/banner）。

**选项**:
1. 覆盖成简版 handler。
2. 保留 #221 `wrapInProcessHandler(createModule)` 与 lifecycle/protocol ops。

**决策**: 选择选项 2。

**理由**: #221 已覆盖 send/task-start/registration-plan 等；覆盖会破坏 `modules-apps-host.test.cjs`。

---

## 测试策略

- `node --check` on #221 registry plus the three `handler.cjs` / `handlers.cjs` files.
- Lane test asserts: registry is #221’s (host.cjs + lib + FOREIGN_SLOTS), three source trees exist, invoke send/task-start still in-process, this diff does not add cpa/codex-router folders.
- Re-run `desktop-electron/tests/modules-apps-host.test.cjs` so #221 host contracts stay green.

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Force-push rewrite of #224 | 中 | 同一分支名，PR 号码保留，更新 base |
| #221 继续前进 | 中 | fetch 最新 `3ce10301` 后再 reset |
| 旧测试断言 cpa 目录不存在 | 高 | 改测试：允许 #221 已有 FOREIGN_SLOTS 目录 |

---

## 检查清单

- [x] 技术方案与现有架构一致
- [x] requirements.md 中每条 FR 都被本设计覆盖（或注明不涉及）
- [x] 文件结构对照真实代码库，路径可定位
- [x] 数据模型 / 接口契约清晰（含类型与约束）
- [x] 关键设计决策已记录并关联需求
- [x] 测试策略可验证验收标准
