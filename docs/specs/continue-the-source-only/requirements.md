# 需求文档：source-only Agent Orchestrator

## 功能概述

Coding Tools owns an in-process AO module that turns its existing workspace plan into durable mission runs. WebGPT in Codex plans and reviews; AO launches worker agents with the exact harness, account, model, and permissions selected in AO. CPA supplies models to eligible worker harnesses only. No AO executable is bundled or launched.

## 历史经验与坑（来自记忆库）

- 可复用经验: The existing revisioned workflow board, native Codex bridge, provider catalog, and local approval gates are source-backed starting points.
- 必须规避的坑: The present AO module only drafts clauses through CPA; a model catalog or reserved mission is not a completed planner–worker–reviewer run. The Rust test suite refers to missing gitignored aiTemp fixtures. The dirty worktree and installed desktop app must remain intact.

## 术语定义

- AO run: A workspace-scoped durable graph of planner, worker, and reviewer nodes linked to existing plan tasks.
- Route: The exact harness, provider, account, model, capability, and permission selection approved for one node.
- Receipt: The saved request identity and observed session, thread, turn, output, or uncertain outcome for one node.

## 范围边界

In Scope:
- Keep the existing Coding Tools board authoritative for task text and clauses; persist AO graph and execution facts beside it.
- Run WebGPT through Codex as planner and a distinct reviewer.
- Let AO create and own worker sessions using a selected supported harness and its saved configuration; CPA is a provider route for eligible workers.
- Show run, worker, review, and approval state in the Runtime AO module and expose bounded workspace-scoped MCP operations.
- Require local approval for writes and separate permission decisions for tools or outside-workspace access.

Out of Scope:
- Bundling or launching an AO binary, replacing the installed desktop app in this source phase, importing legacy profiles automatically, or treating Paseo/Anneal as AO workers.
- Advertising unsupported harness, computer, or vision capabilities as available.

## 需求列表

### FR-1: Durable source-only AO runs

Priority: Must. As a Coding Tools user, I can create a run for one registered workspace from existing plan tasks.
1. WHEN a run is created THEN the system SHALL store stable run/node IDs, dependency edges, revisions, selected routes, and bounded receipts without duplicating task text into a second board.
2. IF a graph edit is stale, cyclic, cross-run, or changes an active node THEN the system SHALL reject it atomically.

### FR-2: WebGPT plans and reviews

Priority: Must. As a user, I can see distinct WebGPT planner and reviewer turns for a run.
1. WHEN a run starts THEN AO SHALL require an exact WebGPT-on-Codex route and record the planner's owned output before dispatching workers.
2. WHEN all required worker outputs settle THEN AO SHALL start a separate WebGPT reviewer turn over current bounded evidence.
3. IF output is missing, stale, truncated, or uncertain THEN AO SHALL hold the run and SHALL NOT mark it complete.

### FR-3: AO-owned configurable workers

Priority: Must. As a user, I choose each worker's supported harness and exact configuration inside AO.
1. WHEN a worker is queued THEN AO SHALL validate its chosen harness, account, provider, model, workspace, capability, permission policy, and request key before launch.
2. IF the exact route is unavailable THEN AO SHALL stop without provider, model, or harness fallback.
3. WHILE a worker runs THEN only AO SHALL own its session and reconcile its receipt; CPA SHALL act only as a model provider where the selected harness supports it.

### FR-4: Dependency and lifecycle rules

Priority: Must. As a user, I can resume a run without duplicate work.
1. WHEN every parent node has verified success THEN AO MAY reserve the next node using a stable request key.
2. IF a start or send result is unknown THEN AO SHALL hold the node for inspection rather than replay with a new key.
3. WHEN a run is cancelled THEN AO SHALL prevent future dispatch and preserve already submitted receipts.

### FR-5: Runtime and MCP control

Priority: Must. As a user, I can inspect and operate AO from the Coding Tools Runtime screen and browser MCP.
1. WHEN the UI or MCP reads a run THEN it SHALL show derived status, exact route, output provenance, and pending approvals without exposing secrets.
2. IF a mutation is requested outside the approved workspace or without local confirmation THEN it SHALL be denied.
3. WHILE the window is narrow THEN the board SHALL remain scrollable and keyboard usable.

## 非功能需求

- NFR-1 Performance: Bound node count, prompt/output sizes, and read pagination; a board refresh must not dispatch a model.
- NFR-2 Security: Keep CPA keys, browser tokens, cookies, and raw credentials out of renderer, logs, saved AO records, and model prompts. No automatic tool approval.
- NFR-3 Compatibility: Existing workflow tasks, Paseo records, and legacy profiles remain readable; no AO executable or new public listener is required.

## 依赖关系

- Existing revisioned workflow board and authoritative AppData/DataStore.
- Existing authenticated headless routes, provider catalog, WebGPT browser bridge, and native Codex approval boundary.
- Detailed source design: docs/superpowers/specs/2026-09-25-native-ao-orchestrator-design.md.

## 检查清单

- [x] Requirements have stable FR IDs and testable acceptance criteria.
- [x] Source-only and workspace permission boundaries are explicit.
- [x] Model catalog, planner output, worker output, and review verdict are distinct proof points.
