# 任务清单：no-download-before-use-bundling-commandcode

## 概述

实现 bundled-source，使 CommandCode/Paseo/Anneal 随 Desktop 分发并可直接 Start。禁止占位符。

---

## 交付物清单（Scope-lock）

- **预计新建文件数**: 6 个
- **预计修改文件数**: 13 个
- **预计新增/修改函数数**: 约 8 个
- **交付物逐项列举**:
  1. `docs/specs/no-download-before-use-bundling-commandcode/requirements.md`
  2. `docs/specs/no-download-before-use-bundling-commandcode/design.md`
  3. `docs/specs/no-download-before-use-bundling-commandcode/tasks.md`
  4. `desktop-electron/electron/managed-components.cjs` bundled-source 完整接线
  5. `desktop-electron/vendor/managed-components/commandcode-proxy.json`
  6. `desktop-electron/vendor/managed-components/paseo.json`
  7. `desktop-electron/vendor/managed-components/anneal.json`
  8. `desktop-electron/vendor/bundled/commandcode-proxy/**`
  9. `desktop-electron/vendor/bundled/paseo/BUNDLE.json`
  10. `desktop-electron/vendor/bundled/anneal/BUNDLE.json`
  11. `desktop-electron/scripts/vendor-upstream-bundles.cjs`
  12. `desktop-electron/scripts/prepare-package-resources.cjs` 写入 bundled-components
  13. `desktop-electron/electron/managed-external-services.cjs` Start 自动激活
  14. `desktop-electron/src/features/ExternalServicesSurface.tsx` 去闸门
  15. `desktop-electron/src/features/UpstreamToolSurface.tsx` 文案
  16. `desktop-electron/src/types.ts` strategy 联合
  17. `desktop-electron/package.json` files 含 vendor/bundled/**
  18. `desktop-electron/tests/bundled-components.test.cjs`
  19. 更新 rc9/rc11 五栈与 bootstrap 合约测试

---

## 任务列表

### 阶段 1: 准备工作

- [x] 1.1 确认 graph-insights 与 managed-components 现状后落盘规格
  - **证据块**: `desktop-electron/electron/managed-components.cjs` 已含 `ALLOWED_STRATEGIES` 的 `bundled-source` 与 `copyBundledTree`，但 `createManagedComponentController` 签名被插入函数打断；manifest 仍为 `git-source`。
  - **涉及文件**: `docs/specs/no-download-before-use-bundling-commandcode/*.md` 约 250 行
  - _需求: FR-1, FR-2, FR-3, FR-4_ ｜ _设计: 概述_

---

### 阶段 2: 核心实现

- [ ] 2.1 修复 controller 并完成 bundled-source 复制/安装/Start
  - **证据块**: `managed-components.cjs` 387 行起参数列表悬空；`installComponent` 1013 行非 release-binary 一律 `prepareGitSource`；`startComponent` 1088 行要求已安装。
  - **涉及文件**: `desktop-electron/electron/managed-components.cjs` 约 +80 行；`managed-external-services.cjs` 约 +20 行
  - _需求: FR-1, FR-2_ ｜ _设计: 技术方案_

- [ ] 2.2 将三者 manifest 改为 bundled-source 且 Anneal token 可选
  - **证据块**: 三份 json `strategy: git-source`；anneal `credentials.githubReadToken.required: true`。
  - **涉及文件**: `vendor/managed-components/{commandcode-proxy,paseo,anneal}.json`；`vendor/bundled/**`
  - _需求: FR-1, FR-2, FR-3_ ｜ _设计: 数据模型_

- [ ] 2.3 打包期物化 extraResources 并去掉 UI 下载闸门
  - **证据块**: `package.json` files 无 `vendor/bundled/**`；`ExternalServicesSurface.tsx` 464-477 行 Install/Repair 对所有服务显示；Anneal token 文案 required。
  - **涉及文件**: `vendor-upstream-bundles.cjs`、`prepare-package-resources.cjs`、`package.json`、`types.ts`、`ExternalServicesSurface.tsx`、`UpstreamToolSurface.tsx`
  - _需求: FR-3, NFR-1_ ｜ _设计: 决策 2, 决策 3_

---

### 阶段 3: 集成测试

- [ ] 3.1 对照 FR 验收跑 bundled 单测与五栈合约
  - **证据块**: `rc9-managed-five-stack.test.cjs` 仍断言 `git-source`；`rc9-five-stack-completion.test.cjs` 断言 token required true。
  - **涉及文件**: `desktop-electron/tests/bundled-components.test.cjs`、`rc9-managed-five-stack.test.cjs`、`rc9-five-stack-completion.test.cjs`、`original-upstream-panels.test.cjs`
  - _需求: FR-1, FR-2, FR-3, FR-4_ ｜ _设计: 测试策略_

---

## 检查点

- [ ] 阶段 1 完成后：三份规格无占位符，check_spec 通过
- [ ] 阶段 2 完成后：三者 strategy 为 bundled-source，Start 不 git clone，UI 不挡这三者
- [ ] 阶段 3 完成后：相关 node:test 通过

---

## 需求覆盖矩阵

| 需求 ID | 设计章节 | 任务编号 | 状态 |
|---------|----------|----------|------|
| FR-1 | 技术方案 / 决策 1 | 2.1, 2.2, 3.1 | 进行中 |
| FR-2 | 技术方案 / 决策 1 | 2.1, 2.2, 2.3, 3.1 | 未开始 |
| FR-3 | 决策 2 / 决策 3 | 2.2, 2.3, 3.1 | 未开始 |
| FR-4 | 测试策略 | 3.1 | 未开始 |
| NFR-1 | 决策 1 | 2.3 | 未开始 |
| NFR-2 | 数据模型 | 2.1, 2.2 | 未开始 |
| NFR-3 | 技术方案 | 2.3, 3.1 | 未开始 |

---

## 文件变更清单

| 文件 | 操作 | 行数预算 | 说明 |
|------|------|----------|------|
| docs/specs/no-download-before-use-bundling-commandcode/requirements.md | 新建 | 120 | 需求 |
| docs/specs/no-download-before-use-bundling-commandcode/design.md | 新建 | 140 | 设计 |
| docs/specs/no-download-before-use-bundling-commandcode/tasks.md | 新建 | 90 | 任务 |
| desktop-electron/electron/managed-components.cjs | 修改 | 120 | 策略接线 |
| desktop-electron/electron/managed-external-services.cjs | 修改 | 25 | Start 自动 copy |
| desktop-electron/vendor/managed-components/commandcode-proxy.json | 修改 | 20 | bundled-source |
| desktop-electron/vendor/managed-components/paseo.json | 修改 | 20 | bundled-source |
| desktop-electron/vendor/managed-components/anneal.json | 修改 | 30 | bundled-source + token 可选 |
| desktop-electron/vendor/bundled/commandcode-proxy/** | 新建 | 上游树 | 真实 proxy |
| desktop-electron/vendor/bundled/paseo/BUNDLE.json | 新建 | 15 | pin |
| desktop-electron/vendor/bundled/anneal/BUNDLE.json | 新建 | 15 | pin |
| desktop-electron/scripts/vendor-upstream-bundles.cjs | 新建 | 180 | 打包物化 |
| desktop-electron/scripts/prepare-package-resources.cjs | 修改 | 20 | 调用 vendor |
| desktop-electron/package.json | 修改 | 5 | files glob |
| desktop-electron/src/types.ts | 修改 | 8 | strategy 联合 |
| desktop-electron/src/features/ExternalServicesSurface.tsx | 修改 | 40 | 去闸门 |
| desktop-electron/src/features/UpstreamToolSurface.tsx | 修改 | 15 | 文案 |
| desktop-electron/tests/bundled-components.test.cjs | 新建 | 180 | 单测 |
| desktop-electron/tests/rc9-managed-five-stack.test.cjs | 修改 | 30 | 合约 |
| desktop-electron/tests/rc9-five-stack-completion.test.cjs | 修改 | 10 | token 可选 |
| desktop-electron/tests/original-upstream-panels.test.cjs | 修改 | 10 | 文案 |

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
- [x] 全文无占位符
