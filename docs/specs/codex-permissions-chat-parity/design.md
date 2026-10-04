# Design: Codex permission and readiness parity

## 概述
Use the native app-server as the permission authority and preserve separate app authorization layers. The composer opens one permission panel with clearly scoped sections; it does not implement an alternative sandbox.
**对应需求:** FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, NFR-1, NFR-2, NFR-3, NFR-4, NFR-5.

## 技术方案
### 技术选型
| Category | Choice | Reason | Requirement |
|---|---|---|---|
| Runtime | Existing Rust Codex bridge and app-server JSON-RPC | Enforce real native policy | FR-2, FR-4 |
| Persistence | Optional role permission selection, existing revisioned team/run APIs | Preserve old data and all-role scope | FR-1, FR-3 |
| UI | Existing React chat/role editor and app permission APIs | Functional controls without a duplicate engine | FR-3, FR-5 |
| Readiness | Existing browser session + bridge status sources | Fail closed before model dispatch | FR-6 |

### 架构设计
1. Native role policy: profile ID, approval policy and reviewer are separate values. Available profiles come from native capability/managed-policy discovery, not from assumed CLI aliases. Read-only/workspace/full-access are native IDs; custom profiles are selectable only when the role runtime actually provides them.
2. The absent new selection retains legacy effective behavior. Harness/model changes preserve the last saved native choice instead of overwriting it with the external route sentinel.
3. Thread and turn requests assert the saved policy, and returned effective profile is validated. Existing running attempts are not silently reconfigured or restarted.
4. A typed pending-request union retains native method, identifiers, authoritative decisions/questions/schema and requested permission subset. Reply validation stays in the bridge; UI cannot supply unrelated grants.
5. Workspace MCP policy remains shared workspace configuration. Native connector/MCP policy remains native session configuration. Shared standalone/model consent and OS-app/snapshot grants remain distinct existing APIs.
6. Fresh WebGPT readiness is checked at connect and dispatch, including already-connected roles and background scheduling. A probe reads session/host evidence without browser navigation or inference.

## 数据模型
- Add optional role-native selection: exact profile ID plus optional approval policy and reviewer. Absent fields preserve existing saved records and fingerprints.
- Effective status includes the actually bound native policy and capability/managed denial reason.
- Pending approval/request variants: command, file change, requested filesystem/network, questions, MCP form, MCP URL.
- Native request IDs remain scoped to the exact live thread/turn/node; stale decisions are rejected.
- Workspace MCP configuration and existing native/computer/snapshot grants retain their current schemas unless read-only menu metadata needs additional fields.

## API 设计
| API/Function | Inputs/outputs | Requirement |
|---|---|---|
| Existing team_update/save_team/apply_team | Optional role selection with revision checks | FR-1, FR-3 |
| Native permission-profile metadata operation | Allowed native IDs and managed status for selected role | FR-2 |
| Native thread/start and turn/start | Exact permissions/approvalPolicy/approvalsReviewer and effective readback | FR-2 |
| Existing approve_harness route, extended typed decision | Exact pending native method/request and validated response payload | FR-4 |
| Existing workspace/native/computer permission APIs | Clearly scoped menu reads/confirmed mutations | FR-5 |
| WebGPT readiness callback in workflow | Fresh authenticated and host-ready result or typed hold reason | FR-6 |

## 文件结构
Primary implementation surfaces:
- desktop-electron/electron/agent-orchestrator-workflow.cjs
- desktop-electron/electron/browser-host.cjs
- desktop-electron/electron/main.cjs
- desktop-electron/src/features/AgentOrchestratorChat.tsx
- desktop-electron/src/features/AgentOrchestratorSurface.tsx
- desktop-electron/src/features/AgentOrchestratorRoleEditor.tsx
- desktop-electron/src/features/agent-orchestrator.css
- desktop-electron/src/types.ts and API/preload schemas only as required
- src-tauri/src/codex_bridge/mod.rs and extracted typed approval module if needed
- src-tauri/src/integrations/ao.rs, ao_team.rs and data model serialization
- rust-core/coding-tools-headless/src/lib.rs
- Existing CJS/Rust regression locations.
Existing files over 500 lines are not broadly refactored; isolate new sizeable logic in a focused module.

## 设计决策
### Native versus app policy (FR-2, FR-5)
Native approval never is not app MCP never: the app's never mode denies permission-requiring operations. Keep distinct labels and controls; do not translate one into the other.

### Effective application (FR-3)
Saving a team is not proof a running harness changed scope. Apply revisioned changes to queued/future attempts; show the current running policy until its session is safely replaced by normal lifecycle.

### Standalone commands (FR-5)
allow_command_execution controls a separate command API. Do not turn it on to fix model shell/MCP behavior.

### Unsupported consent (FR-4)
Prefer exact native method-specific response shapes. Capability mismatch must be visible and bounded, never treated as auto-approval.

## 风险评估
| Risk | Impact | Mitigation |
|---|---|---|
| Accidental elevation or shared grant rewrite | High | Explicit selection/confirmation, legacy defaults preserved, scope labels and denial tests |
| Native schema/version mismatch | High | Capability/profile discovery, exact active-profile acknowledgement, no silent fallback |
| Stale requests/revisions | High | Exact live request scope and existing revision checks |
| Permission-loss on route edits | Medium | Native selection round-trip regression |
| Browser probe disturbs active task | Medium | Read-only session evidence; no navigation/login |
| Primary checkout concurrency | High | Isolated worktree and only task-owned diff |
