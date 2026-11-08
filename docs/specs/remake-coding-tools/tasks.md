# 任务清单：remake-coding-tools

## 概述
Integrate the installed Codex Windows engine without replacing local consent or importing unrelated shared-workspace work.

## 交付物清单（Scope-lock）
Actual new implementation modules: 2. Modified production files: 8. New focused test files: 1. Specification documents: 3. Total task files: 14. Approximately 12 new integration functions and 8 modified entry points. Keep each new module below 500 lines; isolate worker transport from computer lease orchestration.

## 任务列表
### 阶段 1: 准备工作
- [x] 1.1 Locate the installed Windows window2 reference and obtain the user's runtime-dependency decision.
  - **证据块**: Installed plugin `docs/api.md:13` declares `Window2ComputerUseClient`; `api.md:19` declares `click(input: ClickInput)`; `api.md:101` declares window-relative drag coordinates. The user selected installed-engine reuse.
  - **涉及文件**: These three specification documents, approximately 220 lines total.
  - _需求: FR-1, FR-2_ ｜ _设计: 技术方案、设计决策 1_

### 阶段 2: 核心实现
- [x] 2.1 Implement an owned installed-Sky worker with strict method/window validation, bounded messages and cancellation.
  - **证据块**: `src-tauri/src/tools/computer/mod.rs:54`: `EXECUTION.try_lock()`; `mod.rs:77`: `fn validate(...)`; installed Sky exposes `WindowsComputerUseClient` and `close()`.
  - **涉及文件**: New `codex.rs` and `codex-bridge.mjs`, each below 500 lines; focused worker tests below 400 lines.
  - _需求: FR-1, FR-3_ ｜ _设计: 架构设计、数据模型_
- [x] 2.2 Route native window2 methods and legacy steps through the actual engine without bypassing receipt and scope checks.
  - **证据块**: `src-tauri/src/tools/computer/mod.rs:584`: `fn execute_step(...)`; `mod.rs:632`: `begin_receipt(...)`; `schema.rs:62` currently accepts only `step` or `steps` for input tools.
  - **涉及文件**: `mod.rs` additive integration sections below 180 lines; `schema.rs` below 60 changed lines; `capture.rs` below 100 changed lines if native image normalization is required.
  - _需求: FR-1, FR-2, FR-3_ ｜ _设计: API 设计、设计决策 2、设计决策 3_
- [x] 2.3 Identify the actual engine in the local monitor and preserve truthful activity, Pause and Stop.
  - **证据块**: `src/lib/components/ComputerOverlay.svelte:57` currently says `No Codex agent`; `src/lib/computer-view.js:23` currently reports generic ChatGPT/MCP control. `mod.rs:861` reports `Windows UI Automation + SendInput (not Codex)`.
  - **涉及文件**: `ComputerOverlay.svelte`, `computer-view.js`, at most 70 changed lines total.
  - _需求: FR-1, FR-3_ ｜ _设计: 技术方案、架构设计_

### 阶段 3: 集成测试
- [x] 3.1 Verify forwarding, wrong-window denial, malformed responses, local revocation, replay protection and missing runtime against all acceptance criteria.
  - **证据块**: `src-tauri/src/tools/computer/mod.rs:931` contains lease/heartbeat tests; `ComputerOverlay.svelte:34` clears frames before Stop.
  - **涉及文件**: New focused worker test and inline Rust tests; no real desktop input in automated tests.
  - _需求: FR-1, FR-2, FR-3_ ｜ _设计: 测试策略_
- [x] 3.2 Run graph analysis, relevant Rust/Node/frontend checks, inspect the exact task diff and deliver a scoped PR.
  - **证据块**: `AGENTS.md:74` requires scoped GitHub delivery; existing shared staging contains unrelated provider/UI work.
  - **涉及文件**: Task files only; do not modify unrelated staged files.
  - _需求: FR-1, FR-2, FR-3_ ｜ _设计: 风险评估、测试策略_

## 检查点
- [x] Reference and user decision established.
- [x] Native execution and Stop boundary implemented.
- [ ] Acceptance criteria, verification and scoped PR completed.

## 需求覆盖矩阵
| 需求 ID | 设计章节 | 任务编号 | 状态 |
|---|---|---|---|
| FR-1 | 技术方案、设计决策 1 | 1.1, 2.1, 2.2, 2.3, 3.1, 3.2 | In progress |
| FR-2 | API 设计、设计决策 2 | 1.1, 2.2, 3.1, 3.2 | In progress |
| FR-3 | 架构设计、设计决策 3 | 2.1, 2.2, 2.3, 3.1, 3.2 | In progress |

## 文件变更清单
| 文件 | 操作 | 行数预算 | 说明 |
|---|---|---|---|
| computer/codex.rs | New | 450 | Owned process and runtime discovery |
| computer/codex-bridge.mjs | New | 350 | Original Sky integration and validation |
| computer/mod.rs | Modify | 180 changed | Lease and receipt integration |
| computer/schema.rs | Modify | 60 changed | Alternative window2 action shape |
| computer/capture.rs | Modify if needed | 100 changed | Actual engine frames |
| ComputerOverlay.svelte | Modify | 45 changed | Actual engine/activity presentation |
| computer-view.js | Modify | 25 changed | Engine-specific state labels |
| tests/codex-computer-bridge.test.mjs | New | 400 | CI-discovered mock engine contracts without desktop input |
| computer/native.rs | Modify | 160 removed | Remove the independent SendInput fallback; retain identity/UIA guards |
| computer/unsupported.rs | Modify | 20 changed | Match the revised platform guard API |
| tools/registry_definitions.rs | Modify | 4 changed | Truthful installed-engine descriptions |
| Three spec documents | New | 220 total | Scope and verification evidence |

## 检查清单
- [x] Scope, evidence, requirement links and line budgets recorded.
- [x] Reconcile actual changed files before delivery.
- [x] Complete affected acceptance tests and document remaining validation limitations honestly.

## Verification evidence
- Rust computer-control tests: 7 passed, 0 failed, 2 interactive fixtures deliberately ignored. Final path/geometry changes compiled in this run.
- Node bridge/lifecycle tests: 10 passed, including a fresh rerun before publication.
- Rust compile and all-targets Clippy passed; final formatting check passed. A final Clippy rerun is recorded separately in the PR.
- Focused Svelte check: 78 files, zero errors/warnings. Both control components compile without warnings.
- Installed Sky 0.7.12 private-stdio smoke and owned WinForms native screenshot/keyboard/type/accessibility round trip passed; no screenshots were persisted.
- Full frontend check remains blocked by the existing SvelteKit dependency/config mismatch. A side-by-side native-overlay visual comparison was unavailable; full-app pixel equivalence is not claimed.
- Shared-workspace graph risk is HIGH with a stale index. PR delivery remains tracked by task 3.2; no installation or restart is included.
