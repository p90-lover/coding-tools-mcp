# 任务清单：fully-integrate-five

## 概述

实现 fully-integrate-five：把 one-app managed 五栈合入 main，补 bootstrap 与半接线，升 Electron 身份到 0.7.0-rc.11，跑聚焦测试并开一条 PR。

---

## 交付物清单（Scope-lock）

- **预计新建文件数**: 8 个（规格 3、rc.11 workflow、rc.11 notes、rc.11 runner/verify、rc.11 identity 测试；bootstrap 若 cherry-pick 则计为引入而非手写）
- **预计修改文件数**: 约 25 个（merge 冲突 5、端口对齐、product identity、冻 rc.10 workflow、CommandCode 默认口）
- **预计新增/修改函数数**: 约 12 个（bootstrap 引入 + 端口/executionEndpoint 对齐 + identity helpers）
- **交付物逐项列举**:
  1. `docs/specs/fully-integrate-five/requirements.md`
  2. `docs/specs/fully-integrate-five/design.md`
  3. `docs/specs/fully-integrate-five/tasks.md`
  4. 合并后的 `desktop-electron/` 五栈运行时
  5. `desktop-electron/electron/managed-bootstrap.cjs`
  6. `desktop-electron/electron/product.cjs` 与 package 身份 `0.7.0-rc.11`
  7. `.github/workflows/codex-router-multiprovider-release-rc11.yml`
  8. `docs/releases/v0.7.0-rc.11.md`
  9. 冲突解决后的 `src-tauri` / CommandCode provider
  10. 一条指向 `main` 的 PR

---

## 任务列表

### 阶段 1: 准备工作

- [ ] 1.1 以 origin/main 建 `cursor/rc11-five-stack-integrate-657e` 并合并 one-app-tool-panels
  - **证据块**: merge-tree 仅冲突 `runtime-web/scripts/commandcode-proxy-provider.ts`、`src-tauri/src/auth/oauth_authorization_response.rs`、`src-tauri/src/data/mod.rs`、`src-tauri/src/integrations/mod.rs`、`src-tauri/src/lib.rs`
  - **涉及文件**: 上述 5 个冲突文件，行数预算每个小于 400；超 500 则按模块拆分 ours/theirs 手工拼接
  - _需求: FR-1_ ｜ _设计: 架构设计 / 决策 1_

- [ ] 1.2 并入 #185 managed-bootstrap 契约
  - **证据块**: `git merge-base --is-ancestor origin/feature/rc9-one-app-managed-bootstrap-core origin/integration/v0.7.0-rc.9-one-app-tool-panels-merge` 为 NO；diff 仅 `managed-bootstrap.cjs`、`managed-bootstrap.test.cjs`、workflow
  - **涉及文件**: `desktop-electron/electron/managed-bootstrap.cjs`（321 行）、`desktop-electron/tests/managed-bootstrap.test.cjs`（236 行）
  - _需求: FR-3_ ｜ _设计: 技术方案 / 编排_

---

### 阶段 2: 核心实现

- [ ] 2.1 对齐 CommandCode 默认端口到 managed 9090
  - **证据块**: `ProviderOrchestratorSurfaces.tsx` 仍返回 `http://127.0.0.1:3050/v1/`；manifest `PROXY_PORT=9090`
  - **涉及文件**: `desktop-electron/src/features/ProviderOrchestratorSurfaces.tsx`；必要时代码与测试小于 80 行
  - _需求: FR-3_ ｜ _设计: 决策 3_

- [ ] 2.2 让 Paseo executionEndpoint 命中 managed listen
  - **证据块**: `paseo.json` `PASEO_LISTEN=127.0.0.1:6768` 同时 `executionEndpoint=ws://127.0.0.1:6767/ws`
  - **涉及文件**: `desktop-electron/vendor/managed-components/paseo.json`、`electron/external-services.cjs`、`electron/managed-external-services.cjs`、相关 tests
  - _需求: FR-2, FR-3_ ｜ _设计: 决策 4_

- [ ] 2.3 按 #189 模式把 Electron 身份升到 0.7.0-rc.11 并冻 rc.10 push
  - **证据块**: rc.10 改了 `product.cjs`、`desktop-electron/package.json`、verify/prepare、identity tests、新 workflow、`docs/releases/v0.7.0-rc.10.md`
  - **涉及文件**: 同模式的 rc.11 文件；`codex-router-multiprovider-release-rc10.yml` 去掉 push
  - _需求: FR-4_ ｜ _设计: 决策 2_

