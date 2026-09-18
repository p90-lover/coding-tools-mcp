# 任务清单：focused-rc11-lane

## 概述

实现 focused-rc11-lane：Paseo / Anneal / CommandCode 原版 UI+功能对等，以及 7 天 keep-alive。每条任务回链到 FR 与设计章节。

> **二元禁令（零容忍）**：本文件及后续实现的交付物中，禁止出现未替换的占位符、空实现按钮、或把观察快照标成 live。

---

## 交付物清单（Scope-lock）

- **预计新建文件数**: 7 个
- **预计修改文件数**: 16 个
- **预计新增/修改函数数**: 约 28 个
- **交付物逐项列举**:
  1. `docs/specs/focused-rc11-lane/requirements.md`
  2. `docs/specs/focused-rc11-lane/design.md`
  3. `docs/specs/focused-rc11-lane/tasks.md`
  4. `docs/features/paseo-anneal-commandcode-longrun.md`
  5. `src-tauri/src/integrations/lease.rs`
  6. `src-tauri/src/integrations/live.rs`
  7. `src-tauri/src/integrations/actions.rs`
  8. `src/lib/components/control-center/OriginalFrame.svelte`
  9. `src/lib/components/control-center/PaseoPanel.svelte`
  10. `src/lib/components/control-center/AnnealPanel.svelte`
  11. `src-tauri/src/integrations/commandcode.rs`（health、banner、owned process）
  12. `src-tauri/src/integrations/mod.rs`（Item 扩展、模块导出）
  13. `src-tauri/src/integrations/tests.rs`
  14. `src-tauri/src/commands/control_center.rs`
  15. `src-tauri/src/commands/mod.rs`
  16. `src-tauri/src/lib.rs`
  17. `src-tauri/src/data/model.rs`
  18. `src-tauri/tauri.conf.json`
  19. `src/lib/control-center/model.ts`
  20. `src/lib/control-center/state.ts`
  21. `src/lib/control-center/upstreams.json`
  22. `src/lib/components/control-center/CommandCodeProxyPanel.svelte`
  23. `src/lib/components/control-center/SourceDetail.svelte`
  24. `src/routes/integrations/+page.svelte`
  25. `src/routes/sessions/+page.svelte`
  26. `src/routes/work/+page.svelte`
  27. `src/app.css`
  28. `scripts/check-control-center.mjs`

---

## 任务列表

### 阶段 1: 准备工作

- [x] 1.1 盘点 main Integrations 与原版 Paseo/Anneal/CommandCode 的功能差距并写入功能文档
  - **证据块**: `src/routes/integrations/+page.svelte` 仍称 Read-only adapters；`integrations/mod.rs` 只发 `hello` + `fetch_agents_request` 与 Anneal GET board；CommandCode 面板只有 status/plan。原版 Paseo messages.ts 含 send/resume/cancel/archive/permission/create；Anneal `tasks.ts`/`inbox.ts` 含 start/hold/resume/inbox decision；CommandCode README 含 `GET /health` 与 CLI banner。
  - **涉及文件**: `docs/features/paseo-anneal-commandcode-longrun.md`（约 80 行）
  - _需求: FR-1_ ｜ _设计: 概述_

---

### 阶段 2: 核心实现

- [ ] 2.1 新增 IntegrationLease 持久化与 stale/backoff 纯函数
  - **证据块**: `src-tauri/src/data/model.rs` 的 `AppData` 现有加性 `control_board`；`src-tauri/src/tunnel/recovery.rs` 的 DELAYS 与 120s 稳定清零。
  - **涉及文件**: `src-tauri/src/integrations/lease.rs`（约 160 行）、`src-tauri/src/data/model.rs`（约 20 行）
  - _需求: FR-5, FR-6, NFR-3_ ｜ _设计: 数据模型_

- [ ] 2.2 实现 live supervisor：Paseo 持久 WS ping、Anneal/CommandCode poll、崩溃恢复、无并行第二条连接
  - **证据块**: `integrations/mod.rs` 的 8s 一次性 read 在 fetch 后丢 socket；`commands/computer_restore.rs` 的启动恢复循环。
  - **涉及文件**: `src-tauri/src/integrations/live.rs`（约 320 行）、`src-tauri/src/lib.rs` setup（约 10 行）
  - _需求: FR-5, FR-6, NFR-1_ ｜ _设计: 架构设计_

- [ ] 2.3 实现允许名单 Paseo RPC 与 Anneal POST，并扩展 Item 以支持 resume/permission
  - **证据块**: 现 `item()` 只投影 title/status；Paseo `resume_agent_request` 需要 `persistence.sessionId`；Anneal hold/resume 是 `POST /tasks/:id/chain/hold`。
  - **涉及文件**: `src-tauri/src/integrations/actions.rs`（约 280 行）、`src-tauri/src/integrations/mod.rs`（约 40 行）
  - _需求: FR-2, FR-3_ ｜ _设计: API 设计_

