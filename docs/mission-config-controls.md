# Mission configuration, controls and accounting

## Configuration
Role and team edits apply automatically to the captured mission. Choices apply immediately; text waits for 350 ms of quiet typing. Existing attempts are stopped and checked before a fresh run replaces them. Original task input and old run receipts remain unchanged. Only quoted visible progress is carried forward, bounded to 8,000 characters; private reasoning is not transferred.

Fields remain editable during saves. Newer drafts survive earlier replies, and changing the selected task does not let an old reply navigate back to it. An unresolved stop is shown as needing attention, not assumed idle.

## Mission rows
The left workspace/chat list stays left. Mission/Overview and schedule/archive/delete actions appear at each row's right edge on hover or keyboard focus, and stay accessible on touch. Delete is logical and recoverable; no task files or receipts are permanently erased. Restore does not replay a cancelled or missed schedule.

Working circles use the inspected Codex animation: 2 seconds, 60 steps. Reduced motion disables rotation. Cancellation, pause and delayed/recovery states take priority over stale running-node facts.

## One-time delayed starts
Choose a positive whole number of seconds, minutes or hours. The deadline is persisted and displayed in local time with a countdown. The app must remain running. The main controller claims an intent once and resolves the latest saved configuration at its deadline.

Missed or uncertain starts after restart require an explicit new schedule/recovery. Editing configuration does not bypass that hold. Cancellation, stop, archive and delete revoke the intent. Reconfiguration of a future task preserves its deadline; pending edits and schedule creation share a task-scoped serial lane.

## CPA accounting
Actual session counters are read only for saved, workspace/project-owned receipt identities. Normalized model totals take priority over latest conversation snapshots; latest-only measurements are labelled partial, not cumulative. Missing counters (including unsupported AGY paths) stay unavailable, and real zero is retained.

CPA estimates apply only to proven CPA gateway routes. Prices come from the managed CPA Helper saved price file with exact unique model identity, never AO/vendor estimates or guessed aliases. Missing cache-write splits, request counts or rates remain partial/unavailable. The board exposes coverage and configured-price freshness; tokens from subscription routes are retained without calling them CPA billing.

## Delivery
This change is pull-request only at Ethan's request. It does not install, patch or restart the running app, merge the PR, publish a release, change prices/credentials or perform paid mission QA. The embedded AO renderer changes are a parent-owned patch applied in isolated build staging; the upstream submodule is not published or repinned.
