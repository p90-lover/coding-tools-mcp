# Tasks: Codex permission and readiness parity

## 概述
Implement FR-1 through FR-6 using existing native and app authorization infrastructure. Preserve legacy settings and distinguish saved versus effective rights.

## 交付物清单（Scope-lock）
- Three specification files.
- Native policy/typed-consent changes, role-persistence changes, chat permission panel, app-scope integration, browser-readiness gate, and focused regressions.
- No release artifacts, global config edits or unrelated primary-checkout changes.
- Expected task groups: 6. Actual file list is recorded with implementation; sizeable new files stay under 500 lines.

## 任务列表
### 阶段 1: 准备工作
- [x] 1.1 Freeze the isolated base and verify native permission capability/schema metadata without model inference.
  - 证据块: codex_bridge/mod.rs policy/thread/turn mapping; installed codex --help.
  - 文件: Existing runtime metadata code; no global configuration writes.
  - _需求: FR-2_ · _设计: Native role policy_
- [x] 1.2 Run red regressions for policy round-trip loss and browser admission before implementing.
  - 证据块: RoleEditor workerRoute/nativePermission; workflow connect/advance/drive.
  - 文件: Existing focused CJS tests; fixtures under aiTemp.
  - _需求: FR-1, FR-6_ · _设计: Persistence and readiness_

### 阶段 2: 核心实现
- [x] 2.1 Preserve optional role policy and bind actual native policy on every thread/turn.
  - 证据块: AoRoute, ao_connect_policy, Bridge::control and approval_policy.
  - 文件: Rust bridge, AO data/validation, headless connection and CJS resolver; focused changes only.
  - _需求: FR-1, FR-2_ · _设计: Native role policy_
- [x] 2.2 Route typed native consent requests and exact replies, retaining live scope.
  - 证据块: Bridge::receive, NativeApproval::reply, approveAoHarness, chat approvals.
  - 文件: Existing bridge/request handlers; a focused new module only if needed.
  - _需求: FR-4_ · _设计: Typed pending-request union_
- [x] 2.3 Add the composer permission trigger, all-role/per-role selection and effective-state readback.
  - 证据块: Chat composer, Surface applyTeam, HarnessPicker, teamForMission.
  - 文件: Chat/Surface/RoleEditor/types/styles; no unrelated visual redesign.
  - _需求: FR-1, FR-3_ · _设计: Effective application_
- [x] 2.4 Connect workspace MCP and existing app/native grant controls with explicit scope and existing confirmations.
  - 证据块: WorkspacePanel updatePolicy, NativeCodexPanel, computer/snapshot grant APIs.
  - 文件: Existing API routes and scoped menu integration.
  - _需求: FR-5_ · _设计: Native versus app policy_
- [x] 2.5 Gate all WebGPT roles at connect and dispatch using fresh non-navigating session/host evidence.
  - 证据块: BrowserHost authentication probe; workflow manual/background dispatch.
  - 文件: browser-host.cjs, workflow.cjs, main.cjs and focused tests.
  - _需求: FR-6_ · _设计: Fresh readiness_

### 阶段 3: 集成测试
- [x] 3.1 Verify red/green permission and admission regressions, native request shapes and renderer controls.
  - 验收点: No default overwrites; exact policy binding; signed-out/unknown hold; native/MCP reply subset; deny/cancel/stale remain safe.
  - _需求: FR-1, FR-2, FR-3, FR-4, FR-5, FR-6_
- [x] 3.2 Run focused Rust/CJS suites and renderer typecheck/UI test; broaden only for material failures.
  - _需求: NFR-5_
- [x] 3.3 Published and attached https://github.com/p90-lover/coding-tools-mcp/pull/252 with source commit `d1444ae2134cd0a333ea36985ff2bc043405732a`; only the 29 scoped source/test/spec files are included.
  - _需求: NFR-1, NFR-2, NFR-4_