- [ ] 2.4 确认五栈 Desktop 表面均接到 lifecycle IPC
  - **证据块**: Original UI / External Services / CommandCodeProxySurface 已有 start/stop；缺的是 bootstrap 与错误默认口
  - **涉及文件**: `desktop-electron/src/features/*Surface.tsx`、`preload.cjs`、`main.cjs`（只补缺口，不改 Browser/Setup/MCP/Activity/Settings）
  - _需求: FR-2, NFR-4_ ｜ _设计: 产品体验 / Original user interfaces_

---

### 阶段 3: 集成测试

- [ ] 3.1 跑 desktop-electron 五栈、bootstrap、identity 契约测试
  - **证据块**: 测试文件已在 one-app `desktop-electron/tests/`
  - **涉及文件**: 测试命令记录在 PR
  - _需求: FR-5_ ｜ _设计: 测试策略_

- [ ] 3.2 跑 Tauri CommandCode / version alignment（0.4.11 不变）
  - **证据块**: 根 `package.json` version `0.4.11`；`scripts/check-version-alignment.mjs` 要求稳定 X.Y.Z
  - **涉及文件**: 不修改 Tauri 版本文件
  - _需求: FR-4, FR-5, NFR-3_ ｜ _设计: 数据模型_

- [ ] 3.3 开一条合入 main 的 PR，附五栈状态表与验证步骤
  - **证据块**: 用户要求 github.com/p90-lover/coding-tools-mcp 上单一 PR
  - **涉及文件**: PR body
  - _需求: FR-1_ ｜ _设计: 概述_

---

## 检查点

- [ ] 阶段 1 完成后：功能分支含 desktop-electron 与 #181，冲突已解，bootstrap 文件存在
- [ ] 阶段 2 完成后：五栈默认口/健康口一致，产品身份为 0.7.0-rc.11，rc.10 不再自动 push
- [ ] 阶段 3 完成后：聚焦测试通过或写明 blocker，PR 已开

---

## 需求覆盖矩阵

| 需求 ID | 设计章节 | 任务编号 | 状态 |
|---------|----------|----------|------|
| FR-1 | 架构设计 / 决策 1 | 1.1, 3.3 | 未开始 |
| FR-2 | 技术方案 / API 设计 | 2.2, 2.4, 3.1 | 未开始 |
| FR-3 | 决策 3 / 决策 4 | 1.2, 2.1, 2.2 | 未开始 |
| FR-4 | 决策 2 | 2.3, 3.2 | 未开始 |
| FR-5 | 测试策略 | 3.1, 3.2 | 未开始 |
| NFR-1 | 测试策略 | 2.4, 3.1 | 未开始 |
| NFR-2 | 安全边界（one-app 设计复用） | 2.4 | 未开始 |
| NFR-3 | 数据模型 | 2.3, 3.2 | 未开始 |
| NFR-4 | 范围边界 | 2.4 | 未开始 |

---

## 文件变更清单

| 文件 | 操作 | 行数预算 | 说明 |
|------|------|----------|------|
| docs/specs/fully-integrate-five/*.md | 新建 | 250/文件 | 规格 |
| desktop-electron/** | 合并引入 | 既存 | one-app 五栈 |
| desktop-electron/electron/managed-bootstrap.cjs | 引入 | 321 | #185 |
| desktop-electron/src/features/ProviderOrchestratorSurfaces.tsx | 修改 | 20 | 9090 |
| desktop-electron/vendor/managed-components/paseo.json | 修改 | 10 | 执行口 |
| desktop-electron/electron/product.cjs | 修改 | 4 | rc.11 |
| desktop-electron/package.json | 修改 | 2 | rc.11 |
| .github/workflows/codex-router-multiprovider-release-rc11.yml | 新建 | 95 | 发版 |
| docs/releases/v0.7.0-rc.11.md | 新建 | 70 | notes |
| src-tauri/src/lib.rs 等 | 修改 | 冲突处 | 保留双侧 IPC |

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
- [x] 全文无占位符
