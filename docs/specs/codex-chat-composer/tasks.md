# Codex Chat Composer Implementation Plan

> For agentic workers: use superpowers:executing-plans for inline work or explicitly delegated isolated tasks. Checkbox tasks carry the test gate.

**Goal:** Implement the approved Codex-themed chat controls and real single/team execution in PR252.
**Architecture:** Reuse AgentOrchestratorChat/Surface, existing canvas, route picker, typed native approvals and revisioned team APIs. Add only the small presenter/data contracts needed for explicit execution mode and actual saved setup selection.
**Tech Stack:** React/TypeScript, existing scoped CSS, CJS workflow, Rust headless/AO.
**Spec:** docs/specs/codex-chat-composer/requirements.md

## Global constraints
PR-only/no app restart or patch. Preserve raw role permissions and live attempt identities; no dependency additions or blanket app grants. Claude Code default; WebGPT locks Native Codex. Temp QA artifacts under aiTemp/chat-composer-ui.

## Review focus
- Changing mode/selector while a turn is active never changes or resubmits it.
- WebGPT cannot be sent to an external harness, and model switching preserves saved permission tuple.
- Deleted/stale/wrong-workspace Team setup is rejected, not replaced by the global default.
- Single-model execution does not accidentally dispatch workers/reviewer.
- Three permission controls retain actual confirmation and unsupported/managed restrictions after removing UI clutter.

## Tasks
### 1. Routing defaults and lock
Files: RoleEditor.tsx; ao-webgpt-route.test.cjs.
- [x] New regression fails for native/non-WebGPT fallback.
- [x] Default unselected/new non-WebGPT route to Claude Code; preserve explicit AO choice.
- [x] WebGPT disables harness select with Native Codex explanation.
- [x] Existing route tests green 8/8; raw permission roundtrip retained.

### 2. Composer presenters and navigation
Files: AgentOrchestratorChat.tsx; a focused composer-controls module if existing code cannot cover it; agent-orchestrator.css; existing renderer tests.
- [x] Red/green mode controls hide inactive selector and do not send.
- [x] Separate Model popup (models/harness/effort/context) and saved Team popup.
- [x] Header buttons wire to existing Team graph and Mission Board.
- [x] Permissions popup shows only three correct icon rows; full-access confirmation remains.
- [x] Tests cover actual clicks, keyboard close/focus, switch visibility and saved selections.

### 3. Real source data/execution contract
Files: Surface.tsx; workflow.cjs; headless/AO modules only if required.
- [x] Reuse actual saved Runtime Team data, not demo names. Keep legacy response support.
- [x] Define explicit single/team request fields and revision scope; single executes one model without hidden team stages.
- [x] Mode and choice bind to the new attempt only; current receipts/policies remain immutable.
- [x] Add red→green dispatch/stale-revision/wrong-scope regressions before implementation.

### 4. Source QA and PR delivery
- [x] Focused Node/Rust tests and renderer tsc/build.
- [ ] Render desktop and narrow viewport; verify all popup states, console and comparison against approved image.
- [ ] Independent bounded review, required graph change analysis, scoped commit/push to existing PR252.
- [ ] Stop owned test server/tab; no installed app changes. Report any guard-blocked temporary cleanup accurately.

## Verified result and review rulings (2026-10-05)
- 131 focused Node tests passed: workflow, upstream lifecycle, actual renderer handlers, permission controls, chat and model routing.
- 23 unique focused Rust tests passed across AO/team, graph, composer DTO and the existing enum-layout regression. Both strict Clippy suites passed; renderer TypeScript and production build passed (existing bundle-size warning).
- Final independent review has no remaining P1/P2 in this increment. Fixed deferred narrowing on Single restart, unsupported/inherited adapter tuples, Codex workspace TUI fallback, and boxed the new optional route to retain flat JSON and bounded enum layout.
- Ruling: a Single chat has no separate naming/recovery model call; explicit retry stays on its selected route. Running receipts remain immutable.
- Ruling: installed AO adapters receive explicit accept-edits/auto/bypass requests, never inherited default. These are not Native OS-sandbox/effective-policy readback; unsupported capabilities remain disabled.
- Required graph analysis returned 88 matched symbols and 7 processes without partial/truncated output, HIGH aggregate impact. The index is stale; newly added modules and actual current call sites were reviewed/tested separately. This is not an auto-merge assurance.
- Desktop browser fixture rendered the new Single composer, Model popup, WebGPT Native lock and return to Claude, and three-icon permission menu; fresh page console was clean after correcting fixture-only React cache setup.
- Browser-only Full access confirmation blocked in-app browser control. Full confirmation was observed; later Team/graph interaction and narrow visual QA remain unverified. Actual native Mission Board embedding and model/permission end-to-end tests are intentionally not run under PR-only scope.
- Installed app, credentials, shared grants and global configuration remain untouched.
