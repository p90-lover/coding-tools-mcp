# Real Paseo Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task by task. Steps use checkbox syntax.

**Goal:** In installed non-DEV Coding Tools, Web GPT plans and reviews work dispatched to one or more real Gemini-backed Paseo subagents, with their actual outputs collected.

**Architecture:** The Rust ExecutionBook and existing Paseo WebSocket transport own missions, receipts, output provenance, and restart recovery. Electron's five-stack tool adapts to those durable records rather than maintaining a second in-memory executor.

**Tech Stack:** Electron CommonJS, React/TypeScript, Rust/Tauri headless host, Paseo protocol v1, Node/Rust tests.

**Spec:** [2026-09-22-coding-tools-integrated-runtime-design.md](../specs/2026-09-22-coding-tools-integrated-runtime-design.md), section 2.

**Planned interfaces:** `Binding` and `Spec` gain optional nonsecret `account_id` and `route_id`. A durable `OrchestrationRecord` links one workspace/task to planner, worker, and reviewer mission IDs plus stable request keys. `OutputEvidence` contains bounded text, agent ID, turn ID, epoch, and sequence/cursor; the UI's `MissionView.output` exposes that public evidence, never credentials or raw frames.

## Global constraints

- Preserve production-only renderer routes, native Codex/Web GPT models, MCP, unrelated edits, and private credentials. Do not restart Codex.
- No public listener, automatic tool approval, global Codex config change, different-model fallback, or new execution engine.
- Scratch/QA files under aiTemp/, recoverable installed backups under Trash/. No commit, push, publication, external connector creation, or database reset.
- Use Unified Agent Tools and run GitNexus upstream impact before editing symbols; warn on HIGH/CRITICAL risk.
- Existing CPA account/proxy use is in scope; never expose its API key, route secret, or caller URL.
- Foreground GUI QA needs renewed user consent after the earlier Escape; source and loopback checks stay background-only meanwhile.

## Review focus

- Earlier assistant text must not count as the current child output (Task 3).
- Unknown Create/Start receipts must not spawn a duplicate agent (Task 2).
- Wrong account/model/binding must fail, not silently substitute (Task 1).
- Permission wait, child error, empty output, and reviewer error must not complete (Task 4).
- Reopening the GUI must observe without replay (Task 5).

## Task 0: Preflight exact routes and QA workspace

**Files:** Read-only provider/network/runtime state. Save a redacted receipt under aiTemp/.

- [ ] Verify current non-DEV app, CPA, Paseo, and Codex process/socket ownership without launching duplicates or changing window focus.
- [ ] Read current public account/model IDs. Check the selected Web GPT alias and Gemini model against live catalogs.
- [ ] Do not count five-stack's current chatgpt-web -> Router 4202 (or CPA fallback) backend label as Web GPT proof. Verify the actual native Codex bridge route that the Paseo child uses for the selected web model.
- [ ] Send one bounded, tool-free request through the host-private CPA /v1/responses route. Require HTTP 200 and expected text; the prior chat-completions success does not prove Responses compatibility.
- [ ] Register a dedicated aiTemp/ workspace for QA; do not execute in unrelated existing H:/ or F:/ workspaces.
- [ ] If the exact route or Responses check fails, retain its redacted error and stop this route implementation. Do not substitute another model or credential.

## Task 1: Persist exact approved route identity

**Files:** Modify src-tauri/src/integrations/execution/{book,model,service,schema}.rs and desktop-electron/electron/main.cjs; test focused Rust execution-book tests and desktop-electron/tests/execution-bridge-contract.test.cjs.

**Interface:** The approved provider/account/model/route IDs enter Binding and Spec as nonsecret fields. Private launch values are resolved in the host at Create/Resume.

- [ ] Write a failing round-trip test: a Web GPT chatgpt-web/high binding retains its exact account and route IDs, while a same-provider/different-model selection is refused.

```rust
assert_eq!(loaded.binding("qa", "web-main")?.model, "chatgpt-web/high");
assert_eq!(loaded.binding("qa", "web-main")?.account_id.as_deref(), Some("web-account"));
```

- [ ] Run the focused test and confirm it fails for missing persisted identity, not a malformed fixture.
- [ ] Add serde-defaulted nonsecret IDs to Binding/Spec and exact-match selection. Preserve older saved-book deserialization and native Codex routes.

```rust
#[serde(default)]
pub account_id: Option<String>,
#[serde(default)]
pub route_id: Option<String>,
```

