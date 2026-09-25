# 任务清单：source-only Agent Orchestrator

## 概述

Deliver FR-1 through FR-5 from requirements.md using the existing source design and two AO implementation plans. A source build or mock response does not satisfy the live planner–worker–reviewer gate.

## 交付物清单（Scope-lock）

- Expected new production files: 2–4 small AO run/runner modules; exact split follows the existing Rust and Electron module boundaries.
- Expected modified production files: 8–12 existing AO, headless, IPC, UI, and MCP files.
- Expected changed functions: about 12–20 across persistence, scheduling, presentation, and guarded API calls.
- Deliverables: durable AO run record; exact WebGPT planner/reviewer route; AO-owned selected worker session; revisioned UI/MCP controls; focused Rust/Node tests; redacted isolated live receipt.

## 任务列表

### Phase 1: Verify boundaries

- [ ] 1.1 Prove the selected WebGPT-on-Codex and worker harness routes before any mission dispatch.
  - **证据块**: desktop-electron/electron/agent-orchestrator-workflow.cjs:94 currently sends CPA chat completions for planning; src-tauri/src/codex_bridge/mod.rs:517 exposes the connected model; existing AO execution plan Task 2 requires exact completed turns.
  - Files: desktop-electron/tests/native-ao-route-contract.test.cjs, about 100 lines; redacted receipts under aiTemp.
  - Requirements: FR-2, FR-3. Design: 技术方案, 测试策略.

### Phase 2: Durable AO module

- [ ] 2.1 Persist workspace-scoped AO runs and revisioned dependency edges beside the old plan.
  - **证据块**: src-tauri/src/integrations/board_sync.rs:267 reads workspace-scoped tasks and clauses; the current app-handler/agent-orchestrator/kanban.cjs:6 derives display lanes but stores no mission session.
  - Files: src-tauri/src/integrations/ao.rs, src-tauri/src/data/model.rs, rust-core/coding-tools-headless/src/lib.rs; keep each module under 500 added lines by splitting pure graph logic from HTTP routing.
  - Requirements: FR-1, FR-4. Design: 数据模型, 设计决策.
- [ ] 2.2 Replace CPA-as-planner with distinct WebGPT planner/reviewer and AO-owned worker launch using exact harness config.
  - **证据块**: desktop-electron/electron/five-stack-control-plane.cjs:488 contains a WebGPT/worker/reviewer flow but requires Paseo; desktop-electron/electron/agent-orchestrator-workflow.cjs:94 currently plans through CPA directly.
  - Files: desktop-electron/electron/agent-orchestrator-workflow.cjs plus separate AO runner/control module; src-tauri/src/codex_bridge/mod.rs only for a narrow AO-owned bridge facade. Split before a single file grows by 500 lines.
  - Requirements: FR-2, FR-3, FR-4. Design: 架构设计, API 设计.
- [ ] 2.3 Bind Runtime and browser MCP controls to durable runs, exact routes, and local approvals.
  - **证据块**: desktop-electron/src/features/AgentOrchestratorSurface.tsx:71 lists the current board; runtime-web/src/adapters/chatgpt-web/mcp-server.ts registers the AO tool; neither owns a finished mission.
  - Files: desktop-electron/src/features/AgentOrchestratorSurface.tsx, desktop-electron/electron/main.cjs, app-handler/agent-orchestrator/handler.cjs, runtime-web/src/adapters/chatgpt-web/mcp-server.ts and focused tests.
  - Requirements: FR-1, FR-5. Design: API 设计, 文件结构.

### Phase 3: Verify and review

- [ ] 3.1 Test graph, route, receipt, permission, cancellation, and UI behavior against each acceptance criterion.
  - **证据块**: desktop-electron/tests/agent-orchestrator-workflow.test.cjs:8 currently proves only a CPA draft and append; CI Rust tests fail on missing gitignored aiTemp fixtures.
  - Files: focused AO Node tests, Rust AO tests, renderer typecheck/build outputs under aiTemp.
  - Requirements: FR-1, FR-2, FR-3, FR-4, FR-5. Design: 测试策略.
- [ ] 3.2 Complete an isolated live run and review the draft PR before marking AO complete.
  - **证据块**: docs/superpowers/specs/2026-09-25-native-ao-orchestrator-design.md:60 requires a WebGPT plan, exact worker output, separate WebGPT verdict, and reopen without replay.
  - Files: redacted receipts under aiTemp and PR #240; no installed app replacement without the concrete final approval.
  - Requirements: FR-2, FR-3, FR-4, FR-5. Design: 风险评估.

## 检查点

- Phase 1: Exact WebGPT and selected worker routes have completed harmless turns with owned identities; otherwise hold the run.
- Phase 2: Two-parent joins, stale revisions, cross-workspace mutations, unknown receipts, and cancellation reject or hold without hidden replay.
- Phase 3: Focused checks and one real isolated planner–worker–reviewer cycle pass; the draft PR accurately reports any remaining failures.

## 需求覆盖矩阵

| Requirement | Design section | Tasks | State |
| --- | --- | --- | --- |
| FR-1 | 数据模型 | 2.1, 2.3, 3.1 | Pending |
| FR-2 | 架构设计 | 1.1, 2.2, 3.1, 3.2 | Pending |
| FR-3 | 技术方案 | 1.1, 2.2, 3.1, 3.2 | Pending |
| FR-4 | 设计决策 | 2.1, 2.2, 3.1, 3.2 | Pending |
| FR-5 | API 设计 | 2.3, 3.1, 3.2 | Pending |

## 文件变更清单

| File | Operation | Budget | Purpose |
| --- | --- | --- | --- |
| src-tauri/src/integrations/ao.rs | Create | 300 lines | Pure AO graph/run records |
| src-tauri/src/data/model.rs | Modify | 10 lines | Persist AO records |
| rust-core/coding-tools-headless/src/lib.rs | Modify | 100 lines | Guarded AO read/update |
| desktop-electron/electron/agent-orchestrator-workflow.cjs | Modify | 100 lines | Replace CPA orchestration role |
| desktop-electron/electron/native-ao-stage-runner.cjs | Create | 200 lines | Exact selected harness execution |
| desktop-electron/electron/main.cjs | Modify | 50 lines | Private AO wiring |
| desktop-electron/src/features/AgentOrchestratorSurface.tsx | Modify | 150 lines | Run/worker/review UI |
| app-handler/agent-orchestrator/handler.cjs | Modify | 20 lines | AO operations |
| runtime-web/src/adapters/chatgpt-web/mcp-server.ts | Modify | 20 lines | Bounded MCP contract |
| desktop-electron/tests/native-ao-route-contract.test.cjs | Create | 100 lines | Exact route proof |

## 检查清单

- [x] Deliverables and constraints are concrete.
- [x] Every task links to FR and design sections with source evidence.
- [x] No placeholder task is treated as implemented.
