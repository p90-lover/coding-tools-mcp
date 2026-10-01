# Runtime AO company canvas — implementation design

## 概述

Covers FR-1 through FR-7 and NFR-1 through NFR-4. The approved visual is `aiTemp/ao-runtime-company-canvas-20260927.png`; the approved behavior is the linked company-canvas plan.

## 技术方案

Reuse React, the existing motion dependency, SVG connections, app-handler APIs and native execution adapters. Reuse the source AO board and project/session persistence. Do not add a generic RPC service or a second independent task database.

### 架构设计

The host owns workspace bindings, credentials, policy and resource limits. AO project/job IDs connect its Board to canvas role assignments. The execution adapter stores transport receipts and immutable attempt snapshots, not a competing user task board. One scheduler owns dispatch; all views and MCP actions go through its revisioned operations.

`Workspace / AO project -> Mission -> Role assignments -> Native execution receipts -> AO Board + Team canvas`

The original source UI remains available under More. Runtime reuses its board component without a second desktop shell. Canvas and inspector use host styling and retain project selection when switching views.

## 数据模型

| Entity | Required fields and constraints |
|---|---|
| Workspace binding | Canonical local path, Coding Tools workspace ID, AO project ID; no name-only matching |
| Team role | Stable ID, name, specialization, exact route, instructions, scope, position and revision |
| Mission | AO project/job references, goal, selected template revision, worker limit and lifecycle state |
| Attempt | Stable request key, captured role/graph settings, native thread/turn IDs, bounded output/error, review verdict |
| Limits | Trusted-user global maximum and per-mission maximum; initial value three; reductions affect future dispatch |

Active attempts are immutable. Applying an edit validates a new revision for queued assignments. A review return creates a new bounded attempt, not a cyclic dependency or resubmission of an uncertain request. Legacy mission records remain available for explicit mapping/import.

## API 设计

Use `codingTools.apps` and its `agent-orchestrator` handler. Existing `upstream_projects`, `upstream_sessions`, lifecycle and original-view operations bind the canonical AO project. Extend named operations for team metadata, revisioned edits and limit settings; do not expose arbitrary URLs. Existing start/progress/observe MCP operations retain strict workspace scope and no self-approval operation.

Mission creation resolves the exact route and returns a durable identity before dispatch. Start captures limits and settings. Reads return the same job identity in both views. Errors distinguish unavailable route, invalid dependency, capacity queue, permission wait, failed attempt and unknown outcome. UI Apply is explicit; routine actions do not add duplicate native confirmation dialogs.

## 文件结构

Reuse these existing paths: `desktop-electron/src/features/AgentOrchestratorSurface.tsx`, `AgentOrchestratorOriginalSurface.tsx`, `agent-orchestrator.css`, `desktop-electron/electron/agent-orchestrator-workflow.cjs`, `agent-orchestrator-upstream.cjs`, `app-handler/agent-orchestrator/handler.cjs`, `src-tauri/src/integrations/ao.rs`, `src-tauri/src/codex_bridge/mod.rs`, `rust-core/coding-tools-headless/src/lib.rs`, and `runtime-web/src/adapters/chatgpt-web/mcp-server.ts`.

Use the existing AO source under `module/agent-orchestrator`, especially its project configuration, session services and original `SessionsBoard`. Extract substantial new canvas/inspector or metadata logic into focused modules under 500 lines instead of extending existing large routers indefinitely. Select storage/controller extension points from the real project/session implementation before editing them.

## 设计决策

- FR-1: Canonical AO project/job state wins over maintaining two independent boards. Transport receipts may remain in the execution adapter, keyed to the canonical IDs.
- FR-2/FR-3: Reuse the existing graph validation and role editor foundations; separate visual position from execution dependency changes. Department grouping is not an execution edge.
- FR-4: Capacity is reserved before launching; nested AO allocation cannot evade the global/mission ceilings. A held or terminal attempt is reconciled before releasing capacity.
- FR-5/FR-6: Diagnose the real held planner first. Plugin path warnings are observations, not an established cause. Preserve the actual native failure and validate protocol compatibility before changing behavior.
- FR-7: Use the current branch and recoverable program/runtime backups. Only verified scoped changes enter the installed package; unrelated dirty-worktree content is preserved.

## 测试策略

Use failing-then-passing focused tests for protocol/receipt regressions, graph revisions/cycles/joins, queued edits, capacity races, rework limits and capability boundaries. Exercise actual IPC and MCP schemas. Test rendered Board/canvas identity, dragging, inspector edits, keyboard/reduced-motion behavior, and restart observation. Finally perform the real isolated three-stage mission and inspect receipts; verify installed hashes, both Runtime views and CPA navigation.

## 风险评估

| Risk | Impact | Mitigation |
|---|---|---|
| Divergent AO and legacy state | High | Canonical IDs, one dispatcher, explicit projection/migration and reconciliation tests |
| Native protocol failure loses diagnostics | High | Retain bounded failure before teardown; actual read-only probe and regression |
| Model/permission fallback | High | Exact catalog binding, captured policy, no agent self-approval |
| Concurrent edits or dispatch | High | Revision checks, immutable active snapshots, atomic capacity and file ownership |
| Native panel overlay/focus bugs | Medium | Real packaged UI navigation/resize tests and trusted layout-only calls |
| Installation drift | Medium | Compare with installed baseline, back up changed files and verify readback |