- [ ] Resolve the approved route privately for Paseo launch. Use its pinned derived Codex provider for Gemini only after Task 0 proves CPA Responses; never rely on OPENAI_BASE_URL alone.
- [ ] Keep the derived provider's persisted config limited to the CPA loopback base URL and selected Gemini model IDs. The pinned Codex adapter must set model_provider, env_key=OPENAI_API_KEY, and requires_openai_auth=false from a host-private key-presence check for this dedicated provider; the key value remains inherited process environment, never config JSON or renderer output. Test both the child launch route and the absence of key bytes in provider snapshots.
- [ ] Re-run focused Rust/desktop tests. Missing private route fails before Create, and old books still deserialize.

## Task 2: Build a durable mission adapter and reject fake dispatch

**Files:** Modify desktop-electron/electron/{five-stack-control-plane,main}.cjs and, only for missing durable links, src-tauri/src/integrations/execution/{book,service}.rs. Test desktop-electron/tests/five-stack-control-plane.test.cjs and focused Rust book tests.

**Interface:** An internal mission adapter accepts an existing workflow task, exact binding, prompt, and stable key and returns an owned mission ID plus receipt state from execution.read/update. The public paseo_run remains fail-closed until Task 4 connects planner and workers.

- [ ] Write a failing test: without an execution adapter, paseo_run rejects instead of returning awaiting_results; the adapter's returned mission ID must be visible in durable readback.

```js
await assert.rejects(
  () => control.callTool("paseo_run", { planId: planned.id }, { workspaceId: "qa" }),
  /execution service is unavailable/i,
);
```

- [ ] Run RED against the current synthetic run function.
- [ ] Inject the existing headless execution.read/update calls from main.cjs. Validate workspace/task ownership, prepare one real Paseo mission, and issue Create/Start with stable request keys. Keep the public run tool fail-closed until Task 4.

```js
const before = await execution.read({ workspaceId, missionId, refreshSource: false });
await execution.update({
  workspaceId,
  expectedRevision: missionRevision(before, missionId),
  change: { operation: "agent_control", mission_id: missionId, request_key: key, action: "create" },
  confirm: true,
});
```

- [ ] On timeout or unknown receipt, read/reconcile the existing mission; never Create under a new key. Preserve the one-writer-per-workspace admission lock.
- [ ] Run focused tests for cross-workspace ID, duplicate key, unknown receipt, and concurrent writer rejection.

## Task 3: Collect ownership-checked worker output

**Files:** Modify src-tauri/src/integrations/execution/{protocol,transport,service,book}.rs; test focused Rust protocol/transport/book tests.

**Interface:** Consume fetch_agent_timeline_response for an owned agent and recorded Start message ID. Persist bounded selected assistant text plus agent ID, turn ID, epoch, sequence/cursor, and exact route identity; never raw frames.

- [ ] Write a failing timeline test with an older assistant message and a current user_message.clientMessageId. Only an assistant_message in the matching turn may be returned. Wrong agent, gap, reset, stale cursor, and empty assistant text return not-ready.

```rust
let result = collect_owned_reply(&timeline, "agent-1", "start-key-1")?;
assert_eq!(result.text, "CURRENT_WORKER_REPLY");
assert_eq!(result.turn_id, "turn-2");
```

- [ ] Run RED; confirm the error is absent result extraction, not invalid fixture JSON.
- [ ] Reuse Action::Events and validate request/agent identity. Locate the Start user message by the ID that Paseo actually echoes from send_agent_message_request.messageId, then select the owned assistant turn and persist bounded output/provenance.
- [ ] Persist the current Start/Resume request key at mutation reservation time, before network IO. The existing receipt map is sorted by key rather than insertion time, so it cannot identify the latest turn after acknowledgment or restart. Match the pinned timeline's authoritative user message ID field to that key.

```rust
let entries = response["entries"].as_array().ok_or("Timeline entries missing")?;
let sent = entries.iter().find(|e| e["item"]["clientMessageId"] == start_key)
    .ok_or("Current prompt is absent from timeline")?;
let turn = sent["turnId"].as_str().ok_or("Current prompt has no turn ID")?;
```

- [ ] Run focused tests: stale earlier output, wrong agent, gap/reset, repeated read, and missing result must never be reported as completion.

## Task 4: Plan through Web GPT, run workers, then review separately

**Files:** Modify desktop-electron/electron/five-stack-control-plane.cjs and src-tauri/src/integrations/execution/{book,service}.rs for review linkage. Test desktop-electron/tests/five-stack-control-plane.test.cjs and focused Rust review tests.

**Interface:** paseo_plan first runs a Web GPT planner mission and validates its proposed work against the user's scope and selected Gemini worker routes. paseo_run then sends that work to one or more real Gemini children sequentially via Task 2, collects Task 3 outputs, and paseo_review creates a different Web GPT reviewer mission with actual assistant text, verdict, findings, and provenance.

