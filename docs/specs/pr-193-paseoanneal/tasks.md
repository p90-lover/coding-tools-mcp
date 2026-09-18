# 任务清单：pr-193-paseoanneal

## 概述

实现 Paseo 可用性感知 CPA/Router 后端与 Anneal BACKLOG 交接。每条任务回链 FR 与设计章节。

## 交付物清单（Scope-lock）

- **预计新建文件数:** 3 个（本规格三件套；无新生产模块文件，逻辑进现有 control-plane）
- **预计修改文件数:** 5 个
- **预计新增/修改函数数:** 约 8 个
- **交付物逐项列举:**
  1. `desktop-electron/electron/five-stack-control-plane.cjs`
  2. `desktop-electron/electron/upstream-actions.cjs`
  3. `desktop-electron/electron/main.cjs`
  4. `desktop-electron/tests/five-stack-control-plane.test.cjs`
  5. `desktop-electron/tests/upstream-actions.test.cjs`

---

## 任务列表

### 阶段 1: 准备工作

- [ ] 1.1 导出 `stackAvailability` 与 `preferredBackend`，按 CPA/Router 可用选择 8317/4202，CommandCode 固定 9090
  - **证据块:** 先读 `desktop-electron/electron/five-stack-control-plane.cjs` 142-148 行，现状 `preferredBackend` 除 commandcode 外一律 CPA，从不读 snapshot，也不用 Router :4202
  - **涉及文件:** `desktop-electron/electron/five-stack-control-plane.cjs` 约 +80 行
  - _需求: FR-1, FR-2_ ｜ _设计: 技术方案 / 决策 1_

---

### 阶段 2: 核心实现

- [ ] 2.1 让 `paseo_plan` 在 `getServicesSnapshot` 后写入 `backend` / `backendKind` / `backendFallback`
  - **证据块:** 先读同文件 `plan()` 334-382 行，现状 `backend: preferredBackend(summarized.providerId, backends)` 无 availability
  - **涉及文件:** `desktop-electron/electron/five-stack-control-plane.cjs` 约 +40 行
  - _需求: FR-1, FR-2, NFR-1_ ｜ _设计: 架构设计_

- [ ] 2.2 将 `anneal_open_from_review` 改为 BACKLOG 记录，Anneal 可用时 POST `/projects/{id}/tasks`
  - **证据块:** 先读 `openAnnealFromReview` 499-537 行，现状 `state: "review"` 且无 HTTP；对照 `src-tauri/src/integrations/execution/protocol.rs` 123-135 行 BACKLOG 体
  - **涉及文件:** `desktop-electron/electron/five-stack-control-plane.cjs` 约 +90 行；`desktop-electron/electron/main.cjs` 约 +30 行注入 transport
  - _需求: FR-3_ ｜ _设计: 决策 2 / API 设计_

- [ ] 2.3 扩展 `upstream-actions` 允许 POST `/projects/{id}/tasks` 与 GET `/tasks`、`/tasks/{id}`
  - **证据块:** 先读 `desktop-electron/electron/upstream-actions.cjs` 16-26 行 ALLOWED_ANNEAL_POST，无 create；`annealPost` 仅 POST
  - **涉及文件:** `desktop-electron/electron/upstream-actions.cjs` 约 +80 行
  - _需求: FR-3, NFR-2_ ｜ _设计: API 设计_

---

### 阶段 3: 集成测试

- [ ] 3.1 对照 FR-1/FR-2/FR-3 验收：可用性分支、CommandCode 9090、BACKLOG POST、端口 8317/4202 字面量不变
  - **证据块:** 先读 `desktop-electron/tests/five-stack-control-plane.test.cjs` 80-139 行，现状断言 CPA 8317 与 `task.state === "review"`
  - **涉及文件:** `desktop-electron/tests/five-stack-control-plane.test.cjs`；`desktop-electron/tests/upstream-actions.test.cjs`
  - _需求: FR-1, FR-2, FR-3, FR-4_ ｜ _设计: 测试策略_

---

## 检查点

- [ ] 阶段 1 完成后：preferredBackend 单测可在无 snapshot 时仍返回 CPA URL 常量 8317
- [ ] 阶段 2 完成后：mock Anneal POST 看到 BACKLOG + approvalGate
- [ ] 阶段 3 完成后：8317/4202 端口测试仍绿；CommandCode 9090/3050 仍绿

---

## 需求覆盖矩阵

| 需求 ID | 设计章节 | 任务编号 | 状态 |
|---------|----------|----------|------|
| FR-1 | 技术方案 / 决策 1 | 1.1, 2.1, 3.1 | 未开始 |
| FR-2 | 技术方案 | 1.1, 2.1, 3.1 | 未开始 |
| FR-3 | 决策 2 / API 设计 | 2.2, 2.3, 3.1 | 未开始 |
| FR-4 | 决策 3 | 3.1 | 未开始 |
| NFR-1 | 决策 1 | 2.1 | 未开始 |
| NFR-2 | API 设计 | 2.3 | 未开始 |
| NFR-3 | 概述 | 2.1 | 未开始 |

---

## 文件变更清单

| 文件 | 操作 | 行数预算 | 说明 |
|------|------|----------|------|
| desktop-electron/electron/five-stack-control-plane.cjs | 修改 | 120 | 可用性 backend + BACKLOG handoff |
| desktop-electron/electron/upstream-actions.cjs | 修改 | 80 | Anneal create/GET 允许名单 |
| desktop-electron/electron/main.cjs | 修改 | 30 | 注入 handoff transport |
| desktop-electron/tests/five-stack-control-plane.test.cjs | 修改 | 80 | 可用性与 BACKLOG |
| desktop-electron/tests/upstream-actions.test.cjs | 修改 | 40 | create 路径 |

---

## 检查清单

- [x] 交付物清单（Scope-lock）已填，实现后数量已逐项核对
- [x] 每条任务标题是动词+对象+约束的具体描述，无宽泛标题
- [x] 每条任务含证据块（先读后写）
- [x] 每条任务标注涉及文件与行数预算，超 500 行的有拆分方案
- [x] 任务分阶段合理，粒度可在单次提交内完成
- [x] 每条任务都回链到 FR 与 design 章节
- [x] 需求覆盖矩阵已填，无遗漏的 FR
- [x] 阶段 3 包含对照验收标准核验
- [x] 全文无占位符代替真实内容
