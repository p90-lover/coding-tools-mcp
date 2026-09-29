# Coding Tools Orchestrated Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Settings button creates a durable, reviewable Coding Tools repair task using Web GPT as planner/reviewer and the selected Gemini 3.8 Flash route as worker; changes require confirmation.

**Architecture:** Extend the existing five-stack tool facade and ExecutionBook orchestration record; do not add an executor. A bounded diagnostic collector supplies allowlisted facts to the planner. Settings opens the existing Paseo task board on the durable repair record; the existing mission/permission/receipt path owns work, and activation remains a separate confirmed step.

**Tech Stack:** Electron CommonJS, React/TypeScript, Rust ExecutionBook, Node tests, installed non-DEV Coding Tools.

**Spec:** [2026-09-23-coding-tools-orchestrated-repair-design.md](../specs/2026-09-23-coding-tools-orchestrated-repair-design.md).

## Global Constraints

- First complete and live-verify [real Paseo orchestration](2026-09-23-real-paseo-orchestration.md): durable `OrchestrationRecord`, owned Gemini output, separate Web GPT review, and GUI reload without replay. This plan consumes those results; it must not fabricate them.
- Use exact selected `chatgpt-web/high` account and CPA `gemini-3.8-flash-high` account for the first proof. No provider/model/account fallback or credential copied into task data.
- Keep Codex open. No automatic tool approval, public listener, new execution engine, profile reset, auto-install, or restart while a bridge turn is active.
- Preserve dirty user edits and production-only UI. No new Git worktree, commit, push, publication, or external connector. Scratch belongs under `aiTemp/`; backups under `Trash/`.
- Use Unified Agent Tools for repository reads/commands, GitNexus upstream impact before edited symbols, and a focused RED→GREEN check for each behavior.

## Review Focus

- Repeated click during an uncertain Create must reopen the same repair task, never create a second task (Task 2).
- A doctor message, raw log, URL query, or provider label containing a secret must not reach the repair prompt or durable record (Task 1).
- A catalog-only Web GPT or Gemini route must not count as an authenticated inference route (Task 2).
- A denied tool permission, failed worker, missing owned output, or manual note must not unlock approval or claim verified repair (Task 3).
- GUI reload or Coding Tools restart must observe the existing record, not resubmit an edit or restart Codex (Task 4).

## Task 1: Bounded repair evidence

**Files:** Create `desktop-electron/electron/repair-diagnostics.cjs`; test `desktop-electron/tests/repair-diagnostics.test.cjs`. Reuse Run Doctor and five-stack snapshot in `desktop-electron/electron/main.cjs`.

**Interfaces:** Produce `repairFacts({ doctor, services, bridge, workspaceId })` returning only `{ kind, workspaceId, revision, checks, modules, bridge }`. `checks` contain allowlisted `{id,status}`; `modules` contain `{id,installState,running}`; `bridge` contains booleans/counts. `revision` is SHA-256 of those canonical allowlisted facts, not a raw-log revision. No free-form message, arbitrary path, URL, account identity, or secret enters the result.

- [ ] Write a test with a doctor message containing `Bearer secret`, a signed URL, and a module error containing a password; assert `JSON.stringify(repairFacts(input))` contains none of those bytes and retains check IDs/states.
- [ ] Run `node --test desktop-electron/tests/repair-diagnostics.test.cjs`. Expected: RED because `repairFacts` is absent.
- [ ] Implement the exported function with fixed field selection, caps of 32 checks and 16 modules, and status enums (`ok|warning|error` and `installed|not-installed|repair-required|error`). Do not use generic recursive serialization of runtime objects.

```js
const facts = { kind: "coding_tools_repair", workspaceId, checks, modules, bridge: bridgeFlags };
return { ...facts, revision: sha256(JSON.stringify(facts)) };
```

- [ ] Run the focused test. Expected: PASS; malformed rows are skipped, never copied raw.

## Task 2: Idempotent repair task creation

**Files:** Modify `desktop-electron/electron/five-stack-control-plane.cjs` and `desktop-electron/electron/main.cjs`; test `desktop-electron/tests/five-stack-control-plane.test.cjs`. Extend the durable `OrchestrationRecord` from the prerequisite plan only if it lacks a nonsecret repair kind and diagnostic facts reference.

**Interfaces:** Add `coding_tools_repair_start` to the existing tool facade. Input is `{}` plus the authenticated workspace context; output is `{ repairId, planId, status }`. The host injects `getRepairFacts(workspaceId): Promise<facts>`, `executionRead({workspaceId,missionId,refreshSource}): Promise<view>`, `executionUpdate({workspaceId,expectedRevision,change,confirm}): Promise<view>`, and `workflowUpdate({workspaceId,expectedRevision,change}): Promise<view>`. Implement local `createRepairPlan({workspaceId,facts,key})` using those existing host operations. First look up any unfinished repair for this workspace and return it. Only for a new task, use stable key `workspaceId + ':coding-tools-repair:' + facts.revision`, persisted before external Create.

- [ ] Write a test invoking `coding_tools_repair_start` twice, including after diagnostic revision changes while the first repair remains active. Assert the same `repairId` returns, only one workflow task and one Web GPT planning Create receipt exist, and a different workspace is refused.
- [ ] Run `node --test desktop-electron/tests/five-stack-control-plane.test.cjs`. Expected: RED, unknown tool.
- [ ] Add the allowlisted tool and host injections. Read a current durable record before mutation; if its Create receipt is reserved/unknown, return the same repair ID and require observation. Require the exact connected Web GPT account/model and exact Gemini account/model before Create. Store only Task 1 facts, not raw doctor output.

