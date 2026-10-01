# Tasks: Native AO orchestration

## Overview

The existing detailed implementation plans are the executable task breakdown: [legacy-module decommission](../../superpowers/plans/2026-09-25-paseo-decommission.md), [AO board and tree](../../superpowers/plans/2026-09-25-native-ao-board-ui.md), and [AO execution and review](../../superpowers/plans/2026-09-25-native-ao-execution.md). This checklist fixes their order and requirement coverage. Do not treat the checklist or a CPA clause draft as completed product work.

## 交付物清单

1. Recoverable private archives for Paseo, Router, CommandCode Proxy, and Anneal, including Anneal's Postgres task volume; no active service, handler, navigation, or packaged runtime for any of them.
2. AO as the sole Runtime orchestrator entry with an honest interim unavailable state.
3. A durable full-pane AO tree with revisioned dependency graph and separate runs.
4. Exact selected AO harness worker execution between two distinct Web GPT turns.
5. Focused tests and an installed non-DEV end-to-end receipt, with no automatic approval or duplicate replay.

## 任务列表

### Stage 1: Decommission without data loss

- [ ] 1.1 Archive private configuration, keys, daemon/component state, mixed profile store, and Anneal Postgres task volume before normalization; a failed backup blocks the change. **Evidence:** `external-services.cjs` normalizes entries by service IDs, `profiles.json` mixes CPA/AO/legacy records, and Anneal tasks live in a separate Docker volume. **Files:** Electron service bootstrap/config, Rust live restore, Anneal volume archive, expected under 350 changed lines across focused files. _Requirements: FR-1, NFR-1, NFR-3. Design: Decisions FR-1, Data model._
- [ ] 1.2 Disable all four retired modules' startup and retire only their shared-route branches, preserving CPA, MCP, native Codex, and CPA-owned CommandCode OAuth providers. **Evidence:** GitNexus marks `actUpstream`/`paseoRpc` HIGH and `buildLoopbackMesh` CRITICAL; shared callers still use CPA/MCP. **Files:** Electron lifecycle, mesh, action, app-handler, and Rust integration modules, expected under 600 changed lines spread across existing files. _Requirements: FR-1, NFR-3. Design: Technical approach, Test strategy._
- [ ] 1.3 Remove retired-module navigation/runtime packaging, move unreferenced source and generated assets to recoverable Trash, and display AO execution as unavailable. **Evidence:** current `AgentOrchestratorSurface.tsx` renders a CPA clause board, and `agent-orchestrator-workflow.cjs` has no worker launcher. **Files:** renderer, packaging scripts, retired handler/module source, expected under 500 changed lines spread across existing files. _Requirements: FR-1, NFR-2, NFR-3. Design: Decisions FR-1, File structure._

### Stage 2: Build the AO board and selected route

- [ ] 2.1 Extend the existing revisioned AO run/node graph and guarded workspace creation using [the AO board plan](../../superpowers/plans/2026-09-25-native-ao-board-ui.md). **Evidence:** `ao.rs` already validates parent joins and reserves nodes, but the current GUI is still a CPA clause board. **Files:** Rust DataStore/headless, Electron IPC, renderer tree; each task/file budget is in the linked plan. _Requirements: FR-2, NFR-1, NFR-2. Design: Data model, API boundaries._
- [ ] 2.2 Prove exact Web GPT and Gemini harness turns, then add the owned stage runner and receipt reconciliation using [the AO execution plan](../../superpowers/plans/2026-09-25-native-ao-execution.md). **Evidence:** `agent-orchestrator-workflow.cjs` currently calls CPA `/v1/chat/completions` for a draft only. **Files:** Codex bridge/headless AO routes and Electron stage/control plane; each task/file budget is in the linked plan. _Requirements: FR-3, FR-4, NFR-1. Design: Technical approach, API boundaries._

### Stage 3: Verify installed behavior

- [ ] 3.1 Run the focused service, package, graph, IPC, and route tests named in the three linked plans; typecheck/build the renderer and Rust headless host. **Evidence:** source tests alone do not prove the installed GUI or route. **Files:** focused existing/new tests and build outputs under `aiTemp/`. _Requirements: FR-1, FR-2, FR-3, FR-4. Design: Test strategy._
- [ ] 3.2 Back up and restart only non-DEV Coding Tools when safe; verify no retired process/listener, no regression in CPA/MCP/native Codex, and a real isolated Web GPT → exact selected Gemini → distinct Web GPT review with saved receipt and reopen/no-replay proof. **Evidence:** AO currently has no installed-app execution receipt. **Files:** local installed package and redacted `aiTemp/` evidence; Codex stays open. _Requirements: FR-1, FR-3, FR-4, NFR-3. Design: Test strategy and risks._

### Evidence blocks by task

- **证据块 1.1:** `external-services.cjs` normalizes saved entries by `SERVICE_IDS`; the mixed profile store cannot be removed wholesale.
- **证据块 1.2:** GitNexus upstream impact is HIGH for `actUpstream`/`paseoRpc` and CRITICAL for `buildLoopbackMesh`; inspect CPA/MCP and legacy callers.
- **证据块 1.3:** `AgentOrchestratorSurface.tsx` exposes CPA clause drafting, while `agent-orchestrator-workflow.cjs` has no worker dispatch.
- **证据块 2.1:** `ao.rs` already saves a graph and all-parent join, but has no owned model receipt or completed stage transition.
- **证据块 2.2:** The current `plan` operation posts to CPA chat completions and returns `saved:false`; it is not a Web GPT or owned worker receipt.
- **证据块 3.1:** Existing focused test files are listed in the three linked implementation plans and must be run after each affected edit.
- **证据块 3.2:** The installed non-DEV AO path has no verified three-stage run; only a real saved planner/worker/reviewer receipt can satisfy acceptance.

## 需求覆盖矩阵

- Stage 1: archive readback including Anneal Postgres, no retired startup/dispatch/package, AO honest state, CPA/MCP/native checks.
- Stage 2: two-parent/cycle/revision checks, exact completed route receipts, permission refusal, no replay on reopen.
- Stage 3: installed non-DEV three-stage run and retained-app smoke checks.

| Requirement | Tasks |
|-------------|-------|
| FR-1 | 1.1, 1.2, 1.3, 3.1, 3.2 |
| FR-2 | 2.1, 3.1 |
| FR-3 | 2.2, 3.1, 3.2 |
| FR-4 | 2.2, 3.1, 3.2 |
| NFR-1 | 1.1, 2.1, 2.2 |
| NFR-2 | 1.3, 2.1 |
| NFR-3 | 1.2, 1.3, 3.2 |

## 文件变更清单

| File group | Operation | Budget and purpose |
|------------|-----------|--------------------|
| `desktop-electron/electron/` service, mesh, IPC, AO and package scripts | Modify | Use the three linked plans' per-task budgets; retire four standalone modules and add AO dispatch |
| `desktop-electron/src/features/` and `src/App.tsx` | Modify | Full-pane AO tree, honest capability state, no retired navigation or Anneal task board |
| Retired `app-handler/` and `modules/` source | Move to recoverable Trash after imports are removed | No runnable retired module or packaged source |
| `src-tauri/src/integrations/`, `rust-core/coding-tools-headless/` | Modify | Graph, guarded workspace, route receipts, legacy read compatibility |
| `desktop-electron/tests/` and focused Rust tests | Modify or add | Startup, package, graph, route, and installed-behavior checks |
