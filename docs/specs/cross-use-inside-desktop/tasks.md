# 任务清单：cross-use-inside-desktop

## 概述

实现 Desktop 内建 loopback mesh，使 CommandCode/Paseo/Anneal 互相调用并被 Router/CPA/MCP 以同一组 URL 调用。禁止占位符。

---

## 交付物清单（Scope-lock）

- **预计新建文件数**: 5 个
- **预计修改文件数**: 6 个
- **预计新增/修改函数数**: 约 8 个
- **交付物逐项列举**:
  1. `docs/specs/cross-use-inside-desktop/requirements.md`
  2. `docs/specs/cross-use-inside-desktop/design.md`
  3. `docs/specs/cross-use-inside-desktop/tasks.md`
  4. `desktop-electron/electron/loopback-mesh.cjs`
  5. `desktop-electron/electron/external-services.cjs` 扩展 runtimeEnvironment
  6. `desktop-electron/electron/managed-components.cjs` peer env
  7. `desktop-electron/electron/managed-external-services.cjs` 接线
  8. `runtime-web/src/routed-providers.ts` CommandCode loopback 解析
  9. `desktop-electron/tests/loopback-mesh.test.cjs`
  10. `runtime-web/tests/routed-providers.test.ts`
  11. `desktop-electron/tests/external-services-control-plane.test.cjs` mesh 合约

---

## 任务列表

### 阶段 1: 准备工作

- [x] 1.1 落盘规格并确认 runtimeEnvironment 缺口
  - **证据块**: `external-services.cjs` `runtimeEnvironment` 有 COMMANDCODE_URL 与 execution URL，没有 PASEO_URL/ANNEAL_URL；managed `commandSpec` 只合并 `env` 与自身 launch.environment。
  - **涉及文件**: specs 三份
  - _需求: FR-1, FR-2, FR-3_ ｜ _设计: 概述_

---

### 阶段 2: 核心实现

- [x] 2.1 实现 loopback-mesh 构建与 env 映射
  - **证据块**: 五栈端口现散落在 `SERVICE_ENDPOINTS` 与 defaults。
  - **涉及文件**: `desktop-electron/electron/loopback-mesh.cjs` 约 160 行
  - _需求: FR-1_ ｜ _设计: 数据模型_

- [x] 2.2 注入 managed Start 与 MCP runtimeEnvironment
  - **证据块**: `commandSpec` 729 行 `env: { ...env, ...environment }`；`runtimeEnvironment` 1009 行缺 Paseo/Anneal origin。
  - **涉及文件**: `managed-components.cjs`、`managed-external-services.cjs`、`external-services.cjs`、`routed-providers.ts`
  - _需求: FR-2, FR-3_ ｜ _设计: 架构设计, 决策 1_

---

### 阶段 3: 集成测试

- [x] 3.1 对照 FR 验证 mesh、peer env、MCP env、runtime-web 解析
  - **证据块**: 现有 control-plane 测试不覆盖 PASEO_URL。
  - **涉及文件**: `loopback-mesh.test.cjs`、`external-services-control-plane.test.cjs`、`routed-providers.test.ts`
  - _需求: FR-1, FR-2, FR-3_ ｜ _设计: 测试策略_

---

## 检查点

- [x] 阶段 1 完成后：规格无占位符
- [x] 阶段 2 完成后：Start 子进程与 MCP env 含同一组 in-app URL
- [x] 阶段 3 完成后：相关测试通过

---

## 需求覆盖矩阵

| 需求 ID | 设计章节 | 任务编号 | 状态 |
|---------|----------|----------|------|
| FR-1 | 数据模型 | 2.1, 3.1 | 完成 |
| FR-2 | 决策 1 | 2.2, 3.1 | 完成 |
| FR-3 | 架构设计 | 2.2, 3.1 | 完成 |
| NFR-1 | 技术方案 | 2.1 | 完成 |
| NFR-2 | 决策 2 | 2.1, 2.2 | 完成 |
| NFR-3 | 技术方案 | 2.2 | 完成 |

---

## 文件变更清单

| 文件 | 操作 | 行数预算 | 说明 |
|------|------|----------|------|
| docs/specs/cross-use-inside-desktop/requirements.md | 新建 | 110 | 需求 |
| docs/specs/cross-use-inside-desktop/design.md | 新建 | 130 | 设计 |
| docs/specs/cross-use-inside-desktop/tasks.md | 新建 | 90 | 任务 |
| desktop-electron/electron/loopback-mesh.cjs | 新建 | 160 | mesh |
| desktop-electron/electron/external-services.cjs | 修改 | 40 | runtime env |
| desktop-electron/electron/managed-components.cjs | 修改 | 40 | peer env |
| desktop-electron/electron/managed-external-services.cjs | 修改 | 40 | 接线 |
| runtime-web/src/routed-providers.ts | 修改 | 40 | CommandCode 解析 |
| desktop-electron/tests/loopback-mesh.test.cjs | 新建 | 180 | 单测 |
| desktop-electron/tests/external-services-control-plane.test.cjs | 修改 | 20 | 合约 |
| runtime-web/tests/routed-providers.test.ts | 修改 | 30 | env 解析 |

---

## 检查清单

- [x] 交付物清单已填
- [x] 任务标题具体
- [x] 每条任务含证据块
- [x] 涉及文件与行数预算已填
- [x] 分阶段合理
- [x] 回链到 FR 与 design
- [x] 需求覆盖矩阵已填
- [x] 阶段 3 对照验收标准
- [x] 全文无占位符
