# 设计文档：source-only Agent Orchestrator

## 概述

This design covers FR-1 through FR-5 and NFR-1 through NFR-3. It follows the already written AO design in docs/superpowers/specs/2026-09-25-native-ao-orchestrator-design.md and the board/execution plans in docs/superpowers/plans/. The current in-process AO adapter is a starting point, not proof of a completed run.

## 技术方案

### 技术选型

| Category | Choice | Reason | Requirements |
| --- | --- | --- | --- |
| Durable board | Existing Rust workflow board plus AO run records in AppData | One authority for tasks and revisioned writes | FR-1, FR-4 |
| Coordinator | Electron main AO module with authenticated headless calls | Reuses local UI confirmation and private routes | FR-2, FR-3, FR-5 |
| Planner/reviewer | Exact WebGPT model through existing Codex bridge | Reuses the established tool and approval boundary | FR-2 |
| Workers | AO-owned adapter for an explicitly supported harness | No silent provider or executable substitution | FR-3 |
| Models | Existing provider catalog and CPA only as a worker provider | Credentials remain private to the host | FR-3, NFR-2 |

### 架构设计

```text
Runtime AO UI / browser MCP
  -> Electron AO coordinator (selection, confirmation, scheduling)
  -> authenticated headless AO run store beside workflow board
  -> WebGPT-on-Codex planner and distinct reviewer
  -> AO-owned selected worker harness session
  -> revisioned receipts and derived board status
```

Readback never dispatches. The scheduler reserves a ready node before external I/O, uses one stable request key, records owned session/turn/output identity, and holds unknown results. Only verified worker output is eligible for review. A local user decision gates run creation and each separate tool approval; prompts cannot select accounts, workspaces, or permissions.

## 数据模型

| Entity/field | Type | Constraint | Purpose |
| --- | --- | --- | --- |
| AoRun.id, workspace_id, project_id | strings | stable, workspace-scoped | durable run identity |
| AoRun.revision, status | integer, enum | CAS on every update | restart-safe state |
| AoNode.id, task_id, parents, position | strings/list/coordinates | same run; acyclic; bounded | mission graph |
| AoNode.route | harness/provider/account/model/permission IDs | exact catalog match | worker configuration |
| AoNode.receipt | request/session/thread/turn/output references | bounded, no secrets | provenance and replay control |

The existing workflow board keeps task titles, descriptions, clauses, and evidence. AO run records store execution and graph facts, not a copy of the plan.

## API 设计

| Operation | Input | Output | Requirements |
| --- | --- | --- | --- |
| AO read | workspaceId, optional runId | bounded run/board view | FR-1, FR-5 |
| AO create/update | workspaceId, expected revision, exact graph change, local confirmation | saved run revision | FR-1, FR-4, FR-5 |
| AO plan/drive/review | runId, stable request key, selected route | owned receipt or held state | FR-2, FR-3, FR-4 |
| AO worker config | supported harness ID and exact provider/account/model/capabilities | validated public route | FR-3 |
| browser MCP AO tool | workspace ID and allowlisted operation | same guarded host result | FR-5 |

## 文件结构

- Reuse app-handler/agent-orchestrator/ for the module contract and derived board.
- Extend src-tauri/src/integrations/ and rust-core/coding-tools-headless/src/lib.rs for durable AO records and authenticated routes.
- Extend desktop-electron/electron/agent-orchestrator-workflow.cjs and main.cjs for exact-route scheduling.
- Extend desktop-electron/src/features/AgentOrchestratorSurface.tsx and agent-orchestrator.css for run/worker/review controls.
- Extend runtime-web/src/adapters/chatgpt-web/mcp-server.ts only for bounded AO operations.
- Add focused tests under desktop-electron/tests/ and Rust AO unit tests.

## 设计决策

1. Use the existing board and DataStore (FR-1): avoids diverging task state and a second database.
2. WebGPT owns planning/review, CPA only provides worker models (FR-2, FR-3): matches the requested role split and prevents prompt-chosen routing.
3. Reserve before dispatch (FR-4): unknown external effects remain inspectable and cannot be replayed under a fresh key.
4. Keep AO source-only (NFR-3): no AO service, executable, or port; selected harnesses are separate user-configured runtimes.

## 测试策略

- Unit tests: graph cycle/parent gates, stale revision rejection, route validation, cancellation, and unknown receipts.
- Integration tests: one isolated registered workspace under project aiTemp, completed WebGPT planner output, exact selected worker output, distinct WebGPT reviewer verdict, reopen without replay.
- UI/MCP tests: local confirmation, scoped permissions, narrow scrolling, keyboard graph editing, and no secrets in public payloads.
- Keep installed-app proof separate from source tests; do not claim live completion from a catalog or mock receipt.

## 风险评估

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Existing native bridge is one-model, opt-in, and session-bounded | High | Validate the exact WebGPT and selected worker routes before dispatch; use AO-owned sessions, never replace the user's native session |
| CPA key crossing into a worker | High | Private host-to-headless one-shot handoff only after concrete local approval; never renderer/config/argv/log |
| Old Rust tests reference missing aiTemp fixtures | Medium | Keep focused production checks and repair fixture coverage before merge |
| Current draft PR spans unrelated earlier integrations | High | Keep AO changes identifiable and PR draft until affected CI and live acceptance pass |

## 检查清单

- [x] Every FR has a design path and verification.
- [x] Data ownership and boundary contracts are explicit.
- [x] Unsupported route and unknown receipt behavior fail closed.
