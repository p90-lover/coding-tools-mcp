# Native AO Board and Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans task by task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the Runtime Structured Orchestrator form with a durable, full-pane AO task tree that does not call Paseo.

**Architecture:** Keep visible tasks in the existing workspace workflow board. Add AO run and graph records to the same `AppData` file, then save board and run changes in one revision-checked transaction. Electron exposes only guarded local read/update APIs; model dispatch belongs to the separate execution plan.

**Tech Stack:** Rust `coding-tools-headless` and `src-tauri`, Electron CommonJS, React/TypeScript, existing Node/Rust tests.

**Spec:** [Native AO Orchestrator design](../specs/2026-09-25-native-ao-orchestrator-design.md).

## Global constraints

- Do not create a Git worktree or make per-task commits. Preserve the dirty checkout; commit or push only reviewed, verified AO changes with user approval.
- Use Unified Agent Tools with this exact workspace root. Keep generated targets, QA workspaces, and scratch scripts under `aiTemp/`; use recoverable Trash, not deletion.
- Run GitNexus impact before changing each indexed symbol. Treat UNKNOWN as unresolved and inspect text callers; warn before HIGH or CRITICAL changes.
- Keep the current non-DEV app, Codex, Web GPT, CPA, MCP, and legacy Paseo records intact. The separate Paseo decommission plan removes its active integration, not its saved records. This plan contains no model dispatch and no credential migration.
- Use the current dark Coding Tools shell and native sidebar. Preserve the `coding-tools-orchestrators-v1` localStorage key for explicit import or export.
- MCP-probe-kit CLI is available at the checked-in compatible version `4.0.2`; resume the existing feature plan instead of starting a duplicate.

## Review focus

1. A junction or duplicate spelling of the same workspace path must not create two profiles or hide the confirmed target. Task 1 tests canonical paths and duplicate detection.
2. Missing bearer, local-UI token, focus, or confirmation must not register a workspace. Task 2 tests each refusal.
3. A stale board or graph revision must leave both board tasks and AO records unchanged. Task 3 tests atomic rejection.
4. A cycle, unknown parent, cross-run edge, or two-parent card with one unfinished parent must not become runnable. Task 3 tests each case.
5. Importing an old localStorage profile must not launch it, erase it, or silently select a model/harness. Task 5 tests this migration boundary.

---

### Task 1: Share guarded workspace creation

**Files:**
- Modify: `src-tauri/src/data/store.rs`
- Modify: `src-tauri/src/commands/workspace.rs:59-73`
- Test: inline `src-tauri/src/data/store.rs` tests and existing `src-tauri/src/workspace/resources.rs` tests

**Interfaces:**
- Produces: `DataStore::create_workspace(&mut self, path: String, name: Option<String>) -> AppResult<WorkspaceProfile>`.
- Tauri `create_workspace` delegates to that method; Task 2 calls it through `CoreState::with_data`.

- [ ] Write a failing test using `DataStore::from_data(AppData::default())`: an existing directory creates one profile; a second spelling of its canonical path is refused before new secrets or ports are saved.

```rust
let scratch = std::env::var("CODING_TOOLS_TEST_TMP_ROOT").unwrap();
let root = tempfile::Builder::new().prefix("ao-workspace-").tempdir_in(scratch).unwrap();
let mut store = DataStore::from_data(AppData::default()).unwrap();
let first = store.create_workspace(root.path().to_string_lossy().into_owned(), Some("QA".into())).unwrap();
assert_eq!(store.list().len(), 1);
assert!(store.create_workspace(root.path().to_string_lossy().into_owned(), Some("Again".into())).is_err());
assert_eq!(store.list()[0].id, first.id);
```

- [ ] Run the focused store test with `CARGO_TARGET_DIR` under `aiTemp/`; require RED because `create_workspace` does not exist. Test directories use `tempfile::Builder::tempdir_in` with `CODING_TOOLS_TEST_TMP_ROOT` set to this project's `aiTemp/`.
- [ ] Implement the shared method by canonicalizing an existing directory, rejecting duplicate canonical roots, calling `WorkspaceProfile::new`, `assign_free_workspace_ports`, `init_workspace_secrets`, and `add` in that order. Validate the path before secret initialization; roll back newly initialized secrets if the final add fails.
- [ ] Change the Tauri command body to `state.with_workspaces(|store| store.create_workspace(path, name))`. Keep its public return shape.
- [ ] Re-run the focused test and the existing free-port tests. Check a preoccupied port and a symlink or junction target in the path fixture; do not claim the allocator checks OS ports unless that case passes.

### Task 2: Expose a private Electron workspace-create operation

