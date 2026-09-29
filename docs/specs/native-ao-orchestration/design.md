# Design: Native AO orchestration

## 概述

This design covers FR-1 through FR-4 and NFR-1 through NFR-3 in [requirements.md](requirements.md). The authoritative architecture and safety rules are [Native AO Orchestrator](../../superpowers/specs/2026-09-25-native-ao-orchestrator-design.md); its linked execution, board, and decommission plans contain exact file-level steps.

## 技术方案

| Area | Existing component reused | Requirements |
|------|---------------------------|--------------|
| Tasks and revisions | Workspace workflow board and Rust DataStore | FR-2, FR-4 |
| GUI | Coding Tools Electron/React shell and AO surface | FR-1, FR-2, NFR-2 |
| Planner and reviewer | Existing Web GPT browser/native bridge | FR-3 |
| Workers and approvals | AO-owned selected Codex-native harness, existing approval loop | FR-3, NFR-1 |
| Recovery | App-private backup and existing atomic state utilities | FR-1, FR-4 |

The execution flow is `saved AO run → Web GPT plan receipt → all-parent dependency gate → exact AO worker harness receipt → distinct Web GPT review receipt → durable verdict`. Read-only UI refresh never starts a stage. Paseo, Router, CommandCode Proxy, and Anneal are excluded from lifecycle and dispatch before AO execution is enabled.

## Data model

| Entity | Constraint | Purpose |
|--------|------------|---------|
| `AoRun` | Stable workspace/project ID, revision, selected routes, status | Separates runs and prevents stale edits |
| `AoNode` | Stable task ID, parent IDs, bounded position, role, state | Top-to-bottom dependency tree |
| `AoReceipt` | Stable request key, harness/session/turn IDs, bounded output, approval state | Recovery and provenance |
| Retired-module archive | App-private, restricted, exact source paths and restore note; Anneal Postgres volume retained | Recover old state without auto-resuming |

The mixed `profiles.json` remains authoritative for CPA/AO and legacy read compatibility. AO records are added through DataStore transactions; no second AO database or raw profile-file editing. Anneal's old Postgres rows remain separate and are not auto-imported.

## API boundaries

| Boundary | Input | Output | Requirements |
|----------|-------|--------|--------------|
| Guarded workspace create | Canonical path, name, local confirmation | Public workspace ID/name/path only | FR-2, NFR-1 |
| AO graph update | Run ID, expected revision, position/dependency edit | New revision or atomic rejection | FR-2 |
| AO harness connect/control/read | Exact selected route, approved run, stable request key | Private session and bounded public receipt | FR-3, FR-4 |
| Retired app call | Paseo, Router, CommandCode Proxy, or Anneal module ID | Explicit retired-module error | FR-1 |

Renderer requests contain no secrets. Electron resolves the selected private route; the headless process admits a run only with its stored confirmation scope. Tool approval remains a separate local decision. A missing route fails closed.

## 文件结构

- `desktop-electron/electron/`: service decommission, guarded AO IPC, control plane, packaging inputs.
- `desktop-electron/src/features/`: full-pane AO tree and honest interim execution state; remove retired-module navigation and the Anneal task board.
- `app-handler/`: AO module remains; retired handler source moves to recoverable Trash after imports and package references are removed.
- `src-tauri/src/integrations/` and `rust-core/coding-tools-headless/`: AO graph, selected harness, saved receipts, legacy read compatibility.
- `docs/superpowers/plans/`: [decommission](../../superpowers/plans/2026-09-25-paseo-decommission.md), [board](../../superpowers/plans/2026-09-25-native-ao-board-ui.md), [execution](../../superpowers/plans/2026-09-25-native-ao-execution.md).

## Decisions

- **FR-1:** Decommission all four standalone modules now, rather than waiting for AO proof. The AO screen explicitly marks execution unavailable during the gap; saved data, including Anneal's separate task volume, is privately archived, never deleted.
- **FR-2:** Reuse the current workflow board and DataStore. A new second task database would create conflicting status and recovery semantics.
- **FR-3:** Reuse the existing selected harness and approval boundary. A direct CPA chat-completion call is a planning draft, not a worker with tools or route provenance.
- **FR-4:** Hold uncertain receipts rather than retrying Create/send/tool calls with a new key.

## Test strategy and risks

Focused service/package tests verify no retired-module startup, handler, or runnable bundle while CPA, MCP, native Codex, and AO remain. Graph tests cover cycles, two-parent joins, stale revisions, and old-record deserialization. Route tests demand completed exact-model turns; the installed-app test demands three distinct owned outputs and a Web GPT verdict. The HIGH `actUpstream`/`paseoRpc` and CRITICAL `buildLoopbackMesh` graph risks require inspecting shared callers and testing retained branches before install. A failed private archive or missing exact route stops the relevant phase; no retired-module fallback.