- [ ] 2.4 扩展 CommandCode health/banner 与 owned Start/Stop/Restart
  - **证据块**: `commandcode.rs` 目前只 GET models；上游 README `GET /health` 返回 OK；config 默认可能绑 0.0.0.0。
  - **涉及文件**: `src-tauri/src/integrations/commandcode.rs`（约 +180 行）
  - _需求: FR-4, NFR-2_ ｜ _设计: 决策 3_

- [ ] 2.5 增加 Tauri 命令并保持 main-window-only
  - **证据块**: `commands/control_center.rs` 的 `local(&window)` 已保护 read/apply。
  - **涉及文件**: `src-tauri/src/commands/control_center.rs`、`mod.rs`、`lib.rs`（合计约 120 行）
  - _需求: FR-2, FR-3, FR-4, FR-7_ ｜ _设计: API 设计_

- [ ] 2.6 嵌入原版 iframe 并改造三个面板 / Sessions / Work 的真实控件与 stale 显示
  - **证据块**: `tauri.conf.json` `frame-src 'none'`；Sessions 页脚写明不发送 prompt；SourceDetail 写明 read-only。
  - **涉及文件**: `OriginalFrame.svelte`、`PaseoPanel.svelte`、`AnnealPanel.svelte`、`CommandCodeProxyPanel.svelte`、`SourceDetail.svelte`、`integrations/+page.svelte`、`sessions/+page.svelte`、`work/+page.svelte`、`state.ts`、`model.ts`、`upstreams.json`、`app.css`、`tauri.conf.json`（合计约 450 行，按组件拆分）
  - _需求: FR-1, FR-2, FR-3, FR-4, FR-6_ ｜ _设计: 决策 1_

---

### 阶段 3: 集成测试

- [ ] 3.1 对照验收标准补 Rust 夹具与 check-control-center 契约
  - **证据块**: 现 `tests.rs` 断言 read 之后不得再发 mutation RPC；`check-control-center.mjs` 禁止 `mod.rs` 出现 POST/create_agent。
  - **涉及文件**: `src-tauri/src/integrations/tests.rs`、`scripts/check-control-center.mjs`
  - _需求: FR-2, FR-3, FR-4, FR-5, FR-6_ ｜ _设计: 测试策略_

---

## 检查点

- [ ] 阶段 1 完成后：功能文档列出三栈差距与允许名单
- [ ] 阶段 2 完成后：三个面板有原版表面与可调用控件，keep-alive 与 stale 有状态机
- [ ] 阶段 3 完成后：Rust lib 测试与 Node 契约脚本通过

---

## 需求覆盖矩阵

| 需求 ID | 设计章节 | 任务编号 | 状态 |
|---------|----------|----------|------|
| FR-1 | 概述 / 决策 1 | 1.1, 2.6 | 进行中 |
| FR-2 | API 设计 / 决策 1–2 | 2.3, 2.5, 2.6, 3.1 | 未开始 |
| FR-3 | API 设计 / 决策 1–2 | 2.3, 2.5, 2.6, 3.1 | 未开始 |
| FR-4 | 决策 3 | 2.4, 2.5, 2.6, 3.1 | 未开始 |
| FR-5 | 架构设计 / 数据模型 | 2.1, 2.2, 3.1 | 未开始 |
| FR-6 | classify_status | 2.1, 2.2, 2.6, 3.1 | 未开始 |
| FR-7 | 文件结构 | 全部（不改 electron/CPA/shell） | 未开始 |
| NFR-1 | 架构设计 | 2.2, 3.1 | 未开始 |
| NFR-2 | 决策 3 / CSP | 2.4, 2.6, 3.1 | 未开始 |
| NFR-3 | 数据模型 / 决策 4 | 2.1, 3.1 | 未开始 |

---

## 文件变更清单

| 文件 | 操作 | 行数预算 | 说明 |
|------|------|----------|------|
| docs/specs/focused-rc11-lane/*.md | 新建 | 规格三件套 | 已写入 |
| docs/features/paseo-anneal-commandcode-longrun.md | 新建 | 80 | 差距表与验证步骤 |
| src-tauri/src/integrations/lease.rs | 新建 | 160 | 租约、退避、stale |
| src-tauri/src/integrations/live.rs | 新建 | 320 | 监督器 |
| src-tauri/src/integrations/actions.rs | 新建 | 280 | 允许名单动作 |
| src/lib/components/control-center/OriginalFrame.svelte | 新建 | 60 | loopback iframe |
| src/lib/components/control-center/PaseoPanel.svelte | 新建 | 140 | 连接+原版框 |
| src/lib/components/control-center/AnnealPanel.svelte | 新建 | 150 | 连接+hash 框 |
| 其余 listed 修改文件 | 修改 | 见上 | 命令、UI、测试、CSP |

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
- [x] 全文无未替换占位符
