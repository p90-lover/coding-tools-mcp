# A chat's record can always take the next message

A send was refused with "This chat's task record is full and couldn't be rolled over: The next message leaves no room for a summary. Shorten it or start a new chat." (2026-11-08). The user asked for the bug fixed and for a plan that keeps it from coming back.

## Why it happened

A chat's own messages live in its board task's description. That description is capped at 8,192 UTF-8 bytes, and each follow-up is appended under a `Follow-up (… UTC)` marker. When the next message didn't fit, the record "rolled over": a model summarized what came before, and the message went under that summary. Six ways led to a refused send, or to a goal that stalled because its round couldn't be sent:

| # | Case | Old result |
|---|------|------------|
| 1 | A message of about 7.6–8.2 KB passed the 8,192-byte message check, but left under 512 bytes for a summary | "no room for a summary" |
| 2 | No CPA model answered the summary request | "couldn't be rolled over" |
| 3 | A record under 800 characters plus a long message: the rollover was skipped | "full even after rollover" |
| 4 | A steer note was written between the rollover's read and its write | "The chat changed while compacting" |
| 5 | The composer counted characters while the bridge counted bytes, so Chinese text and emoji passed the composer | refused after leaving the composer |
| 6 | A goal round's message, counted in characters, could be up to about 10 KB in bytes | the goal stalled |

## The invariants that prevent it

1. **One message budget, in bytes: `CHAT_MESSAGE_BYTES` = 8,192 − 256 = 7,936.**
   - The bridge (`agent-orchestrator-workflow.cjs`) checks it before anything is written, for sends and for steers.
   - The composer (`ao-chat.ts` `chatMessageFits`) checks the same number and keeps the draft, with a "Too long" card that says what to do.
   - Queued messages only join while the joined text fits.
   - The 256 bytes kept free hold the message's marker and a rolled-over record's head, so any message within the budget fits a rolled-over record.
2. **A rollover cannot fail** (`compactChat`):
   - A model's summary is used when there are at least 512 bytes for one and a model answers.
   - Otherwise the newest part of the record that fits is kept, under the same `Summary of the earlier conversation` head.
   - Markers in the kept text are renamed (`[Message, … UTC]`, `[Steer, … UTC]`, `[Earlier summary, … UTC]`), so the chat still reads it as a single summary. Every renamed form is shorter than the marker it replaces.
   - A change that lands mid-rollover is read again, up to three times.
   - A rewind that no longer fits rolls the messages it keeps over the same way.
3. **Goal rounds stay within the budget** (`chat-goals.cjs`):
   - A condition is at most 6,000 bytes as well as 2,000 characters.
   - A round's message gives up the evaluator's reason first, then the end of the condition, so it never exceeds 7,936 bytes, even for goals saved before this change.

## Tests that hold them

- **Property test** (`agent-orchestrator-workflow.test.cjs`, "every message within the budget fits every record"):
  - 5 record shapes: short, full, Chinese, marker-dense, already summarized.
  - × 3 summarizers: answers, fails, over-long.
  - × 3 scripts: Latin, Chinese, emoji.
  - × 7 message sizes, up to exactly 7,936 bytes.
  - Every send must succeed, the record must stay within 8,192 bytes, and the message must be whole and last. One byte over the budget is refused before anything is written.
- **Budget test:** the composer, the goal rounds and the bridge use the same budget, and the head plus the marker fit in the 256 bytes kept free. A change to any one of them fails it.
- **Per-case tests:** cases 1–5 each have their own test. Case 6 is covered by the budget test, which builds goal rounds from 2,000-character conditions and 1,500-character reasons in each script.