**Files:**
- Modify: `rust-core/coding-tools-headless/src/lib.rs:2170-2210`
- Modify: `desktop-electron/electron/ipc-schema.cjs`
- Modify: `desktop-electron/electron/main.cjs:929`
- Modify: `desktop-electron/electron/preload.cjs:169`
- Modify: `desktop-electron/src/api/contracts.ts:58`
- Test: existing headless `workspace_auth_tests`, `desktop-electron/tests/workspace-auth-ipc.test.cjs`, `preload-boundary.test.cjs`

**Interfaces:**
- Consumes Task 1's `DataStore::create_workspace`.
- Produces authenticated `POST /api/v1/workspaces` and `codingTools.workspaces.create({ path, name, confirm })`, returning only `{ id, name, path }`.

- [ ] Write RED tests for a valid local request and four refusals: no bearer, no private local-UI token, `confirm:false`, and extra request keys. Assert a rejected request leaves `DataStore.list()` unchanged.

```js
const qaPath = path.resolve(__dirname, "../../aiTemp/ao-workspace-contract");
fs.mkdirSync(qaPath, { recursive: true });
const created = await api.workspaces.create({ path: qaPath, name: "QA", confirm: true });
assert.equal(created.name, "QA");
assert.equal(created.path, fs.realpathSync.native(qaPath));
await assert.rejects(() => api.workspaces.create({ path: qaPath, name: "QA", confirm: false }));
```

- [ ] Run the three named contract tests and confirm RED for the absent route and preload method.
- [ ] Add a strict headless DTO with `deny_unknown_fields`, a POST route beside GET, and the existing `auth`, `admit`, and `local_ui_authorized` checks before `CoreState::with_data(|store| store.create_workspace(...))`. Return no secret fields.
- [ ] Add an exact IPC schema and preload method. The main-process handler requires `assertFocusedMainWindow(event, true)`, `confirm:true`, and a cancel-default native confirmation that displays the canonical target path. Only then call `headlessHost.request("/api/v1/workspaces", input, { localConfirmation: true })`; never expose either host token to the renderer.
- [ ] Re-run the focused headless and Electron tests. Verify a new workspace appears once in `workspaces.list`, with a unique ID and ports, without starting its services.

### Task 3: Verify and extend the existing AO graph without a duplicate store

**Files:**
- Modify: `src-tauri/src/integrations/ao.rs` only for a verified gap
- Modify: `src-tauri/src/data/model.rs:20-33` only if the compatibility check fails
- Test: inline `ao.rs` tests, focused `board_sync.rs` compatibility tests

**Interfaces:**
- Reuses existing `ao::Run`, `ao::Node`, `ao::Route`, `ao::State`, `ao::GraphChange`, `ao::create`, `ao::update_graph`, `ao::reserve`, `ao::cancel`, and `ao::parents_finished`. `AppData.ao_runs` already defaults for old saved data.
- The current `create` takes `(&mut AppData, expected_board_revision, Run)`, `update_graph` takes `(&mut AppData, workspace_id, run_id, expected_revision, GraphChange)`, and `reserve` takes `(&mut AppData, workspace_id, run_id, node_id, expected_revision, request_key)`; do not invent parallel `AoRun` types or functions.
- Task 4 wraps these existing functions in one DataStore transaction per mutation. The existing workflow board remains the task-text owner.

- [ ] Run the existing `ao.rs::graph_checks_scope_cycles_joins_and_stale_revisions` test and old `AppData` deserialization fixture first. They already cover two-parent joins, cycle/foreign-parent rejection, and stale revisions; record the actual result rather than creating duplicate tests.

```rust
let before = serde_json::to_value(&data).unwrap();
let invalid = ao::GraphChange::SetParents {
    node_id: "planner".into(), parents: vec!["reviewer".into()],
};
assert!(ao::update_graph(&mut data, "qa", "run", 1, invalid).is_err());
assert_eq!(serde_json::to_value(&data).unwrap(), before);
```

- [ ] Write one RED test for any uncovered atomic board/run creation case: a failed run validation leaves both `control_board` and `ao_runs` unchanged. Use the existing task IDs and `ao::create`; do not add a second board.
- [ ] Make only that failing transaction atomic through the existing DataStore update path; keep the current graph validation and serde shape.
- [ ] Re-run the focused AO graph and old-data deserialization tests to prove saved Paseo and workflow data remain readable.

### Task 4: Bridge AO reads and revisioned updates

**Files:**
- Modify: `rust-core/coding-tools-headless/src/lib.rs`
- Modify: `desktop-electron/electron/ipc-schema.cjs`
- Modify: `desktop-electron/electron/main.cjs`
- Modify: `desktop-electron/electron/preload.cjs`
- Modify: `desktop-electron/src/api/contracts.ts`
- Test: new focused `desktop-electron/tests/native-ao-bridge.test.cjs` and headless route tests

