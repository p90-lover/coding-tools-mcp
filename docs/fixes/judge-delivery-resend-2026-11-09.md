# "Let the model judge" cards that never closed

## Symptom

With "Approve for me" and "Let the model judge" both on, a chat's request card stayed open with Allow once / Allow this conversation / Deny and the reviewer line "The reviewer's answer delivery outcome is unknown. Check this request before answering; it was not automatically replayed." (user screenshot, 2026-11-09, a DeepSeek V4.1 Flash chat's `netstat` command). The judge was on, yet the request waited for the person indefinitely.

## Cause

`screenOne` runs inside one 45-second review budget (`withinReview`) that covers the model review *and* the answer's delivery to AO. A reviewer that spends most of the budget thinking leaves its send to be cut off by the watchdog. The catch then stored `{ action: "ask", unsent }`, and the auto-review watchdog fix of 2026-11-06 deliberately never resent it, in any mode. `rescreen` excluded `unsent` advice, so no later pass looked at the request, and `approvalNeedsPerson` showed it to the person. A send AO refused outright (`resolveApproval` rejected) took the same path.

## Fix

In judge mode only, an answer that may not have reached AO is reconciled against AO itself:

- An answer that landed takes the request off AO's pending list within `ANSWER_DELIVERY_MS` (60 s). One AO still lists after that never arrived, so the same decision is sent again. It is never reviewed again, so a resend cannot carry a different verdict.
- AO refuses a decision for a request that is no longer pending (`ports.ErrChatRequestNotPending` in every chat driver), so a resend cannot answer a request twice.
- A send AO refused outright is retried after `REVIEW_RETRY_MS`.
- At most `DELIVERY_TRIES` (3) sends. After that the card goes to the person with "Sent 3 times without reaching the agent".
- While a resend is pending, the card shows the request as being reviewed (`awaiting_review`), not Allow/Deny.
- Turning the judge on after the cut-off picks up the stored answer the same way. Turning it off leaves the answer with the person: `screenOne` returns early, rather than re-reviewing a request that may already have an answer.

Without the judge, the 2026-11-06 contract is unchanged: an uncertain delivery is the person's and is not replayed.

## Verification

`tests/auto-review-watchdog.test.cjs` covers: normal mode never resends, even after the window; judge on (from the start, or enabled after the timeout) resends once AO still lists the request, the card closes, and no second model call is made; a delivery that never lands is sent 3 times and then goes to the person; and a refused send is retried with the same decision. The four judge cases fail on the previous code.
