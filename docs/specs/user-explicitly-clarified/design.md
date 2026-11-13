# Design: Silent chat continuations

## Data and authorization

Add optional `Run.continuation` with `run_id`, `revision`, typed `source` (`manual`, `goal`, `wake`, `watch`, `loop`, `schedule`) and `message`. Omit absent metadata when serializing legacy runs. Validate identity, nonempty bounded text and control characters. At atomic creation require the current parent in the same workspace/chat and its captured revision; automatic sources cannot resume stopped or paused parents. A manual Continue may follow an explicitly stopped run but does not implicitly resume a paused run.

The grant fingerprint includes continuation metadata only when present, preserving legacy grant hashes. Prompt reconstruction retains the user conversation and clearly identifies appended controller instructions as neither a new user message nor a permission grant. Live-session continuation uses the same distinction without rewriting the task record.

## Dispatch

The strict headless `create_from_team` request forwards optional metadata through selected single/team run construction. Desktop `chat_continue` captures the displayed run, shares existing per-chat admission and uses the saved route. It is registered as mutating in the app handler. Public `chat_send` cannot select an internal continuation source.

Goal, Wake, watch, loop and schedule dispatchers use an internal continuation helper. Existing wait, latest-parent, cancellation, Goal revision, one-shot watch and uncertain-outcome rules remain in place. Skipping task-description writes also avoids unnecessary record rollover for generated rounds.

## Renderer and ownership

Continue uses the dedicated action and retains busy, selection and workspace guards. Refusals and pending-input notices remain visible. Continuation answers render normally, but do not advance user-message pairing. Descendant traversal follows continuation, restart and replacement links for deletion and rewind. Preserve the existing compacted-history and pending-message alignment rules.

## Scope and verification

Nine production files cover run/prompt/grant validation, selected-run construction, the strict API, workflow, handler registration and four renderer modules. Add focused Node and Rust regression cases; update existing automatic-trigger assertions to inspect controller metadata rather than generated task-description text. Verify the actual Continue control and history helpers in the chat Preview using synthetic data. Required native compilation and integration gates remain mandatory; a fixture or syntax check is not proof they passed.

This is a high shared-contract-risk change. Missing code-graph results are UNKNOWN, not evidence of no callers; inspect consumers manually and disclose unavailable graph verification rather than reporting a clean zero.
