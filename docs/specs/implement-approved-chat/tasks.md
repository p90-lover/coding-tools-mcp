# 任务清单：Chat harness performance and quality
## 概述
Implement FR-1 through FR-4 in a clean worktree based on main 9e42fa955; preserve the primary dirty checkout.
## 交付物清单（Scope-lock）
Expected new files: metrics module/test, acceptance module if needed, offline benchmark, and three specification documents.
Expected modified files: workflow/upstream and their tests; AO Rust/controller tests and module registration; frontend run types/rendering and relevant contract tests.
No vendored binaries, built assets, provider configuration, release version or unrelated source changes.
## 任务列表
### 阶段 1: 准备工作
- [x] 1.1 Freeze source scope, refresh own graph and analyze every changed symbol before edits.
  - **证据块**: workflow reportRun observes run state; upstream observe reads session and conversation; Assignment stores acceptance prose; planner roster requests every worker.
  - Files: existing graph and source reads; no source edits. 需求: FR-1, FR-2, FR-3, FR-4. 设计: 架构设计.
### 阶段 2: 核心实现
- [x] 2.1 Add bounded actual-observation timing snapshots and connect run_status/UI.
  - **证据块**: workflow reportRun and runStatus already expose bounded lifecycle state.
  - Files: metrics module under 220 lines; workflow integration under 90 lines; frontend display under 100 lines. 需求: FR-1. 设计: 数据模型.
- [x] 2.2 Coalesce session observations and invalidate current-turn cache using existing event watchers.
  - **证据块**: upstream observe and conversationTail plus workflow activity independently retrieve overlapping state.
  - Files: upstream/workflow additions under 250 lines each; reuse helpers instead of duplicating transports. 需求: FR-2. 设计: 决策 1.
- [x] 2.3 Verify optional artifact digests at worker completion and final review with scoped reads and attempt binding.
  - **证据块**: Assignment acceptance is prose and Receipt identity already guards completion.
  - Files: ao.rs/ao_team.rs bounded extensions; acceptance module under 350 lines excluding focused tests; register module. 需求: FR-3. 设计: 决策 2.
- [x] 2.4 Accept explicit skipped worker assignments while preserving required roles and selected-worker dependencies.
  - **证据块**: current planner roster and review fan-in cover all configured workers.
  - Files: existing AO functions and tests, frontend skipped/evidence rendering under 100 lines. 需求: FR-4. 设计: 决策 3.
### 阶段 3: 集成测试
- [x] 3.1 Verify same fixture outputs with fewer redundant reads, deterministic timings, failed/stale/changed artifact rejection, explicit skips, mandatory review and legacy serialization.
  - **证据块**: existing focused Node/Rust controller tests exercise real production code with controlled IO.
  - Files: matching existing tests and small benchmark; all generated reports in this worktree aiTemp. 需求: FR-1, FR-2, FR-3, FR-4. 设计: 测试策略.
- [ ] 3.2 Review exact diff, run complete graph change analysis, publish source PR and verify CI.
  - **证据块**: GitHub CI declares Rust test/clippy on three platforms and frontend contracts.
  - Files: scoped source/tests/spec only. 需求: FR-1, FR-2, FR-3, FR-4. 设计: 测试策略.
## 检查点
Spec validation precedes source writes. Test failures and review findings are fixed before completion. No live app installation or real task replay.
## 需求覆盖矩阵
| 需求 ID | 设计章节 | 任务编号 | 状态 |
| FR-1 | 数据模型 | 2.1, 3.1 | Implemented; focused checks pass |
| FR-2 | 决策 1 | 2.2, 3.1 | Implemented; focused checks pass |
| FR-3 | 决策 2 | 2.3, 3.1 | Implemented; focused checks pass |
| FR-4 | 决策 3 | 2.4, 3.1 | Implemented; focused checks pass |
## 文件变更清单
Twenty source/test/spec files are published in PR #354. Local verification passed 210 focused tests with an empty Codex application-data profile, Electron TypeScript and renderer build, and the offline request-budget comparison. Linux, macOS and Windows Rust checks and frontend CI passed; the final clean-runner controller fixture correction awaits the current-head CI run. Generated metadata and scratch files are excluded.
## 检查清单
Tasks link to requirements; source evidence precedes edits; line budgets prevent unnecessary framework expansion.
