# Runtime AO company canvas — tasks

## 交付物清单

Seven deliverables: native execution recovery, canonical AO workspace/job binding, reusable team metadata, canvas, inspector, bounded scheduling/rework, and a verified installed build. Initial source budget: up to seven new focused modules/tests and sixteen modified production files; reconcile the actual list before delivery. Existing large routers receive bounded integration changes; substantial new logic belongs in modules under 500 lines.

## 任务列表

### Task 1: Capture and fix the held native planner without replay

- Evidence: `src-tauri/src/integrations/ao.rs:50` defines `Receipt` without a failure field; `rust-core/coding-tools-headless/src/lib.rs:2870` derives terminal status then releases the hub; `src-tauri/src/codex_bridge/mod.rs:1074` submits `turn/start`.
- Files: native bridge, AO receipt reducer, headless observer and covering tests. Additions budget: 150 lines per existing file; extract larger logic.
- Reproduce the native failure with a bounded read-only probe; add the matching regression; preserve the cause and fix the demonstrated issue.
- Verify: focused native bridge/receipt tests and actual exact-route probe. Expected: failure is inspectable, uncertainty does not replay, selected model returns a real answer.
- Requirements: FR-5, FR-6. Design: execution/diagnostics decisions.

### Task 2: Bind canonical AO projects and mission records

- Evidence: `AgentOrchestratorOriginalSurface.tsx:34` calls `upstream_show`; upstream `routes/_shell.projects.$projectId.tsx:10` renders `SessionsBoard projectId={projectId}`; current host mission APIs still read the Coding Tools plan book.
- Files: upstream host/handler, source AO project/session persistence and integration controllers, workspace bindings. New metadata/controller modules budget: 400 lines each.
- Establish canonical project/job IDs, bind Coding Tools scopes, preserve legacy records and use one dispatcher. Verify both views read the same actual AO records.
- Requirements: FR-1, FR-6. Design: architecture and data model.

### Task 3: Persist reusable roles and immutable attempt settings

- Evidence: `src-tauri/src/integrations/ao.rs:64` stores node role, route, parents and coordinates; source AO `domain/projectconfig.go` already persists role-specific agent configuration.
- Files: existing AO metadata/config, host workflow and typed UI contracts; new focused team metadata module if needed, under 400 lines.
- Add named role specializations, template revisions, instructions/output expectations, scope and limits. Apply explicitly to queued tasks; active attempts retain captured settings.
- Verify: additive compatibility, workspace separation, revision conflicts and queued-versus-running edit tests.
- Requirements: FR-2, FR-6. Design: data model and API.

### Task 4: Implement Board/Team canvas and movable connections

- Evidence: `AgentOrchestratorSurface.tsx` already has `aoLevels`, `aoDependencyChange` and SVG connections; current layout orders cards by levels rather than honoring free coordinates.
- Files: existing Runtime surface/CSS, original-board surface, focused canvas component under 450 lines and graph tests.
- Add shared project/mission selection, pan/zoom, free positions, multi-select/alignment/Fit, valid port/branch connections and state-aware elastic motion. Keep real joins/cycle rejection and keyboard/reduced-motion paths.
- Verify: graph tests and real rendered desktop/narrow-window navigation, dragging and motion behavior.
- Requirements: FR-1, FR-3. Design: canvas architecture.

### Task 5: Add the role inspector and direct mission controls

- Evidence: current Runtime form already creates the WebGPT/Gemini/WebGPT graph and offers Start mission; cards expose receipts but not editable role details.
- Files: Runtime surface, focused inspector under 350 lines, existing model/harness APIs and tests.
- Wire Settings/Tasks/Output/History to real data. Expose model, role, instructions, scope, dependencies, expected output and limits without credentials. Preserve direct create/start/pause/stop controls.
- Requirements: FR-2, FR-5, FR-6. Design: API and data model.

### Task 6: Enforce capacity and bounded independent review

- Evidence: current `agent-orchestrator-workflow.cjs` `driveRun` observes one active node; the AO reducer validates all-parent readiness and reviewer verdicts.
- Files: canonical scheduler/metadata, host workflow, effective harness policy, settings and focused tests. New scheduling helper only if existing primitives cannot accommodate the change, under 400 lines.
- Reserve global/per-mission capacity, queue conflicting writes, apply lower limits to future starts, and count nested AO workers. Reviewers remain read-only. Return rejected work for two new attempts maximum, then hold with cause.
- Verify: concurrency/limit boundaries, capacity recovery, two-review-loop ceiling and no self-approval.
- Requirements: FR-4, FR-6. Design: scheduling decisions.

### Task 7: Verify, package, install and test the real mission

- Evidence: existing `verify-package.cjs` validates bundle manifests; `aiTemp/cpa-navigation-check.cjs` checks both panel routes; `aiTemp/ao-live-mission-state.json` identifies the held isolated run.
- Files: relevant test suites, build/resource manifests and verification report. Scratch artifacts stay under `aiTemp/work/ao-company-canvas`.
- Run focused covering tests/typechecks, real UI acceptance and exact WebGPT > Gemini > independent WebGPT review. Observe old held records without replay. Verify CPA switching, loopback listeners, receipts and recovery.
- Build from the verified baseline, back up changed program/runtime files, install/restart only non-DEV Coding Tools and verify installed behavior/hashes. Keep Codex and unrelated processes open.
- Requirements: FR-1 through FR-7. Design: testing and delivery.

## 检查点

- Task 1: causal failure evidence and real route proof, not plugin-warning speculation.
- Tasks 2–3: canonical IDs, compatible persistence and captured attempt settings.
- Tasks 4–6: working controls and scheduler policies with focused evidence.
- Task 7: actual installed UI and three-stage receipts; no completion claim from health alone.

## 需求覆盖矩阵

| Requirement | Tasks |
|---|---|
| FR-1 | 2, 4, 7 |
| FR-2 | 3, 5, 7 |
| FR-3 | 4, 7 |
| FR-4 | 6, 7 |
| FR-5 | 1, 5, 7 |
| FR-6 | 1, 2, 3, 5, 6, 7 |
| FR-7 | 7 |

## 文件变更清单

Use the real paths in design.md and each evidence block. Record exact additional AO persistence/controller files after tracing their existing consumers, before editing; reconcile added/modified files and budgets in the implementation ledger and final review.
