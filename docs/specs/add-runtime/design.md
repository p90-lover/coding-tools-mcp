# Orchestrator Team presets: design

## 概述

对应需求: FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, FR-8.

## Approved runtime extension
Ethan selected automatic bounded recovery. Retry is an optional control-plane sidecar, not an assignment worker or reviewer dependency. The canonical retry/failed values retain legacy team compatibility. retry_auto enforces the two-attempt cap in Rust; manual retry remains an explicit user action. review_failures preserves failure receipts and partial answers and never promotes failure to successful work. Existing grants, approvals, model routes and healthy observations remain authoritative.

Chat deferStart returns saved IDs and the saved run while startup continues under the existing approval path. teamRevision is checked before task mutation. Ready siblings launch before slow observation; no simultaneous revision-unsafe reserve is introduced. Role activity reads only the node's current owned thread and is bounded/redacted. The inspector polls selected working runs at one-second intervals with visibility/in-flight guards.

Publication remains scoped: preserve concurrent staged/dirty work and validate isolated dependencies before pushing. Application deployment needs a matching compiled runtime and must not silently interrupt healthy missions.
Extend the existing per-workspace reusable Team store and existing Electron module bridge. Reuse the Overview Board canvas and role inspector instead of introducing another visual system or dependency.

## 技术方案

### Data and API
- Keep AppData.ao_teams, extend Team with backward-compatible default and editable-graph metadata as needed.
- Resolve named teams by workspace and ID. Return the team collection plus the default in AO read responses.
- save_team supports independent team revisions and an atomic default switch.
- create_from_team accepts an optional explicit team ID; omitted IDs retain default-team behavior for older clients.
- apply_team targets the existing mission's team snapshot ID.
- Save validation retains the existing graph, explicit model, route and workspace boundaries.

## Frontend
- Add a standalone Orchestrator Team surface under Runtime with workspace/team selection, New, Duplicate, Rename/Save and Make default.
- Use AgentOrchestratorCanvas for the role board and AgentOrchestratorRoleEditor for fields and route pickers.
- Use existing dark utility-surface tokens and CSS classes; no new image assets or animation system.
- Team presets show configuration, not execution history. Existing Chat keeps its mission overview and team controls.
- New mission dialog initially chooses the default and allows another saved team.

## Compatibility and errors
Existing unflagged single teams are defaults. Missing/stale/foreign team IDs fail rather than selecting another team with the same revision. Save failures keep the draft and display the service error. Existing missions keep their snapshots, and revision guards remain active.

## Verification
Focused Rust team-store regressions, Electron AO/renderer tests and TypeScript checking. Render the team surface in a browser at desktop and compact sizes, verify team selection and block edits, and build only into a task-owned aiTemp output directory. Apply the matching app update only after the runtime build is verified and the deployment path preserves healthy work.

## 文件结构
- src-tauri/src/integrations/ao_team.rs: reusable team storage and validation.
- rust-core/coding-tools-headless/src/lib.rs: AO read/update contracts.
- desktop-electron/electron/agent-orchestrator-workflow.cjs: operation allowlist.
- desktop-electron/src/App.tsx: Runtime entry.
- desktop-electron/src/features/AgentOrchestratorTeamsSurface.tsx: team manager.
- desktop-electron/src/features/AgentOrchestratorSurface.tsx: selected-team new missions.
- desktop-electron/src/features/AgentOrchestratorRoleEditor.tsx: shared role configuration.

## Rollback
Scoped source and documentation changes only. Unified Agent Tools creates recoverable Trash backups for changed files. No live team records, credentials or external services are modified during verification.
