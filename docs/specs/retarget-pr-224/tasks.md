# 任务清单：retarget-pr-224

## 概述

把 #224 重置到 #221 顶端，只保留 CommandCode / Paseo / Anneal 的 in-tree source 与 lane 测试，使用 #221 的 handler-registry。

> **二元禁令（零容忍）**：本文件及后续实现的交付物中，禁止出现未填占位。

---

## 交付物清单（Scope-lock）

- **预计新建文件数**: 约 16 个（三个 `source/` 树、lane 测试、规格三件套已写入）
- **预计修改文件数**: 约 6 个（三份 `module.json`、三份模块 README、workflow、feature 文档）
- **预计新增/修改函数数**: 0 个生产函数；不改 `handler-registry.cjs`
- **交付物逐项列举**:
  1. Git branch `cursor/rc11-cc-paseo-anneal-original-ui-7a2a` reset onto `origin/cursor/desktop-ui-ipc-proxy-fix-dc79`
  2. `modules/commandcode-proxy/source/` in-tree proxy
  3. `modules/paseo/source/BUNDLE.json` and README
  4. `modules/anneal/source/BUNDLE.json` and README
  5. `module.json` source pointers for those three ids
  6. `desktop-electron/tests/rc11-cc-paseo-anneal-original-ui.test.cjs`
  7. `.github/workflows/rc11-cc-paseo-anneal-original-ui.yml` targeting #221 branch
  8. `docs/features/paseo-anneal-commandcode-original-panels.md`
  9. PR #224 base + body update

---

## 任务列表

### 阶段 1: 准备工作

- [ ] 1.1 Restore probe-kit mutations and reset the working branch onto #221 head `3ce103014d641571c6b30e30d0dae94c24a4f0be`
  - **证据块**: `gh pr view 221` headRefName `cursor/desktop-ui-ipc-proxy-fix-dc79`; `git merge-base` with #214 is `7f942fb7` so a three-commit rebase would replay #214-only files
  - **涉及文件**: git refs only; 0 行生产代码
  - _需求: FR-1_ ｜ _设计: 决策 1_

---

### 阶段 2: 核心实现

- [ ] 2.1 Restore in-tree source under `modules/commandcode-proxy|paseo|anneal/source/` from commit `4e7fe75d` without checking out the forked `handler-registry.cjs` or simplified `handler.cjs`
  - **证据块**: #221 `modules/commandcode-proxy/handler.cjs` is `wrapInProcessHandler(createModule)`; old #224 handler only listed health/models/banner
  - **涉及文件**: `modules/commandcode-proxy/source/*` (~proxy.mjs 既有), `modules/paseo/source/*`, `modules/anneal/source/*`; 不改 handlers.cjs
  - _需求: FR-2_ ｜ _设计: 架构设计_
- [ ] 2.2 Point the three `module.json` files at in-tree source while keeping #221 transport and legacyLoopback
  - **证据块**: #221 commandcode-proxy `module.json` has id/name/kind/transport/legacyLoopback and no source path
  - **涉及文件**: 三个 `module.json`，每个约 +8 行
  - _需求: FR-2_ ｜ _设计: 数据模型_
- [ ] 2.3 Rewrite the lane test and workflow so they consume #221 registry (FOREIGN_SLOTS present) and do not require Managed Apps files
  - **证据块**: old test `assert.equal(fs.existsSync(modules/cpa), false)` will fail on #221; workflow still targets `feature/rc11-managed-app-api-handles`
  - **涉及文件**: `desktop-electron/tests/rc11-cc-paseo-anneal-original-ui.test.cjs`, `.github/workflows/rc11-cc-paseo-anneal-original-ui.yml`, `docs/features/paseo-anneal-commandcode-original-panels.md`
  - _需求: FR-1, FR-3, NFR-3_ ｜ _设计: 测试策略_

---

### 阶段 3: 集成测试

- [ ] 3.1 Run focused node --check and node --test for the three modules plus `modules-apps-host.test.cjs`, then push, retarget PR #224, wait CI, mark ready when green
  - **证据块**: #221 `modules-apps-host.test.cjs` already asserts five MODULE_IDS and in-process host
  - **涉及文件**: 测试命令与 PR metadata
  - _需求: FR-1, FR-3_ ｜ _设计: 测试策略_

---

## 检查点

- [ ] 阶段 1 完成后：`git merge-base HEAD origin/cursor/desktop-ui-ipc-proxy-fix-dc79` 等于 #221 HEAD
- [ ] 阶段 2 完成后：`git diff --name-only origin/cursor/desktop-ui-ipc-proxy-fix-dc79` 不含 `modules/handler-registry.cjs`、`modules/cpa`、`modules/codex-router` 新增
- [ ] 阶段 3 完成后：focused tests 退出码 0，PR base 为 #221 分支，CI 绿后取消 draft

---

## 需求覆盖矩阵

| 需求 ID | 设计章节 | 任务编号 | 状态 |
|---------|----------|----------|------|
| FR-1 | 决策 1 | 1.1, 2.3, 3.1 | 未开始 |
| FR-2 | 架构设计 / 数据模型 | 2.1, 2.2 | 未开始 |
| FR-3 | API 设计 / 测试策略 | 2.3, 3.1 | 未开始 |
| NFR-3 | 测试策略 | 2.3, 3.1 | 未开始 |

---

## 文件变更清单

| 文件 | 操作 | 行数预算 | 说明 |
|------|------|----------|------|
| modules/commandcode-proxy/source/* | 新建 | 既有 proxy 树 | 从 4e7fe75d 恢复 |
| modules/paseo/source/* | 新建 | <40 | BUNDLE + README |
| modules/anneal/source/* | 新建 | <40 | BUNDLE + README |
| modules/*/module.json | 修改 | +8 each | source 指针 |
| desktop-electron/tests/rc11-cc-paseo-anneal-original-ui.test.cjs | 新建 | <120 | lane contracts |
| .github/workflows/rc11-cc-paseo-anneal-original-ui.yml | 新建 | <110 | 目标 #221 |
| docs/features/paseo-anneal-commandcode-original-panels.md | 新建 | <80 | 叠在 #221 |

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
- [x] 全文无未填占位