## 检查点
- [x] Specifications and concrete policy design approved and check_spec passed.
- [x] Each changed public/native policy path has real persistence/effective evidence.
- [x] No unresolved high-priority review finding.
- [x] Only task-owned files committed and PR attached; app not restarted.

## 需求覆盖矩阵
| ID | Design section | Task | Status |
|---|---|---|---|
| FR-1 | Persistence | 1.2, 2.1, 2.3, 3.1 | Implemented and source-verified |
| FR-2 | Native policy | 1.1, 2.1, 3.1 | Implemented and source-verified |
| FR-3 | Effective application | 2.3, 3.1 | Implemented and source-verified |
| FR-4 | Typed requests | 2.2, 3.1 | Implemented and source-verified |
| FR-5 | Separate scopes | 2.4, 3.1 | Implemented and source-verified |
| FR-6 | Fresh readiness | 1.2, 2.5, 3.1 | Implemented and source-verified |

## 文件变更清单
| Surface | Operation | Budget | Purpose |
|---|---|---|---|
| Specification files | Create | Each under 250 lines | Requirements/design/tasks |
| Native bridge/AO/headless modules | Focused modification | Existing files retained; new modules under 500 lines | Real policy and consent |
| Workflow/browser/main CJS | Focused modification | No broad refactor | Admission and RPC wiring |
| Chat/role/surface/type/style | Focused modification | New panel under 500 lines | Functional menu |
| Existing test suites | Modify/add regression | Small inputs | Functional proof |

## 交付前自检
- [x] No placeholder or invented capability.
- [x] Native/app policies remain distinct and legacy-compatible.
- [x] Saved versus running-effective scope is honest.
- [x] Focused tests and required UI proof are real.
- [x] Temporary ownership/disposition recorded: test processes stopped; the disposable managed worktree will be archived after publication. Required tracked regression fixtures remain in Git; primary diagnostic/backups blocked by the tool's deletion guard are reported separately.

## Verified source result (2026-10-04)
- Node: the seven focused workflow/readiness/browser/permission/route/chat suites passed 201/201, exit 0.
- Renderer: full TypeScript check, edited CJS syntax checks, and production Vite build passed; build used the installed dependencies and task-owned aiTemp output, not a deployed app.
- Rust: bridge 21 passed / 3 model/command tests intentionally ignored; ao_team 5, route serialization 1, headless policy/DTO/reconnect 3, and graph integration 2 passed.
- Desktop strict clippy and new-module rustfmt passed. PR-only follow-up also clears headless strict clippy without suppressions: named hub map, boxed mission payload and response errors, boolean assertions and a direct graph-fixture initializer. Fifteen workspace/auth/policy/DTO tests plus two graph tests passed; the added regression preserves flat request JSON and bounds mutation stack size. No installed-app deployment or restart occurred.
- Real installed Codex metadata-only probe returned allowed native IDs :read-only, :workspace, :danger-full-access. No model turn, account login or active mission was executed.
- A real browser exercised the menu using mocked metadata/save callbacks; no console errors. Its task tab/server were stopped. This is not installed-app/native-model end-to-end proof.
- Independent bounded final source review found no remaining actionable finding after fixing split normalization, deferred retry policy, exact modern command scope and typed approval handling.
- GitNexus detect_changes returned all 203 matched changed symbols and 16 affected processes (18 tracked files), without partial/truncated results. Aggregate risk is CRITICAL. The index is 94 commits stale and excludes new unindexed modules; current-source review, compiler/tests and new-module inspection are the authority, not an all-clear from the graph.
- Reconnects replace only a mismatched idle owned native connection after exact route/state and existing consent/grant checks. Active attempts retain their original policy. Deferred changes bind only explicit fields at safe retry/requeue boundaries.
- Published PR: https://github.com/p90-lover/coding-tools-mcp/pull/252 (OPEN, 29 scoped files), source head `d1444ae2134cd0a333ea36985ff2bc043405732a`. Its Runtime/contracts/types/renderer CI check passed. A documentation-only follow-up records publication; final managed archive/retained-file results are reported in the task.
