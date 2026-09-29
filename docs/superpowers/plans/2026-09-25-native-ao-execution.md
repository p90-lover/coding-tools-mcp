# Native AO Execution and Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans task by task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Execute a real Web GPT plan, AO-selected worker, and distinct Web GPT review from the durable tree without starting or calling Paseo.

**Architecture:** Build on the [AO board and tree plan](2026-09-25-native-ao-board-ui.md). Electron coordinates only the next ready step; the headless AO record owns revisions, receipts, route identity, and bounded output provenance. Reuse the existing Rust native Codex App Server bridge for tool, sandbox, and approval behavior rather than adding a second model tool loop. The exact Web GPT and CPA Gemini routes are hard gates, not assumed working catalog entries.

**Tech Stack:** Electron CommonJS, Rust headless and `src-tauri` Codex bridge, Codex App Server, Coding Tools Web GPT runtime, React/TypeScript, focused Node/Rust tests.

**Spec:** [Native AO Orchestrator design](../specs/2026-09-25-native-ao-orchestrator-design.md).

## Global constraints

- Finish and verify the AO board/tree plan first. Use a registered disposable workspace under this project's `aiTemp/` for all live model tests; never use the existing H: or F: task as a test.
- Web GPT always uses its dedicated browser bridge. Other models use the exact AO-selected harness/provider/model. For CPA workers, `shared-cpa-pool` is the approved account policy: CPA may select or fail over among connected Gemini accounts, but the model may not fall back. No Paseo dependency or automatic tool approval.
- A focused user confirms the exact run and selected routes once. Background stage starts require that persisted, revision-checked run grant; they do not require the GUI to remain focused. Tool and outside-workspace approvals still require a separate user decision.
- Keep the CPA proxy key in Electron main. A host-private one-shot handoff may send it only to the authenticated local headless process for one child launch. Do not place it in renderer IPC, config, command arguments, status, logs, `AppData`, or global Codex settings.
- Before implementing or activating that new private key handoff, show the exact local process boundary and get the user's separate confirmation. The key itself is never requested in chat.
- Use a dedicated AO `CODEX_HOME`, outside the delegated workspace. The nonsecret custom provider definition belongs in that home's user-level `config.toml`, not a project-local config. See the [official Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference).
- Reuse the [documented App Server](https://learn.chatgpt.com/docs/app-server) initialize, thread/start, turn/start, event, and approval contract through the existing Rust bridge. Its current bridge is opt-in, pins one model per connection, and declines unsupported approvals; preserve those constraints.
- Preserve the dirty worktree and running Codex app. No new Git worktrees or per-task commits. Keep build/test artifacts in `aiTemp/`, use recoverable installed backups, and do not publish or push until the user approves verified changes.
- Run GitNexus impact before symbol edits. UNKNOWN needs text callsites; HIGH/CRITICAL needs a warning before implementation.

## Review focus

1. A connected account or model catalog without a completed exact-model turn must not pass the route gate. Task 2 tests output and route provenance.
2. A secret-bearing renderer field, config file, argv, log, or status must be rejected or redacted. Task 1 tests every boundary with a sentinel key.
3. A pending or unknown send after a restart must never be replayed under another request key. Task 4 tests reconciliation.
4. An unapproved run cannot start in the background, while an approved run can advance without GUI focus. A tool or outside-workspace file request still waits for its separate user approval. Tasks 1, 3, and 5 test this.
5. Old assistant text, another agent's turn, empty worker output, or a failed review must not mark the run complete. Task 4 tests ownership and verdict gates.

---

### Task 1: Add an AO-owned native harness connection without leaking CPA credentials

**Files:**
- Modify: `src-tauri/src/codex_bridge/mod.rs:30-45,345-398`
- Modify: `src-tauri/src/lib.rs` and `rust-core/coding-tools-core/src/lib.rs` only to expose a narrow AO bridge facade to headless
- Modify: `rust-core/coding-tools-headless/src/lib.rs`
- Modify: `desktop-electron/electron/main.cjs`
- Test: focused existing Codex bridge tests, headless local-UI-token tests, new `desktop-electron/tests/native-ao-harness-boundary.test.cjs`

**Interfaces:**
- Consumes Plan A's `AoRun`, workspace identity, and guarded headless request channel.
- Produces renderer `AoHarnessConnect { workspaceId, runId, nodeId, harnessId, providerId, accountId, model, permissionProfile, confirm }` with **no key field**. Electron main maps these camelCase fields to the private headless snake_case DTO.
- Produces `rendererAoConnect(selection: AoHarnessConnect)` as a typed preload call, and host-private `hostAoConnect(selection, privateRoute)`, `hostAoControl({ sessionId, operation, requestKey, prompt })`, and `hostAoRead(sessionId)` methods. Only `hostAoConnect` can carry a CPA key.
- Electron main resolves a private `AoPrivateRoute` from its current provider/CPA state, then calls the authenticated headless AO connect route with that one-use secret. The headless response contains only session ID, route ID, and public status.

- [ ] Write RED tests with a sentinel CPA key: a renderer request containing `proxyApiKey` is rejected; a valid host-owned exact route reaches a child environment; serialized IPC output, status, argv, config, and logs contain no sentinel. An unapproved run cannot connect or start; an approved run can advance after the window loses focus without auto-approving tools. A second connection cannot replace the user's Native Codex session.

```js
const selection = {
  workspaceId: "qa", runId: "run-1", nodeId: "worker",
  harnessId: "codex-native", providerId: "cliproxyapi-antigravity",
  accountId: "shared-cpa-pool", model: "gemini-3.8-flash-high",
  permissionProfile: ":read-only", confirm: true,
};
await assert.rejects(() => rendererAoConnect({ ...selection, proxyApiKey: "SENTINEL_KEY" }));
const result = await hostAoConnect(selection, { proxyApiKey: "SENTINEL_KEY" });
assert.equal(result.model, "gemini-3.8-flash-high");
assert.equal(JSON.stringify(result).includes("SENTINEL_KEY"), false);
```

- [ ] Run focused tests and confirm RED at the absent AO-owned connect path, not at a malformed fixture.
- [ ] Reuse `codex_bridge::Hub` in a separate AO-owned instance. Keep its executable hash check, `:read-only`/`:workspace` profiles, request ledger, and approval handler. Add one allowlisted child environment variable after `env_clear()` for the exact private CPA route; never add a general renderer-supplied environment map.
- [ ] Build a dedicated nonsecret AO home config with `model_provider = "coding_tools_ao_cpa"`, CPA loopback `base_url`, `env_key = "CODING_TOOLS_AO_CPA_KEY"`, and `requires_openai_auth = false`. Inject only that env var into the selected child. Require `accountId: "shared-cpa-pool"`, the exact provider/model, loopback base URL, and a private key before spawning; never imply the pool pins one OAuth account.
- [ ] Add AO-owned headless connect/control/read routes requiring bearer and request admission. The initial run grant/connect requires a focused local-UI token and explicit confirmation of exact workspace/route/tool policy; save only that nonsecret approved scope in the AO record. Later control requires its matching run/node reservation and stable request key, not a focused window. Electron main obtains `cpaConnection().proxyApiKey` only after shared-pool eligibility, exact-model catalog, and workspace checks, calls the initial `headlessHost.request(..., { localConfirmation: true })`, and never passes the key through preload. Control/read delegate to the AO-owned Hub's existing `admit(Control)`/`Ticket::run` and `read`.
- [ ] Re-run the boundary tests and a focused `cargo check` using `CARGO_TARGET_DIR` under `aiTemp/`. Keep the existing Native Codex connect/status path unchanged.

### Task 2: Prove the exact Web GPT and AO Gemini routes in isolation

**Files:**
- Test: `desktop-electron/tests/native-ao-route-contract.test.cjs` with a synthetic local provider
- Evidence: redacted route receipts under `aiTemp/`

**Interfaces:** Produces a signed-off route receipt containing workspace ID, selected harness/provider/model IDs, the `shared-cpa-pool` policy, native thread and turn IDs, final text, and observed approval/tool state. It records the actual CPA auth index only when observed, otherwise `unknown`; it never contains keys or raw browser frames.

- [ ] Start with a synthetic provider bound to the AO-owned Codex home. Verify the child reads the nonsecret provider config and its private env key, uses the requested wire route, and does not spill the key in a failure. Run the focused contract test RED then GREEN.

```js
const session = await hostAoConnect(selection, { proxyApiKey: "SENTINEL_KEY" });
await hostAoControl({
  sessionId: session.id, operation: "start",
  requestKey: "qa-route-probe-1", prompt: "Reply READY without tools.",
});
let receipt;
for (let attempt = 0; attempt < 20; attempt += 1) {
  receipt = await hostAoRead(session.id);
  if (receipt.status === "completed") break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert.equal(receipt.providerId, "cliproxyapi-antigravity");
assert.equal(receipt.model, "gemini-3.8-flash-high");
assert.equal(receipt.status, "completed");
assert.equal(JSON.stringify(receipt).includes("SENTINEL_KEY"), false);
```
- [ ] In Plan A's registered `aiTemp/` workspace, use `:read-only` permission and a harmless text-only prompt. Verify the selected Web GPT `chatgpt-web/high` route with a real completed native turn and ownership evidence; do not count the browser smoke test or model catalog as this proof.
- [ ] Verify one exact AO Codex Native to CPA `gemini-3.8-flash-high` turn. Require a completed response and matching model/provider route. Deny any unexpected approval; stop on a tool request or uncertain receipt, inspect the saved request key, and do not create a new key blindly.
- [ ] **Hard gate:** if either exact route fails, do not run Tasks 3-6. Record the error and revise this plan with the user. Do not substitute one-shot CPA chat completions or another model.

### Task 3: Run selected AO stages through the owned harness

**Files:**
- Create: `desktop-electron/electron/native-ao-stage-runner.cjs`
- Modify: `rust-core/coding-tools-headless/src/lib.rs` AO harness control/read routes
- Modify: `desktop-electron/electron/main.cjs`
- Test: new `desktop-electron/tests/native-ao-stage-runner.test.cjs`, focused Rust Codex bridge tests

**Interfaces:**
- Produces `runStage({ workspaceId, runId, nodeId, requestKey, selection, prompt }) -> { sessionId, threadId, turnId, status, text }`.
- `selection` has exact harness, provider, model, capabilities, permission profile, and the explicit `shared-cpa-pool` policy. A missing or unsupported field rejects before thread/start.

- [ ] Write RED tests that an unavailable harness, a different model, no connected Gemini account in the shared pool, a foreign workspace, or a renderer-provided env map fails before a native turn. A permission request remains pending until the existing local approval UI answers it.
- [ ] Resolve the exact provider plan from the private provider store, but treat it as a preflight only. Connect the selected AO-owned Hub, initialize it, use its `admit(Control)`/`Ticket::run` and `read` methods, and record the actual thread/turn identity. Keep user Native Codex sessions separate.

```js
const selection = {
  harnessId: "codex-native", providerId: "cliproxyapi-antigravity",
  accountId: "shared-cpa-pool", model: "gemini-3.8-flash-high",
  permissionProfile: ":read-only", capabilities: [],
};
const receipt = await runStage({
  workspaceId: "qa", runId: "run-1", nodeId: "worker",
  requestKey: "run-1-worker-start", selection, prompt: "Reply READY without tools.",
});
assert.equal(receipt.status, "completed");
assert.equal(receipt.text, "READY");
```
- [ ] Bound prompt and output size. Report tool capability as unavailable unless the selected harness advertises it. Reuse the existing approval handler; do not synthesize `accept` or widen the sandbox.
- [ ] Re-run the focused tests. A denied or expired tool approval must produce held/failed stage evidence, not completed output.

### Task 4: Drive planner, workers, and reviewer from durable AO receipts

**Files:**
- Create: `desktop-electron/electron/native-ao-control-plane.cjs`
- Modify: `src-tauri/src/integrations/ao.rs` and headless AO update route from Plan A
- Modify: `desktop-electron/electron/main.cjs` startup/disposal
- Test: new `desktop-electron/tests/native-ao-control-plane.test.cjs`, focused `ao.rs` tests

**Interfaces:** `drive(runId) -> AoRunView` reads a revisioned AO run, reserves one ready node with its stable request key, calls Task 3's runner, and persists only owned output/provenance. `AoRunView` contains status, ordered steps, and reviewer/worker provenance. It returns a held view on unknown outcomes and never replays merely because the GUI refreshed.

- [ ] Write RED tests for order: Web GPT planner output first, then one or more AO-selected workers after all parents finish, then a distinct Web GPT reviewer after all current worker outputs exist. Add stale text, duplicate request key, restart, denied approval, and reviewer failure cases.

```js
const result = await control.drive("run-1");
assert.deepEqual(result.steps.map((step) => step.role), ["planner", "worker", "reviewer"]);
assert.notEqual(result.reviewer.turnId, result.worker.turnId);
assert.equal(result.status, "finished");
```

- [ ] Run focused tests and confirm RED against the absent control plane.
- [ ] Reserve each stage with AO graph/run CAS before any external call. Check the initial approved run scope, then store workspace, exact route, stable request key, and pending receipt. After the native turn settles, save bounded assistant text with session/thread/turn identity. Use the Web GPT route for planner/reviewer regardless of worker harness selection.
- [ ] On timeout, process exit, or unknown send, read the same native session/ledger and AO record. If completion cannot be proven, set held and await user action. Cancel prevents new starts but retains sent receipts. The reviewer must use a different turn and a verdict over actual current child output.
- [ ] Re-run the focused tests. Reopening `codingTools.orchestrator.read` must not call `drive`.

### Task 5: Show real execution and permission state in the tree

**Files:**
- Modify: `desktop-electron/src/features/NativeOrchestratorSurface.tsx` and `native-orchestrator.css`
- Modify: `desktop-electron/src/api/contracts.ts` for public AO status/approval fields
- Test: `desktop-electron/tests/native-ao-surface.test.cjs`, frontend typecheck

**Interfaces:** Cards show actual route, harness, agent/thread/turn identity, current permission request, bounded output, and reviewer verdict from AO readback. `codingTools.orchestrator.approve({ runId, nodeId, approvalId, decision })` accepts only a click-originated `accept` or `decline` through the guarded main-window handler. Manual notes never satisfy output or review.

- [ ] Write RED tests: pending approval is visible but not accepted; an empty worker output cannot reveal a finished review; reopening after a saved run renders the same state without dispatch.
- [ ] Add an explicit local approval action that routes to the existing native approval handler for the selected AO-owned session. Require the user's click; a refresh, drag, or preview open never approves.

```ts
await window.codingTools.orchestrator.approve({
  runId: run.id, nodeId: selected.id,
  approvalId: selected.pendingApproval.id, decision: "decline",
});
```
- [ ] Re-run focused UI tests and `bun run typecheck`. Verify reduced motion, keyboard access, and narrow-window state remain correct.

### Task 6: Install and prove the AO-only run

**Files:** No product edit unless a specific failed check identifies one. Evidence under `aiTemp/`; replaced installed files backed up recoverably.

- [ ] Run focused Node/Rust tests, headless release build, frontend typecheck/build, and scoped `git diff --check`. Report the unrelated missing Rust test fixture separately if still present.
- [ ] Compare staged renderer, app.asar, and headless executable against the exact current non-DEV installation. Confirm active HTTP/browser turns are safe; back up exact targets; restart only Coding Tools. Codex stays open.
- [ ] Confirm the Paseo decommission plan left no managed Paseo process or dispatch route. In the registered isolated `aiTemp/` workspace, run one harmless task with Web GPT planner, exact AO-selected Gemini worker, and a separate Web GPT review. Require three completed, owned outputs and a real verdict; no automatic tool approval.
- [ ] Reopen Coding Tools and read the same AO run. Confirm no duplicate Create/send/tool call, correct task-tree states and route labels, retained old profiles, and native/Web model availability. Make one separately approved harmless read-only MCP tool call. Probe computer/vision only if the selected harness advertises them and their separate consent gate is satisfied.
- [ ] Keep the existing [orchestrated repair plan](2026-09-23-coding-tools-orchestrated-repair.md) as a later consumer of this engine. Do not claim the Repair button, Anneal board, Router IPC parity, or CommandCode are complete because this core run passed.

## Stop conditions

An unsupported exact model route, missing private credential handle, unresolved native turn, unsatisfied permission, tool use outside the isolated workspace, or installed archive drift stops execution. Record the durable run and evidence; do not fall back to Paseo, another model, a new request key, or raw profile edits.
