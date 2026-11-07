# Requirements: command-watch-continuation

## 功能概述

The user observes chats that promise a later action, report a watch is active, then end without continuing. Add real command watches and completion-triggered continuation, not a new name for a timer or a natural-language promise.

## Scope

In scope: known per-chat commands; bounded watch/list/cancel tools; existing exec_command/write_stdin wait behavior; completion delivery to the owning chat; discoverability across supported MCP harnesses.
Out of scope: arbitrary process discovery, automatic worker-command replay, unrestricted browser/network access, bypassing approvals, installing/restarting the user's app, app/OS-restart-surviving processes, or interpreting every future-tense sentence as authorization to start a new turn.

## 需求列表

| ID | Requirement | Owner |
| --- | --- | --- |
| FR-1 | Expose watch_command, list_command_watches and cancel_command_watch to supported chat harnesses when terminal tools and continuation service are enabled. | terminal-watch |
| FR-2 | Observe only owned handles, with finite deadlines, bounded metadata/output, deduplication and no process launch, stdin write or kill. | terminal-watch |
| FR-3 | Distinguish completion, failure, expiry, cancellation and delivery state; preserve usable synchronous empty-write_stdin polling. | terminal-watch |
| FR-4 | A completed or expired registered watch starts a real follow-up after the current turn settles, using the same model/account/permission route. | continuation |
| FR-5 | Stop, cancellation, disposal, a newer user turn and removed/archived chats invalidate stale continuation; concurrent completion is not a duplicate command or turn. | continuation |
| FR-6 | Registration returns verifiable identity/status. Agent guidance must not claim a future check without a successful watch/wakeup; ordinary timed wake-ups remain distinct. | continuation |

## 非功能需求

Keep watch state and command output in memory, not request/output logs. No system-drive storage. Bound the number of watches and observation rate. Treat terminal output as untrusted data. Report uncertain outcomes rather than replay a side effect. Existing consent and command ownership remain mandatory.

## 依赖关系

Dependencies are defined in spec-manifest.json.
