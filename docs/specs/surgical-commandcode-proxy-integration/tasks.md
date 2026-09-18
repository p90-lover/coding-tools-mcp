# 任务清单：surgical-commandcode-proxy-integration

## 概述

实现 surgical-commandcode-proxy-integration。每条任务回链到需求与设计，不越界到 Electron / CPA / 多帐户 / 执行引擎。

---

## 交付物清单（Scope-lock）

- **预计新建文件数**: 6 个
- **预计修改文件数**: 7 个
- **预计新增/修改函数数**: 约 12 个
- **交付物逐项列举**:
  1. `src/lib/control-center/commandcode-proxy-provider.ts`
  2. `runtime-web/scripts/commandcode-proxy-provider.ts`
  3. `src/lib/components/control-center/CommandCodeProxyPanel.svelte`
  4. `src-tauri/src/integrations/commandcode.rs`
  5. `scripts/check-commandcode-proxy.mjs`
  6. `docs/features/commandcode-proxy-control-center.md`
  7. `src/routes/integrations/+page.svelte`（修改）
  8. `scripts/check-control-center.mjs`（修改）
  9. `src-tauri/src/integrations/mod.rs`（修改）
  10. `src-tauri/src/integrations/tests.rs`（修改）
  11. `src-tauri/src/commands/control_center.rs`（修改）
  12. `src-tauri/src/commands/mod.rs`（修改）
  13. `src-tauri/src/lib.rs`（修改）

---

## 任务列表

### 阶段 1: 准备工作

- [ ] 1.1 确认 main Integrations 仅有 Paseo/Anneal 且 commandcode-proxy 缺席
  - **证据块**: `src/routes/integrations/+page.svelte:13-14` 只遍历 `['paseo','anneal']`；`src/lib/control-center/model.ts` 的 `Source` 为 `'paseo' | 'anneal'`；`origin/main` 无 `runtime-web/scripts/commandcode-proxy-provider.ts`。
  - **涉及文件**: `src/routes/integrations/+page.svelte`（约 30 行只读）
  - _需求: FR-1, FR-4_ ｜ _设计: 架构设计_

---

### 阶段 2: 核心实现

- [ ] 2.1 移植注册计划纯函数到 `$lib` 并保留 runtime-web CLI 路径
  - **证据块**: 0.7 `commandCodeProxyRegistrationPlan` 产出 generic add/credential/enable 与 `curate-models`；`commandCodeProxyProviderProfile` 规范化 baseUrl 并固定 adapter `openai-chat`。
  - **涉及文件**: `src/lib/control-center/commandcode-proxy-provider.ts`（约 120 行）；`runtime-web/scripts/commandcode-proxy-provider.ts`（约 80 行）
  - _需求: FR-1_ ｜ _设计: 决策 2_

- [ ] 2.2 增加 loopback-only Tauri 状态探测与非密钥 apply
  - **证据块**: `src-tauri/src/integrations/mod.rs:61-95` 的 `endpoint` 只接受 Paseo/Anneal；`src-tauri/src/commands/control_center.rs:32-39` 的 `integration_read` 不应被扩成第三 Source。
  - **涉及文件**: `commandcode.rs`（约 180 行）；`control_center.rs` / `mod.rs` / `lib.rs`（各约 15 行）
  - _需求: FR-2, FR-3, NFR-2_ ｜ _设计: 决策 1, 决策 3_

- [ ] 2.3 在 Integrations 增加 CommandCode 面板并做 Anneal 端口转发复制
  - **证据块**: `src/routes/integrations/+page.svelte:20` 已写明 loopback/端口转发，但没有复制按钮；页面在 grid 结束后没有第三集成。
  - **涉及文件**: `CommandCodeProxyPanel.svelte`（约 160 行）；`+page.svelte`（约 40 行增量）
  - _需求: FR-2, FR-3, FR-4_ ｜ _设计: 架构设计_

---

### 阶段 3: 集成测试

- [ ] 3.1 对照 FR-1 到 FR-4 核验计划契约、页面断言与 Rust loopback 夹具
  - **证据块**: `scripts/check-control-center.mjs:15-31` 只覆盖 model/board 唯读；`src-tauri/src/integrations/tests.rs:99-175` 覆盖 Anneal GET 与 Paseo hello。
  - **涉及文件**: `scripts/check-commandcode-proxy.mjs`；`scripts/check-control-center.mjs`；`src-tauri/src/integrations/tests.rs`
  - _需求: FR-1, FR-2, FR-3, FR-4_ ｜ _设计: 测试策略_

---

## 检查点

- [ ] 阶段 1 完成后：确认从 `546fbb37` 分支，且不包含 desktop-electron 改动
- [ ] 阶段 2 完成后：计划函数、状态命令、Integrations 面板均存在且不改 `Source`
- [ ] 阶段 3 完成后：control-center 契约与相关 cargo test 通过

---

## 需求覆盖矩阵

| 需求 ID | 设计章节 | 任务编号 | 状态 |
|---------|----------|----------|------|
| FR-1 | 决策 2 | 1.1, 2.1, 3.1 | 未开始 |
| FR-2 | 决策 1 | 2.2, 2.3, 3.1 | 未开始 |
| FR-3 | 决策 3 | 2.2, 2.3, 3.1 | 未开始 |
| FR-4 | 架构设计 | 1.1, 2.3, 3.1 | 未开始 |
| NFR-1 | API 设计 | 2.2 | 未开始 |
| NFR-2 | 决策 3 | 2.2, 3.1 | 未开始 |
| NFR-3 | 决策 1 | 2.2, 3.1 | 未开始 |

---

## 文件变更清单

| 文件 | 操作 | 行数预算 | 说明 |
|------|------|----------|------|
| src/lib/control-center/commandcode-proxy-provider.ts | 新建 | 120 | 0.7 计划纯函数 |
| runtime-web/scripts/commandcode-proxy-provider.ts | 新建 | 80 | CLI 再导出 |
| src/lib/components/control-center/CommandCodeProxyPanel.svelte | 新建 | 160 | 状态 + 计划 UX |
| src/routes/integrations/+page.svelte | 修改 | 40 | 挂面板与 Anneal 复制 |
| src-tauri/src/integrations/commandcode.rs | 新建 | 180 | status/apply |
| src-tauri/src/integrations/mod.rs | 修改 | 5 | 声明模块 |
| src-tauri/src/integrations/tests.rs | 修改 | 80 | loopback 夹具 |
| src-tauri/src/commands/control_center.rs | 修改 | 30 | 新命令 |
| src-tauri/src/commands/mod.rs | 修改 | 5 | 再导出 |
| src-tauri/src/lib.rs | 修改 | 10 | generate_handler |
| scripts/check-commandcode-proxy.mjs | 新建 | 80 | 计划契约 |
| scripts/check-control-center.mjs | 修改 | 20 | 接入新契约 |
| docs/features/commandcode-proxy-control-center.md | 新建 | 40 | 验证说明 |

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
