# 任务清单：original-paseo-anneal-commandcode-panels

## 概述

实现 original-paseo-anneal-commandcode-panels。每条任务回链到需求与设计，不越界到 CPA / Codex Router / 主壳 / extension HUD。

---

## 交付物清单（Scope-lock）

- **预计新建文件数**: 4 个
- **预计修改文件数**: 8 个
- **预计新增/修改函数数**: 约 8 个
- **交付物逐项列举**:
  1. `desktop-electron/vendor/upstream/paseo.json`
  2. `desktop-electron/vendor/upstream/anneal.json`
  3. `desktop-electron/electron/upstream-tools.cjs`
  4. `desktop-electron/electron/external-services.cjs`
  5. `desktop-electron/src/types.ts`
  6. `desktop-electron/src/features/UpstreamToolSurface.tsx`
  7. `desktop-electron/src/features/upstream-tool.css`
  8. `desktop-electron/src/features/CommandCodeProxySurface.tsx`
  9. `desktop-electron/src/features/commandcode-proxy.css`
  10. `desktop-electron/src/features/ExternalServicesSurface.tsx`
  11. `desktop-electron/tests/original-upstream-panels.test.cjs`
  12. `docs/features/paseo-anneal-commandcode-original-panels.md`

---

## 任务列表

### 阶段 1: 准备工作

- [x] 1.1 盘点 0.7 Electron 现有面板与 pinned 上游真实路由
  - **证据块**: `desktop-electron/src/App.tsx` 以 `UpstreamToolSurface` 承载 paseo/anneal；`vendor/upstream/paseo.json` 使用虚构 `/agents`；Anneal `apps/web` 为 hash router；commandcode-proxy `proxy.mjs` 只有 `/` health 与 `/v1/*`。
  - **涉及文件**: 只读盘点，无生产改动
  - _需求: FR-1, FR-2, FR-3_ ｜ _设计: 概述_

---

### 阶段 2: 核心实现

- [x] 2.1 修正 `sectionUrl` 与 pinned sectionPaths，使 Paseo / Anneal iframe 打开原版路由
  - **证据块**: `electron/upstream-tools.cjs` 现用 `new URL(pathname, endpoint)`，Anneal path `/tasks` 不会变成 `#/tasks`。
  - **涉及文件**: `electron/upstream-tools.cjs`（约 40 行）、`vendor/upstream/paseo.json`、`vendor/upstream/anneal.json`、`tests/upstream-tools.test.cjs`
  - _需求: FR-1, FR-2, FR-4_ ｜ _设计: API 设计 / 决策 2_

- [x] 2.2 让 `UpstreamToolSurface` 在 ready 时自动全幅嵌入原版 UI，并写明 Anneal port-forward
  - **证据块**: `UpstreamToolSurface.tsx` 只有手动 `openEmbedded`；`upstream-tool.css` 给 iframe 外框装饰壳。
  - **涉及文件**: `UpstreamToolSurface.tsx`（约 80 行）、`upstream-tool.css`（约 40 行）
  - _需求: FR-1, FR-2, NFR-3_ ｜ _设计: 决策 1_

- [x] 2.3 增加 commandcode-proxy 原版 banner 面板并接到既有 lifecycle / health
  - **证据块**: `ExternalServicesSurface.tsx` 选中 commandcode-proxy 只显示通用控制台；`inspect` 只打 `/v1/models`。
  - **涉及文件**: `CommandCodeProxySurface.tsx`、`commandcode-proxy.css`、`ExternalServicesSurface.tsx`、`external-services.cjs`、`types.ts`
  - _需求: FR-3, FR-4, NFR-1_ ｜ _设计: 决策 3_

---

### 阶段 3: 集成测试

- [x] 3.1 新增聚焦测试并跑受影响既有契约
  - **证据块**: 既有 `upstream-tools.test.cjs`、`rc7-full-integration-contract.test.cjs`、`external-services-control-plane.test.cjs`。
  - **涉及文件**: `tests/original-upstream-panels.test.cjs`；必要时微调既有 sectionUrl 断言
  - _需求: FR-1, FR-2, FR-3, NFR-4_ ｜ _设计: 测试策略_

---

## 检查点

- [ ] 阶段 1 完成后：三个上游的真实路由 / health 契约已写进规格
- [ ] 阶段 2 完成后：iframe URL 与 CommandCode 面板控件都接到真实 IPC / 原版路径
- [ ] 阶段 3 完成后：聚焦测试与受影响契约通过

---

## 需求覆盖矩阵

| 需求 ID | 设计章节 | 任务编号 | 状态 |
|---------|----------|----------|------|
| FR-1 | 决策 1、API 设计 | 2.1, 2.2, 3.1 | 完成 |
| FR-2 | 决策 2、API 设计 | 2.1, 2.2, 3.1 | 完成 |
| FR-3 | 决策 3 | 2.3, 3.1 | 完成 |
| FR-4 | 技术方案、文件结构 | 2.1, 2.3 | 完成 |
| NFR-1 | 数据模型 | 2.3 | 完成 |
| NFR-2 | 非功能 / 默认端点 | 2.1, 2.3 | 完成 |
| NFR-3 | 自动嵌入 | 2.2 | 完成 |
| NFR-4 | 测试策略 | 3.1 | 完成 |

---

## 文件变更清单

| 文件 | 操作 | 行数预算 | 说明 |
|------|------|----------|------|
| desktop-electron/vendor/upstream/paseo.json | 修改 | 20 | 真实 Expo sectionPaths |
| desktop-electron/vendor/upstream/anneal.json | 修改 | 20 | hash sectionPaths |
| desktop-electron/electron/upstream-tools.cjs | 修改 | 40 | hash-aware sectionUrl |
| desktop-electron/electron/external-services.cjs | 修改 | 60 | commandcode `/` health 投影 |
| desktop-electron/src/types.ts | 修改 | 20 | optional health 字段 |
| desktop-electron/src/features/UpstreamToolSurface.tsx | 修改 | 80 | 自动嵌入 + 全幅 |
| desktop-electron/src/features/upstream-tool.css | 修改 | 40 | immersive iframe |
| desktop-electron/src/features/CommandCodeProxySurface.tsx | 新建 | 220 | 原版 banner 面板 |
| desktop-electron/src/features/commandcode-proxy.css | 新建 | 120 | banner 视觉 |
| desktop-electron/src/features/ExternalServicesSurface.tsx | 修改 | 30 | 选中时渲染 banner 面板 |
| desktop-electron/tests/original-upstream-panels.test.cjs | 新建 | 120 | 路由 / 自动嵌入 / banner 契约 |
| docs/features/paseo-anneal-commandcode-original-panels.md | 新建 | 80 | 验证与 Windows port-forward |

---

## 检查清单

- [x] 交付物清单（Scope-lock）已填
- [x] 每条任务标题是动词+对象+约束
- [x] 每条任务含证据块
- [x] 每条任务标注涉及文件与行数预算
- [x] 任务分阶段合理
- [x] 每条任务都回链到 FR 与 design 章节
- [x] 需求覆盖矩阵已填
- [x] 阶段 3 包含对照验收标准核验
- [x] 全文无未替换占位符
