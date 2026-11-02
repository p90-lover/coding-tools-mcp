# Missing live model responses

Two confirmed defects could leave a working card with status information but no reply:

- Activity observed the newest session turn instead of the card's assigned turn. A queued follow-up could therefore replace its live reply with an empty frame. Activity now uses the saved receipt's turn ID, falling back to the workflow's in-memory binding. A response belonging to another turn remains excluded.
- Live activity did not use the byte budget already applied to finished timelines. A single long Unicode transcript exceeded the 1 MiB IPC response limit and the whole frame was rejected. Activity now reserves space for every node's output and metadata, then shares one 800,000-byte budget across their timelines. Fitting replies remain visible beside oversized structured steers, which are omitted whole. Cached timelines retain their detail for subsequent reads.

Verification:

- Four permanent wire-budget regressions failed with `IPC_RESPONSE_TOO_LARGE` before the budget fix and pass afterward. They exercise real `invokeContract` validation with 1, 3 and 24 nodes, Unicode text, recent replies, cached-frame preservation, and structured steers.
- Turn-selection regressions cover both model routes, rejection of another turn, and continuation before the receipt contains a turn ID. A renderer test checks both ordinary and DeepSeek live text and completed-answer reloads.
- The combined workflow, chat renderer and turn-scope suites pass: 446 tests, zero failures. An independent reviewer also ran all nine new cases successfully.
- The full current-source GitNexus index was rebuilt. Its flow catalog has documented traversal caps; missing graph edges are not treated as evidence of no callers.

The isolated background browser loaded the real chat renderer using accepted 590,921-byte fixture responses. Subsequent browser inspection and screenshot requests timed out, so visual recovery of the original installed sessions is unverified. No installed app was patched, installed, stopped, or restarted. The fix does not increase polling frequency or launch model requests.
