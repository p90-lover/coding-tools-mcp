# Tasks: add-a-register

## 概述
Implement the Runtime Register integration described by requirements.md and design.md.

## 交付物清单（Scope-lock）
- Expected new files:7 (3specs, host, surface, host tests, native regression).
- Expected modified files:9 (main, preload, types, App, i18n, shared scoped CSS, renderer wiring, preload boundary, quit lifecycle).
- Reconcile the final list after existing contract tests identify whether all three test files need changes; do not create unrelated changes.
- Existing large modules receive narrow insertion-only edits. New host <=500lines, surface<=200lines, each new test<=300lines; split only if new responsibilities exceed those budgets.

## 任务列表
### 阶段 1: Context and specification
- [x] 1.1 Bind the isolated source branch and inspect both approved projects without changing user data.
  - **证据块:** GptBrowserSurface.tsx31–56 uses native active/bounds updates; main.cjs300 constructs a sandboxed WebContentsView. Reg-machine main.py69–109 starts database/background workers.
  - **涉及文件:** these3specs, about180lines total; graph index is refreshed or staleness explicitly reconciled before impacts.
  - _需求: FR-1, FR-2, FR-3_ | _设计: Architecture and decisions_

### 阶段 2: Core integration
- [x] 2.1 Implement loopback service discovery, explicit start, canonical project persistence and owned-process shutdown.
  - **证据块:** upstream infrastructure/health_runtime.py10–11 returns account-manager-v2; main.py69 starts maintenance. Existing main.cjs2534–2551 uses bounded quit steps.
  - **涉及文件:** register-host.cjs<=500newlines, main.cjs<=90addedlines; use atomic-file.cjs rather than another persistence helper.
  - _需求: FR-2, FR-3_ | _设计: Service/API and ownership_
- [x] 2.2 Expose only typed Register IPC operations with main renderer/focus validation.
  - **证据块:** preload.cjs62–71 exposes named GPT methods; main.cjs1934–1971 registers scoped channels; assertFocusedMainWindow at1081 protects mutations.
  - **涉及文件:** preload.cjs<=15addedlines, types.ts<=40addedlines, existing preload boundary test<=30addedlines.
  - _需求: FR-2, FR-3_ | _设计: API_
- [x] 2.3 Add the Runtime entry and real native workspace with responsive host controls.
  - **证据块:** App.tsx775 defines Runtime navigation; keepAlive at436; GptBrowserSurface31–56 measures its slot; original-ui.css provides existing hostbar/frame hierarchy.
  - **涉及文件:** RegisterSurface.tsx<=200newlines, App.tsx<=25addedlines, i18n.ts<=8addedlines, original-ui.css<=25addedlines.
  - _需求: FR-1, FR-2, FR-3_ | _设计: Native hosting and UI_

### 阶段 3: Verification
- [x] 3.1 Verify host ownership, startup races, auth isolation and navigation against FR acceptance.
  - **证据块:** upstream core/db.py16–22 supports ACCOUNT_MANAGER_DATABASE_URL; existing tests/native/chat-preview.cjs demonstrates owned Electron fixture/test cleanup.
  - **涉及文件:** register-host.test.cjs<=300lines, native/register.cjs<=300lines, existing renderer/quit tests<=40addedlines.
  - _需求: FR-1, FR-2, FR-3_ | _设计: Test strategy_
- [x] 3.2 Build and render the isolated app/real upstream interface, verify controls and clean only owned disposable fixtures.
  - **证据块:** upstream frontend/vite.config.ts14–15 builds static; Register page mount only reads/polls and its explicit submit creates tasks.
  - **涉及文件:** generated outputs only under aiTemp/register-runtime-20261020; preserve source tests/specs and required recovery backups.
  - _需求: FR-1, FR-2, FR-3_ | _设计: Test strategy_

## 需求覆盖矩阵
| Requirement | Design | Tasks |
|---|---|---|
| FR-1 | Native hosting/UI | 1.1,2.3,3.1,3.2 |
| FR-2 | Service/API | 1.1,2.1,2.2,2.3,3.1,3.2 |
| FR-3 | Ownership/auth | 1.1,2.1,2.2,2.3,3.1,3.2 |

## 检查点
- [x] Specification passes check_spec and estimate is recorded before implementation.
- [x] Pre-edit graph risks/callers are reported and narrow changes implemented.
- [x] Focused tests, build, real rendered states, source review and cleanup evidence are recorded.

## 文件变更清单
New production host/surface and required regression tests are listed in Scope-lock. Existing integration files retain unrelated code and dirty changes. Final exact paths/counts are recorded in the implementation evidence before convergence.


## Verification outcome
- 12 host tests and 54 launcher contracts passed; separate renderer/window parity checks passed.
- TypeScript, renderer and preload builds passed.
- Electron 41.10.7 native QA passed desktop/compact layouts, four locales, cookie/SSE isolation and the real upstream UI with fixture-only login and data.
- No live registrations or SMS actions were executed. Publication and production installation await the user's delivery choice.
