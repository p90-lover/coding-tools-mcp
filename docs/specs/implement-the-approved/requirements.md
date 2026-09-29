# Runtime AO company canvas — approved requirements

## 功能概述

Implement the approved design in `docs/superpowers/plans/2026-09-27-runtime-ao-company-canvas-draft.md`. Runtime has AO's real workspace Board and an editable Team canvas sharing project/job identities. The user approved all six interview recommendations and implementation, live testing, non-DEV installation and restart.

## 历史经验与坑

The last mission created a real native planner thread but was held without a final answer. Preserve the failure before releasing its harness; do not infer success from readiness. CPA's current/cached marker regression is fixed and must remain fixed. Preserve existing unrelated edits and use this checkout, without new worktrees.

## 术语定义

- Role block: reusable role/model/instruction definition, distinct from a live model conversation.
- Mission: workspace/project-scoped goal, captured graph revision, assignments and receipts.
- Attempt: one bounded execution with a stable request key and independent native receipt.
- Board: actual AO source component and real AO project/session data, not an imitation.

## 范围边界

In scope: shared Board/canvas integration, editable role blocks, real dependencies, bounded staffing/rework, observability, exact model execution, tests and installed non-DEV delivery. Out of scope: public hosting, new task databases, automatic Git worktrees, credential exposure, model fallback, or granting a model authority to approve its own tool requests.

## 需求列表

### FR-1: Share real AO workspace state

Priority: Must. As the user, I can switch Board/Team canvas without changing the project or creating duplicate work. WHEN either view changes a task THEN the other SHALL reflect the same AO-backed job and receipt. Switching workspace SHALL restore its own mission/layout and SHALL NOT replay submissions.

### FR-2: Edit reusable company roles

Priority: Must. Provide orchestrator, planning, research, engineering, QA, reviewer and integration role presets. Clicking a block SHALL expose name, role, department, model/effort, harness/account, instructions, output expectations, dependencies, scope and limits. Reviewers SHALL request rework without editing implementation files. Apply SHALL change queued work explicitly while active attempts keep their captured settings.

### FR-3: Provide a movable and accessible canvas

Priority: Must. The canvas SHALL fill the main pane, support free positions, pan/zoom, multi-selection, alignment, Fit and keyboard alternatives. Connections SHALL reflect real dependencies; all parents must finish. Cycles and invalid active-task dependency edits SHALL be rejected. Drag proximity SHALL produce restrained elastic connection motion; execution pulses SHALL reflect actual activity and respect reduced motion.

### FR-4: Bound workers and review loops

Priority: Must. The user SHALL set global and per-mission worker limits, initially three. Ready work SHALL respect both limits, including AO-delegated child workers. Lowering limits SHALL wait for capacity rather than killing active work. Review rejection SHALL return to the assigned worker for at most two rework rounds, then hold with a visible reason. Conflicting workspace writes SHALL not run concurrently.

### FR-5: Execute exact routes with evidence

Priority: Must. WebGPT High SHALL plan and independently review; workers SHALL use CPA `gemini-3.8-flash-high` through their selected AO harness and shared account pool. Missing routes SHALL hold with a specific reason. A live isolated mission SHALL retain distinct planner/worker/reviewer execution receipts and a successful final review. Health, catalogs and fixtures SHALL NOT count as this acceptance test.

### FR-6: Preserve permissions, failures and recovery

Priority: Must. Existing workspace and harness boundaries SHALL apply. Secrets SHALL remain private to the host. A model SHALL NOT approve its own tool request. Failure details SHALL be bounded/redacted and saved before a harness is released. Unknown outcomes SHALL not replay automatically. Cancellation/archive SHALL preserve already submitted effects and receipts.

### FR-7: Deliver a verified installed build

Priority: Must. Preserve CPA Accounts/CPA navigation, MCP and native Codex behavior. Verify real rendered interactions and artifact integrity, back up changed installed files, install/restart only non-DEV Coding Tools and keep Codex open. Preserve app data and old mission records for explicit migration/readback.

## 非功能需求

- NFR-1: Coalesce pointer/layout work to animation frames; animate only relevant connections; avoid polling/render loops when hidden or unchanged.
- NFR-2: Keep managed listeners on loopback, validate IDs/revisions/paths/routes, and never expose account keys in canvas or receipts.
- NFR-3: Keep old records readable through additive migrations/defaults; preserve unrelated source and installed state.
- NFR-4: Use actual available harness capabilities. Computer/vision functionality requires its own runtime evidence, not a catalog-only claim.

## 依赖关系

Existing Electron/React host, original AO source and Go daemon, native Codex bridge/headless service, authenticated WebGPT, managed CPA and MCP tool registration.