```js
const view = await executionRead({ workspaceId, missionId: null, refreshSource: false });
const existing = (view.orchestrations || []).find((row) => row.kind === "coding_tools_repair" && !["verified", "failed", "cancelled"].includes(row.status));
if (existing) return { repairId: existing.id, planId: existing.planId, status: existing.status };
const facts = await getRepairFacts(workspaceId);
const key = `${workspaceId}:coding-tools-repair:${facts.revision}`;
return await createRepairPlan({ workspaceId, facts, key });
```

- [ ] Run the focused test. Expected: PASS; missing route returns a connection requirement and zero Create calls.

## Task 3: Proposal, confirmation, and honest result gates

**Files:** Modify `desktop-electron/electron/five-stack-control-plane.cjs` and `desktop-electron/tests/five-stack-control-plane.test.cjs`; reuse the prerequisite plan's owned-output and review records.

**Interfaces:** Add `coding_tools_repair_approve({ repairId, scopeHash })`; `scopeHash` is SHA-256 of the sorted, workspace-relative proposed file paths and operation names shown in the confirmation dialog. Require a completed distinct Web GPT review of actual Gemini read-only findings, an exact approved file scope, and a current workspace/record revision. The approval unlocks an existing Paseo worker mission; it does not approve individual Codex tool calls or installation.

- [ ] Write RED cases for missing worker turn, denied permission, failed reviewer, manual finding, stale scope hash, and duplicate approval. Each must leave repair state unapproved and avoid dispatch. Add a success case with distinct planner/worker/reviewer turn IDs.
- [ ] Run the focused control-plane test. Expected: RED because approval tool is absent.
- [ ] Implement the approval check against the durable record and use the existing stable-key Create/Start path. Preserve unknown receipts and idempotent re-entry. After edits, attach the actual diff/test receipt for a second Web GPT review; only that review plus focused tests can mark `verified`.

```js
if (record.scopeHash !== input.scopeHash || !record.review?.ownedTurnId || !record.worker?.ownedTurnId) {
  throw new Error("Current reviewed scope and owned model output are required");
}
const current = await executionRead({ workspaceId: record.workspaceId, missionId: record.worker.missionId, refreshSource: false });
const mission = (current.missions || []).find((row) => row.mission?.spec?.mission_id === record.worker.missionId);
if (!Number.isInteger(mission?.mission?.revision)) throw new Error("Current worker revision is unavailable");
return executionUpdate({
  workspaceId: record.workspaceId,
  expectedRevision: mission.mission.revision,
  change: { operation: "agent_control", mission_id: record.worker.missionId, request_key: record.approvalKey, action: "start" },
  confirm: true,
});
```

- [ ] Run the focused test. Expected: PASS; an empty or user-authored note cannot substitute for a model turn.

## Task 4: Settings entry and durable board

**Files:** Modify `desktop-electron/src/App.tsx`, `desktop-electron/src/features/PaseoOrchestratorSurface.tsx`, `desktop-electron/src/i18n.ts`, and existing `desktop-electron/src/features/orchestration-control.css` only if needed. Test focused React state/view code with `desktop-electron/tests/subagent-orchestrator-contract.test.cjs`; run `bun run typecheck` in `desktop-electron`.

**Interfaces:** Settings calls `window.codingTools.tools.call({workspaceId,tool:'coding_tools_repair_start',arguments:{}})`, stores returned `repairId` in the existing shell state, then `navigateSurface('paseo')`. `PaseoOrchestratorSurface` accepts `initialRepairId?: string` and reads the durable repair record on mount; no RAM-only completion state.

- [ ] Add a failing view test: a remounted surface given a durable `repairId` shows pending/worker/review/approval states without repeating `coding_tools_repair_start`. Add a disabled-button test when no Coding Tools workspace is selected.
- [ ] Run the focused view test. Expected: RED on missing repair entry/record rendering.
- [ ] Add the Settings button beside Run Doctor, a compact state card in the existing Paseo board, and explicit Approve/Cancel controls. Keep all app visuals in the current window; no extra UI system or auto-focus. Use current locale keys for English, Chinese, and Japanese.

```tsx
const repair = await window.codingTools.tools.call({ workspaceId, tool: "coding_tools_repair_start", arguments: {} });
setRepairTaskId(String(repair.repairId));
navigateSurface("paseo");
```

- [ ] Run focused tests and `bun run typecheck` in `desktop-electron`. Expected: PASS and zero TypeScript errors.

## Task 5: Activation and production proof

**Files:** Use generated QA receipts under `aiTemp/` and exact installed backups under `Trash/`. Change product code only for a reproduced defect.

- [ ] In the dedicated registered `aiTemp` QA workspace from the prerequisite Orchestrator plan, run one harmless read-only repair diagnosis. Require distinct Web GPT planner and reviewer agent/turns and actual Gemini 3.8 Flash worker output in the durable record; a catalog or health result is insufficient.
- [ ] Verify no file or installed hash changed before approval. Confirm one bounded source edit, run its focused tests, and verify the reviewer receives the real diff/test receipt. Do not approve a tool prompt automatically.
- [ ] If installation is separately approved, compare staged and installed package entries, wait for zero active bridge turns, back up the current non-DEV package, restart only Coding Tools, and run the original symptom plus native/Web GPT/MCP checks. Do not restart Codex.
- [ ] Close/reopen the GUI and verify the repair record appears without another Create/Start. Report Anneal and computer/vision outcomes separately; never roll their failures into a green repair result.

## Self-review

This plan adds the Repair button only after the real Orchestrator plan provides durable mission ownership. Task 1 limits sensitive diagnostic input; Task 2 pins route and idempotency; Task 3 owns confirmation; Task 4 owns the one-window UI; Task 5 requires installed-app proof. No task silently installs Anneal or grants computer control.