- [ ] Write RED tests: paseo_review rejects missing current child output; a successful review identifies a reviewer agent/turn different from each child; manually entered issues cannot satisfy model review.
- [ ] Write a planner test: only bounded task descriptions from the owned planner turn are accepted; model text cannot choose a credential, provider, account, permission, or workspace outside the user's selected set.

```js
await assert.rejects(
  () => control.callTool("paseo_review", { runId }, { workspaceId: "qa" }),
  /current child output is required/i,
);
```

- [ ] Run RED against the current review function, which only flattens manual issues.
- [ ] Run an actual planner mission through Task 2, parse its Task 3 output, and persist validated assignments. Only then dispatch children sequentially. Prepare/Create/Start the distinct reviewer after all required current child outputs exist; validate findings and preserve its response text.

```js
if (children.some((child) => child.phase !== "review_required" || !child.output?.turnId)) {
  throw new Error("Current child output is required before review");
}
const reviewerKey = [workspaceId, runId, "review"].join("-");
```

- [ ] Restrict anneal_open_from_review to reviewed findings and a real Anneal returned task ID; retain user-authored notes separately.
- [ ] Run focused tests for pending permission, failed child, reviewer error, wrong route, duplicate review, and empty findings.

## Task 5: Render durable progress in the one-window workbench

**Files:** Modify desktop-electron/src/features/PaseoOrchestratorSurface.tsx, execution-surface-utils.ts, orchestration-control.css only where needed, and orchestration-copy.ts. Test desktop-electron/tests/subagent-orchestrator-contract.test.cjs and frontend typecheck.

**Visual thesis:** Keep the current dark, dense Coding Tools utility shell and its existing type, radius, and color vocabulary. **Content:** selected route, planner, Gemini worker rows, collected output, then Web GPT review. **Interaction:** frequent refresh and keyboard actions have no animation; ordinary buttons retain visible press and focus feedback. Use the existing CSS file, not a second styling system.

**Interface:** The UI reads durable orchestration/mission state; it shows planner, each child, permission wait, collected output, reviewer, and verdict. Refresh is observation only.

- [ ] Write a failing UI behavior test: remount from a persisted execution view shows the current child/review state without assignmentRun React state or manual Record Return.

```tsx
const view = await window.codingTools.execution.read({
  workspaceId,
  missionId: null,
  refreshSource: false,
});
setMissions(missionViews(view).filter((mission) => mission.engine === "paseo"));
```

- [ ] Run RED against the current RAM-only inspector.
- [ ] Render exact provider/account/model, real agent IDs, statuses, output, and review; keep explicit Start/Cancel/permission actions and label manual notes as user-authored.
- [ ] Treat execution.read(refreshSource:true) as asynchronous: it returns refresh_requested before the background Inspect/Events receipt is persisted. Re-read on a bounded event/poll path instead of immediately claiming fresh output.

```tsx
{mission.output?.text ? <p className="paseo-collected-output">{mission.output.text}</p> : null}
```

- [ ] Run focused UI/type tests and inspect the built view at the installed app viewport without replacing production-only navigation.

## Task 6: Production proof

**Files:** Redacted receipts/screenshots under aiTemp/ and recoverable installed backups under Trash/; no product edits unless a check identifies a specific defect.

- [ ] Run focused Node/Rust tests, TypeScript check, and git diff --check; report unrelated suite failures separately.
- [ ] Compare a surgical staged ASAR against the exact installed baseline. Wait for idle, then restart only Coding Tools if required.
- [ ] In the registered aiTemp QA workspace, run a harmless read-only task with at least one Gemini subagent; if more than one is selected, verify each distinct agent/model/turn/output in sequence. Then verify a different Web GPT reviewer agent/turn/verdict. Do not auto-approve tool prompts.
- [ ] Reopen Coding Tools; prove observation resumes without duplicate Create/Start. Check native/web model routes, CPA, Paseo UI, owned children, and one harmless MCP read-only call.
- [ ] Record remaining full-goal gaps. Router IPC parity, Anneal original backend/board, CommandCode login, and the separate Fast Access connector workflow still need their own live proof; this slice does not complete the full goal.

## Self-review

- This plan covers the approved spec's Orchestrator section; independent Router, Anneal, CommandCode, and Fast Access work needs separate plans.
- CPA chat completion succeeded previously; Task 0 still requires a real Responses-with-Gemini proof before using Codex as that worker.
- Tasks 2–6 cover unknown receipts, stale timeline data, separate review, GUI reopen, and installed-app proof. No credential/public-access action or placeholder step is authorized.
