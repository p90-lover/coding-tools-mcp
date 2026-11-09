# Annotation messages stay together

## Observed gap and boundary

Expected: one send carries the typed message, selections, optional comments and files; the transcript shows one message with a Codex-style annotation attachment. Actual: the screenshot shows the first 400 characters of the annotation prompt as a separate bubble, followed by the full optimistic message and its annotation chip.

The composer already calls `chatMessageWithAnnotations` once and delivers that complete string. AO preserves the steer text. The Electron workflow's `publicTimeline` treats `steer` as a tool/status label and truncates it to 400 characters. The renderer cannot parse that incomplete annotation block or match it against the complete pending steer. `fitTimeline` can also split the block under response-size pressure.

## Root-cause worksheet

- H1 (code/data contract), confirmed: workflow timeline truncation. `publicTimeline` gives only message/reasoning kinds the 64 KiB text budget. A reproduction with an annotated steer produces exactly the screenshot's cutoff (`:co`).
- H2 (agent behavior), ruled out: the model split the request. The split is produced before rendering by the workflow's deterministic formatter; no model request is required to reproduce it.
- H3 (composer), ruled out: annotations and typed text are sent separately. `submit` creates one string with annotations, attachment lines and typed text, then calls `deliver` once; existing serializer round-trip tests confirm the combined payload.
- H4 (UI), confirmed contributing factor: sent annotations use a square 24 px native-tooltip label instead of Codex's rounded attachment pill and structured details. The local Codex snapshot uses rounded-full, 14 px text, 6 px vertical/8 px horizontal padding, a 384 px popover, numbered selections and separate Selected text/User comment labels.

Why chain:
1. The transcript shows raw instructions because the annotation block is incomplete and cannot be parsed.
2. The block is incomplete because `publicTimeline` cuts steer text at 400 characters, before the JSON and typed message.
3. That cutoff applies because steer messages were grouped with short tool/status labels, not full user messages. Pending-steer deduplication uses complete text, so the truncated record and full optimistic message do not match.

Success/failure fork: the serializer's full output round-trips correctly; the same output after workflow formatting does not. Confidence: high for the deterministic source-level reproduction. Evidence gap: the original production session was not opened or modified; the screenshot and its exact cutoff are the production evidence.

## Acceptance and minimal repair

1. Live and saved workflow timelines preserve a complete annotated steer, including multiline/Unicode selections, comments, typed message and files.
2. Timeline size reduction preserves steer messages atomically; tool previews remain bounded and existing secret redaction still applies.
3. Composer submission invokes send/steer once with the combined payload.
4. Sent and draft annotations share Codex's pill/details styling, support keyboard access, and saving a comment never submits the composer.
5. Run targeted regression tests, surrounding chat/workflow tests, TypeScript checking, and browser preview if the chat's preview tools are available.

Graph preflight: upstream impact was attempted for publicTimeline, fitTimeline, SentMessage, SentAnnotations, SelectionAnnotator, AnnotationTray and chatAnnotationsSplit in G:/Projects/coding-tools-mcp. The index is from 2026-10-01 (1460 commits behind); these symbols return UNKNOWN/not found. No reliable graph caller/process conclusion is claimed. Source checks identify publicTimeline callers as activity, turn_timeline and subagent timeline; SentAnnotations is called by SentMessage, and AnnotationTray by the composer. The repair stays within those existing contracts. No full reindex is performed (large shared HDD index).

## Verification

- Before the fix, all four initial workflow regressions failed; actual text ended at exactly `:co`, matching the screenshot.
- After the fix, 156 focused tests pass across annotation-message, chat-annotations-layout, codex-chat-view and ao-chat. Coverage includes live/saved steers, structured payloads under timeline size pressure, Unicode selections, files, redaction, exactly one composer send/steer, sent details, Enter-save isolation, and stable edit identity across reordered annotations/chat changes.
- 419 surrounding tests pass across agent-orchestrator-workflow, agent-orchestrator-upstream and ao-chat-ui.
- Renderer TypeScript checking passes after the final stable-ID safeguard. `git diff --check` passes.
- Renderer production build succeeds (535 modules); warnings remain for the parent `$app/tsconfig` resolution and large chunks. Output was generated only under desktop-electron/aiTemp/annotation-build and removed after verification.
- Browser visual verification remains unavailable: the chat's preview tools disconnected during the session. The styling was ported from the local Codex reference bundle and tested structurally; no pixel-parity claim is made.
- No install, app patch/restart, commit or push was performed. Existing unrelated shared-workspace edits were preserved.

Regression candidate: structured user messages must remain atomic through every timeline projection and response-budget reduction. A tool/status preview limit is not a safe bound for a user steer carrying machine-readable attachment metadata. The tests above lock the live, saved and response-pressure boundaries; this task adds no persistent global memory.
