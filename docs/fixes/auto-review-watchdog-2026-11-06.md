# Auto-review hangs and bounded recovery

## Symptom and boundary

The user's screenshot shows a working chat held on “the reviewer is checking” for more than four hours. Recover reports that the existing accepted turn is still working. Recover deliberately inspects the turn without replaying messages or restarting inference; it is not the approval-review watchdog.

Read-only AO sampling found a separate approval with a 253.1-minute pending interval before resolution. That confirms this failure class in the running system, but the sampled chat was not proven to be the exact screenshot card. No live approvals, commands, account configuration or databases were changed during diagnosis.

## Root cause

1. The 45-second review budget starts after some catalog setup and is enforced mainly through the fetch abort signal. Catalog/context/repository reads and response-body consumers can remain pending independently of that signal.
2. A hung review can pin a screening slot; a run without a driver also holds its undriven-screen latch until the promise settles. Retrying only on thrown errors does not revive a promise that never finishes.
3. The stale-screen pass deletes its map entry but does not fence every late continuation in the original screening. A late reviewer can still populate advice/cache or attempt an answer after replacement or Stop.
4. Advice is saved before delivering the verdict. If delivery never settles, advice exists but is not resolved, so the renderer can keep hiding it as awaiting_review without the no-advice overdue fallback.
5. Backend run reads are cloned snapshots. Checking only a captured node misses later ownership/rule changes; fresh checks now precede model/cache/advice side effects and answer delivery.
6. The observer deferred to a run marked driving/starting even when that driver was blocked. It can now keep review progressing independently; the shared screening map prevents duplicate review jobs and a stopped run remains excluded.
7. An uncertain delivery leaves unresolved advice. Judge-mode rescreening did not exclude that advice and could send the decision twice, including when judge mode was enabled after the timeout. The retry predicate now preserves unsent advice for reconciliation instead of resending it.

## Acceptance contract

- One screening pass, including preflight, reviewer setup, request, response parsing and delivery, has a real bounded deadline independent of whether a dependency honors AbortSignal.
- On transient review timeout, release the slot/latch and retry through the existing bounded retry policy. Never select a stand-in model outside the configured codex-auto-review/account chain.
- After retry exhaustion, use the existing explicit fallback: human action when required; a conservative deny in model-judge mode, never silent allow.
- Stop, changed owner/turn/route and replacement screening retire old continuations. Late model responses cannot alter verdict caches/advice or send a decision for an obsolete attempt.
- An unknown answer-delivery outcome is not replayed. Surface it for reconciliation/person action rather than hide it indefinitely.
- Preserve questions/plans, explicit denials, manual approval and command ownership. Do not auto-restart or resubmit the worker's commands merely to revive its reviewer.

## Verification

- All **18 focused watchdog tests passed**. Before the patch, the suite reproduced absent watchdogs, indefinite latches and late sends after owner change/disposal. Both judge-mode uncertain-delivery cases also failed before the no-resend guard. The Stop fixture explicitly confirms host shutdown rather than assuming an interrupt ended the agent.
- The exact final candidate passed **736 checks** across the full workflow, approval-judge, exact-turn recovery, compaction, lifecycle and long-horizon terminal/MCP suites, with no skips. It includes cloned backend snapshots, rejection before late verdict caching, blocked-driver observer recovery, preserved retry/failure feedback and judge-mode no-resend safety.
- Controlled timers cover catalog/folder/context/fetch/body stalls, retry success without user input, exhaustion, conservative model-judge denial, stale replacement, direct tool review, uncertain delivery in normal/judge mode and after enabling judge mode, and Stop/owner/disposal precedence. Shared catalog/folder reads may wait for their existing one-minute cache TTL before a new lookup is attempted; no worker command is replayed.
- Syntax and whitespace checks pass. No live model requests or approval mutations were used in tests.

Live recovery of the exact screenshot chat remains unverified until a normal update ships; no live patch, installation or restart was performed.
