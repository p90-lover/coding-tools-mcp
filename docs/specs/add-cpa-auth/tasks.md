# 任务清单：Reset-aligned CPA usage

## 概述
Implement FR-1 and FR-2 in the existing CPA usage path, preserving all rolling/turn-stat operations.

## 交付物清单（Scope-lock）
Three spec documents, one new reset-usage test file, four modified production files and two modified test files. Approximately six existing functions change; new helpers remain in cpa-usage.cjs. Changes to the existing large injection file stay confined to authFilesUsageScript; no broad extraction.

## 任务列表
- [ ] 1.1 Validate graph impact before editing the usage loader and card injection (FR-1, FR-2; design Technical approach).
  - **证据块**: cpa-usage.cjs load computes from = now() - span; cpa-panel-session.cjs:775 uses RANGES = [['5h', 'Last 5 h'], ['7d', 'Last 7 days']]. These are rolling windows.
  - Files: existing production paths, read-only graph analysis.
- [ ] 2.1 Add active-window aggregation with separate reset boundaries and bounded concurrency (FR-1; design Data model/API).
  - **证据块**: cpa-usage.cjs already provides mapLimited, modelRow, aggregateUsage and cached read; reuse their cost logic.
  - Files: cpa-usage.cjs, budget +110 lines; existing file exceeds 500 lines, keep the addition an isolated loader/helper rather than changing turn logic.
- [ ] 2.2 Project window metadata and show honest reset-aware card rows (FR-2; design Decisions).
  - **证据块**: bridge publicUsage explicitly projects fields; card money currently prints cost unknown; render keys only by file and loadedAt.
  - Files: cpa-usage.ts +6 lines, cpa-provider-usage-bridge.ts +6 lines, cpa-panel-session.cjs +45 lines. The injection file exceeds 500 lines; confine to its existing card script.
- [ ] 3.1 Verify boundary filtering, query limits, cache rollover, missing metadata, Null costs and frame privacy (FR-1, FR-2; design Test strategy).
  - **证据块**: cpa-card-usage.test.cjs expects Last 5 h and Last 7 days and has a minimal DOM fixture; extend it with a controllable clock.
  - Files: cpa-reset-usage.test.cjs new, budget 260 lines; cpa-card-usage.test.cjs +100; cpa-provider-usage-bridge.test.cjs +30.
- [ ] 3.2 Run full regression/typecheck and preview, then PR/merge/release with the single release owner (FR-1, FR-2; design Test strategy).

## 检查点
Pre-edit impact; spec validation; affected tests; full suite/typecheck; preview; graph diff check; exact scoped commit; merged PR; verified published assets. No install/restart.

## 需求覆盖矩阵
FR-1: tasks 1.1, 2.1, 3.1, 3.2. FR-2: tasks 1.1, 2.2, 3.1, 3.2. NFRs: concurrency, privacy and compatibility assertions in 3.1 and full suite in 3.2.

## 文件变更清单
The file paths and line budgets above are the complete implementation scope. Specs are recorded under docs/specs/add-cpa-auth. Release notes/versioning are coordinated separately with the release owner.

## 检查清单
- [x] Tasks map to requirements and identify observed code and bounded edits.
- [ ] Completed deliverables and verification evidence match this scope.