**Interfaces:**
- Produces `POST /api/v1/ao/read` and `POST /api/v1/ao/update`.
- Produces `codingTools.orchestrator.read({ workspaceId, runId? })` and `update({ workspaceId, runId, expectedRevision, change, confirm })`. Responses contain AO run/board summaries, not credentials or raw model frames.

- [ ] Write RED route/IPC tests: foreign workspace ID, stale revision, missing local-UI token, no confirmation, and renderer-supplied credential fields are refused. Read does not mutate.
- [ ] Run the focused tests and confirm missing API failure.
- [ ] Implement the headless read and update handlers using Task 3's pure functions inside one `DataStore::update_file` call for each mutation. Apply the same local authorization, focus, and exact-schema boundary as Task 2.

```js
return headlessHost.request("/api/v1/ao/update", input, {
  localConfirmation: true,
});
```

- [ ] Expose typed preload methods, then rerun the focused tests. Assert repeated read returns the same revision and never dispatches a model or Paseo call.

### Task 5: Replace the Runtime screen with the durable tree

**Files:**
- Modify: `desktop-electron/src/features/AgentOrchestratorSurface.tsx`
- Modify: `desktop-electron/src/features/agent-orchestrator.css`
- Modify: `desktop-electron/src/App.tsx:16,711-740,852-855`
- Test: new focused `desktop-electron/tests/native-ao-surface.test.cjs`; use the existing renderer test harness pattern in `upstream-surface-reopen.test.cjs`

**Interfaces:**
- Consumes Task 4's `codingTools.orchestrator.read/update` and `workspaces.create`.
- Keeps the existing `surface === "agent-orchestrator"` route. The old Structured and Paseo routes were removed in the reviewed AO-only navigation slice; do not restore them.

- [ ] Write a failing behavior test: two saved runs render separate boards; dropping a queued card onto a branch persists its new parents and position, while keyboard dependency editing produces the same update request. A running card cannot be rewired.
- [ ] Run the new focused test and confirm RED against the current CPA clause board.
- [ ] Render a full-pane top-to-bottom tree with a compact translucent preview control. Keep pending/running/review prominent, finished/held translucent, and cancelled/archived filterable. Save drag and keyboard changes only after the revisioned API acknowledges them; surface conflicts and refresh without replay.

```ts
await window.codingTools.orchestrator.update({
  workspaceId, runId: run.id, expectedRevision: run.revision,
  change: { operation: "set_parents", nodeId: draggedId, parents: [targetId] },
  confirm: true,
});
```

- [ ] Add subtle proximity motion on nearby branches and an equivalent static state under `prefers-reduced-motion`. Keep focus targets, keyboard actions, and narrow-window scrolling usable.
- [ ] Run the focused behavior test and `bun run typecheck`. Inspect the built surface in the installed app at desktop and narrower sizes; no model run is part of this plan.

### Task 6: Preserve old profiles as drafts and verify installed behavior

**Files:**
- Modify: `desktop-electron/src/features/AgentOrchestratorSurface.tsx`
- Test: `desktop-electron/tests/native-ao-surface.test.cjs`
- Evidence: redacted screenshots and receipts under `aiTemp/`

**Interfaces:** `parseLegacyProfiles(raw: string) -> LegacyDraft[]` reads `localStorage["coding-tools-orchestrators-v1"]`, validates ID/name/stages, and offers drafts for import only after the user selects an exact harness/route. It never deletes the old key or dispatches work.

- [ ] Write RED tests for duplicate IDs, malformed stored JSON, and a valid old profile. Each remains non-running; the old localStorage value is unchanged.
- [ ] Add explicit Import and Copy JSON actions. Mark imported profiles incomplete until harness/account/model and permissions are selected.

```ts
const raw = window.localStorage.getItem("coding-tools-orchestrators-v1");
const legacyDrafts = raw === null ? [] : parseLegacyProfiles(raw);
setImportChoices(legacyDrafts);
```
- [ ] Re-run the UI tests, `bun run typecheck`, focused Rust graph/workspace tests, and `git diff --check`. Report the unrelated missing `aiTemp/release-043/native_command_fixture.rs` if the broader Rust lib suite still cannot compile.
- [ ] Compare the staged package to the exact installed archive, back up only replaced non-DEV files, wait for safe idle, and restart only Coding Tools after the required local confirmation. Verify workspace creation, two independent boards, dependency persistence after reopen, profile preservation, and no Paseo navigation. Keep Codex open.

## Plan boundary

This plan delivers a durable editable AO tree with no model dispatch. The separate AO execution plan may start only after this plan's workspace and graph APIs are verified and the exact Web GPT and selected non-Web-GPT harness routes pass their own safe probe. Do not label this board/UI milestone a completed Web GPT to Gemini to review run.
