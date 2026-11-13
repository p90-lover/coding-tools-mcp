# Requirements: Silent chat continuations

## Goal

Continue, later Goal rounds, Wake, command watches, loops and schedules continue the existing chat without appending generated user messages. Messages explicitly typed by the person keep the existing send path. Contentless recovery remains separate from starting another turn.

## FR-1: Internal follow-ups

- Generated triggers create a linked continuation, not a follow-up or steer note in the task description.
- Continue invokes the dedicated continuation action, not composer delivery of `Continue.`.
- Explicit scheduled text still reaches the agent through bounded controller context.
- Ordinary sends, queued user messages and the first explicitly submitted Goal message remain ordinary user messages.

## FR-2: Durable context and history

- Persist the exact parent run, parent revision, source and bounded controller instruction on the new run.
- Include controller context when reconstructing prompts; do not silently truncate the original request.
- Continuations do not consume a user-message index or create synthetic user bubbles.
- Deletion and rewind follow continuation descendants alongside restarts and replacements.

## FR-3: Safety and concurrency

- Automatic triggers refuse stale, stopped, paused or unavailable parents.
- Preserve per-chat serialized admission, newer-message precedence, cancellation and existing controller guards.
- A working turn or pending approval is not permission to start duplicate inference.
- Controller instructions are not a new user permission grant; bind them into the existing grant fingerprint.
- Never replay an operation solely because its output or final outcome is unknown.

## Compatibility and limits

Old runs omit continuation metadata and keep their previous serialized form and grant scope. New metadata follows the message byte and control-character limits. No new polling loop, provider routing changes, installed-app changes, or historical transcript rewrites are in scope.
