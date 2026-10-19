# 需求文档：Chat harness performance and quality
## 功能概述
Implement the approved first batch from the Harness² comparison: lifecycle measurements, shared observation with event invalidation, host-verifiable artifact acceptance, and adaptive selection from approved worker cards. Deliver source and a GitHub PR.
## 历史经验与坑（来自记忆库）
No new long-term memory is requested. Current main is authoritative. Preserve revision checks, exact session ownership, Stop/Restart behavior, display-only streaming, and mandatory approval gates. Existing history is not evidence that a test passed.
## 术语定义
- Attempt: one persisted node request_key and its receipt.
- Acceptance evidence: host-computed digest of an approved workspace artifact bound to planner and worker attempts.
- Observed timing: intervals seen by the coordinator; not provider compute, token, or tool timing.
## 范围边界
In scope: FR-1 through FR-4, backward-compatible API/UI display, focused tests, offline fixture comparison, review and PR.
Out of scope: full recursive Harness² execution, learned permission exceptions, credential/account changes, automatic live installation, new model calls, arbitrary acceptance-command execution.
## 需求列表
### FR-1: Bounded lifecycle measurements
Priority: Must.
WHEN a run is observed THEN the system SHALL retain bounded per-run observational timing and outcome counts.
WHEN run_status is read THEN the system SHALL return a snapshot without prompts, output text, credentials, or invented provider measurements.
IF a process restarts THEN the system SHALL describe timing as partial/current-instance data rather than reconstructing unavailable history.
### FR-2: Shared authoritative observation
Priority: Must.
WHEN driver and UI observe the same session/attempt concurrently THEN the system SHALL share in-flight work.
WHILE an unchanged turn is active THEN the system SHALL use an event-invalidated bounded conversation cache with a 1.5-second reconciliation fallback.
WHEN events, send/interrupt/exit, attempt identity, daemon identity, or terminal state change THEN the system SHALL invalidate stale display data and obtain authoritative completion data.
IF replay or transport outcome is uncertain THEN the system SHALL retain existing reconciliation and unknown-send safeguards.
### FR-3: Verifiable acceptance
Priority: Must.
WHEN a planner supplies optional artifact_sha256 checks THEN the system SHALL validate count, relative path, digest, workspace scope and bounded file size before acceptance.
WHEN a worker finishes THEN the system SHALL host-read the current artifact and bind verification to the planner and worker request keys.
WHEN final review approves THEN the system SHALL recheck current bytes and evidence identity; missing, failed, stale or changed evidence cannot satisfy the typed check.
IF assignments use legacy prose only THEN the system SHALL preserve existing behavior. Artifact verification proves specified bytes, not tests or semantic correctness.
### FR-4: Adaptive approved worker subset
Priority: Must.
WHEN the planner explicitly supplies a nonempty skip_reason for an unused worker THEN the system SHALL skip execution and display its reason.
WHEN a selected worker depends on an omitted worker THEN the system SHALL reject the inconsistent plan.
WHILE workers are skipped THEN the system SHALL mandatory approver, main reviewer, configured subreviewers, grants, limits and ownership rules remain effective.
IF no skip_reason is supplied THEN the system SHALL retain legacy assignment semantics.
## 非功能需求
- NFR-1: Tests compare actual production helpers/controllers with controlled IO and clocks; no claimed real-model speedup.
- NFR-2: No arbitrary command execution from acceptance data, path escape, secret collection, or permission expansion.
- NFR-3: New fields are optional and omitted when unused; old saved missions and clients continue to work.
## 依赖关系
Existing AO session events, workspace safe-read APIs, mission receipts, role prompts, Electron module routing, Rust/Node tests and GitHub CI.
## 检查清单
- Requirements have stable IDs and measurable acceptance.
- Production and test scope are separate from live deployment.
