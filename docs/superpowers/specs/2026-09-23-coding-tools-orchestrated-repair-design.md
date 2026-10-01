# Coding Tools orchestrated repair

Status: written design for user review, September 23, 2026. The user approved the in-chat design direction: diagnose and propose first; confirm changes. This document does not authorize unattended edits, tool approvals, installs, or restarts.

## Outcome

Add a **Repair Coding Tools** button beside Run Doctor in the installed non-DEV Settings screen. One click creates a durable, visible repair task. ChatGPT Web plans and reviews; the selected CPA-backed Gemini 3.8 Flash worker investigates and, only after approval, applies a bounded source fix. The task board shows pending, running, review, awaiting approval, applying, verified, failed, held, and cancelled states. Reopening Coding Tools resumes observation without replaying work.

This repairs Coding Tools itself, including its bridge and managed modules, without creating another execution engine or extra app window. It must not hide a failed prerequisite behind a healthy catalog or substitute another account/model.

## Existing pieces to reuse

- Settings already has Run Doctor, its report UI, and per-module repair controls. The new button starts a repair task; it does not replace those controls.
- The five-stack control plane and Rust ExecutionBook own Orchestrator missions, revisions, request keys, receipts, and restart recovery. The same records back the Repair task board.
- The local provider store already supports a verified `chatgpt-web` native-browser account. CPA exposes the selected Gemini 3.8 Flash route as `gemini-3.8-flash-high`; a tool-free Responses request to that exact route returned HTTP 200 and expected text. That is not Paseo dispatch proof.
- Existing tool policy, workspace ownership, focused-window consent, and explicit permission requests remain authoritative. A catalog entry for computer or vision is not an approval or an end-to-end test.

## Flow and trust boundaries

1. On click, collect Run Doctor, five-stack/module state, selected workspace, bridge status, and bounded recent error categories. Redact credentials, cookies, control tokens, URLs containing secrets, and unrelated project data before creating the task. Do not transmit raw logs to a model.
2. Validate that the chosen workspace and exact Web GPT and Gemini accounts/models are connected. If browser authentication, the CPA route, or Paseo is unavailable, show the specific requirement and do not dispatch or fall back.
3. Create a durable repair task and Web GPT planning mission. The plan may choose checks and source files inside the approved Coding Tools checkout, but cannot choose credentials, provider routes, permissions, or a different workspace. A Gemini worker performs read-only investigation; Web GPT runs a distinct review mission over the worker's actual owned output.
4. Show the proposal, affected files, tests, risks, and confidence in the task board. Until the user confirms that scope, no source file, installed runtime, configuration, or credential is changed. Manual notes cannot satisfy model review.
5. After confirmation, dispatch the approved Gemini edit task using existing Codex/Paseo tools and their normal permission prompts. Preserve dirty user changes. A separate Web GPT review checks the real diff and test evidence. If tests or review fail, retain the task and artifacts as failed/held; never claim verified repair.
6. If activation is needed, show the exact installed targets and backup plan and request a separate confirmation. Back up the current non-DEV installation, wait for active bridge turns to drain, restart only Coding Tools, and run a live symptom check. Keep Codex open. On failure, offer a recoverable rollback; never silently reset the profile.

## UI and data

The Settings button opens the Orchestrator task board on its new repair task. A compact summary shows diagnostics, planner, each worker, current receipt/permission state, worker output, reviewer verdict, pending confirmation, and verification result. Cancel stops new dispatch; it does not pretend an already transmitted external action was undone. Repeated clicks reopen the same active repair task unless the user explicitly starts a new one.

Only bounded nonsecret IDs, route labels, statuses, sanitized output, and evidence links enter persistent task records. Private CPA keys, ChatGPT cookies, proxy credentials, and Codex control tokens remain in their existing local stores. Computer control and screen capture remain separately paired and permission-gated; the repair workflow must work without them and report their unavailability honestly.

## Acceptance evidence

- A missing Web GPT/Gemini route refuses repair before Create; no fallback or duplicate task appears.
- One harmless task shows Web GPT planner output, a distinct Gemini 3.8 Flash agent/turn/output, and a distinct Web GPT reviewer/turn/verdict in the durable board.
- Denied permission, child failure, missing output, review failure, and repeated click/reopen cannot fabricate completion or replay Create/Start.
- Before approval, source and installed hashes are unchanged. After approved edits, focused tests pass and the reviewer sees the actual diff. Activation uses a backup and waits for idle; the original symptom is tested in the non-DEV app.
- The Anneal task panel, MCP, native/Web GPT model routes, and computer/vision tools are tested separately; failures remain explicit rather than being counted as a successful app repair.

## Current gates

The installed app still needs its staged browser-helper cleanup fix activated after active HTTP turns drain. Anneal is not installed in WSL2 mode and its `projects` call fails. Coding Tools currently reports computer control as separately paired, and read-only computer/vision calls from a hidden window hit the focused-window consent gate. Those are tasks to diagnose, not permissions to bypass.
