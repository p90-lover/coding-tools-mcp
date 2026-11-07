# Command watches must actually continue the chat

## Symptom

The user shows a chat saying a 30-minute watch is active and promising to verify release results next, while its card is Done and never continues. A future-tense answer is not a registered task. No read-only AO listener was available during this diagnosis, so the screenshot's exact session/tool history was not proven and no live database was opened.

## Confirmed gap and implementation

The app had exec_command/read_output/write_stdin and a separate schedule_wakeup timer, but no command-completion watch tied to a next chat turn. write_stdin's description also advertised typing, not its empty-input wait operation.

- watch_command registers one bounded, known-handle observation and a workflow-owned completion ticket. It returns a verifiable watch_id/status immediately.
- list_command_watches exposes this chat's observation/delivery states; cancel_command_watch cancels observation and a pending follow-up, not the command.
- Sandbox snapshots or rooted, empty-input headless reads observe state every five seconds, outside model inference. A separate deadline survives a hung observation. No process, input or command is replayed.
- Completion, observation failure or watch expiry queues an actual follow-up through the serialized chatSend path after the parent settles. The same Single model/account/permission route is preserved.
- Stop, cancellation, disposal, missing/archived chats and newer unrelated turns invalidate stale delivery. The send path rechecks its expected parent and stopped/paused state. Multiple watch completions follow the lineage of their own automatic turns rather than starting simultaneously.
- Unknown send outcomes are not resent. Expired/failed watches can be explicitly rearmed on the same still-running handle. Late timer callbacks cannot cancel an outcome already queued for delivery.
- Repeating an unfinished watch replaces it under the current turn, keeping one active observer for the handle. Reusing an already-ended watch returns its outcome and explicitly says no new follow-up was registered, rather than falsely telling the model to end and wait again.
- Model guidance distinguishes real tool registration from promises: do ready work before a final answer; never claim a future continuation unless a watch/wakeup succeeded.

## Example

1. Start a finite foreground watcher with exec_command, for example `gh run watch 123 --exit-status --interval 60`, using a short yield_time_ms.
2. Call watch_command with its returned command_id and a reason such as `Verify the exact CI result and carry out the remaining authorized work`.
3. Check the returned watch_id and status, then end the turn. The app performs observation and sends a follow-up when the watch ends; the model does not need to poll.

A watch deadline is not proof the command finished, and does not kill it. The follow-up must read output and verify the actual result. Watches are in-memory and do not survive loss of the app runtime or OS; persisted time-based schedule_wakeup remains a separate fallback. Terminal tools must be enabled. These tools are offered through the supported Codex, Claude Code and OpenCode MCP harnesses, not preview-only or subagent leases.

## Reference and verification boundary

Public Codex commit `2f742f58856618deaaa86fa7f7048aad57c972a9` has exec_command/write_stdin and a process-exit event watcher. That source alone does not prove a final answer automatically resumes. This patch preserves the command/wait lifecycle and implements the app's explicit event-to-turn bridge; it does not invent a native Codex tool named watch.

Sources:
- https://github.com/openai/codex/blob/2f742f58856618deaaa86fa7f7048aad57c972a9/codex-rs/core/src/unified_exec/async_watcher.rs
- https://github.com/openai/codex/blob/2f742f58856618deaaa86fa7f7048aad57c972a9/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs

Final verification: **854/854 tests passed**, with no skips, across thirteen adjacent suites using normal per-file process isolation and concurrency one. This includes **25 watch/tool tests** and **13 focused continuation tests**. All thirteen backend-bundle checks and the real Windows owned-parent/descendant timeout smoke test pass. Initial failures exposed missing sparse-checkout vendor fixtures and load/isolation-sensitive legacy smoke/discovery checks; the pinned manifests were restored without product changes, and the full final isolated run passed. Runtime syntax and whitespace checks pass.

Five selected regressions fail against released 0.8.95: three harnesses lack the watch capability/guidance and the workflow lacks command-completion registration. Focused new tests cover real MCP calls, headless/sandbox observation, renewal, rearming, bounded expiry, cancellation and actual accepted follow-up creation. Tests also reproduced and fixed cross-chat pending quotas, cancellation during registration, coincident deadline callbacks and final pre-send Stop/pause checks. No live model/account/approval mutation, install or restart was used.
