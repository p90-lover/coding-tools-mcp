# Auto-review without competing prompts

Command approvals marked `awaiting_review` now stay out of the human approval box until the backend hands them back. The renderer no longer applies its own four-minute review deadline, and the shared visibility helper honors the backend marker for both single chats and teams. The backend still owns retry, timeout, and decision delivery.

Definitive allow/deny decisions continue automatically. An unavailable offered decision, a failed delivery, or a reviewer that remains undecided produces a human fallback. Undecidable reviews are marked unresolved so the existing stale-answer path cannot turn them into a timed auto-allow. The existing “Let the model judge” conservative-denial behavior is preserved. Actual agent questions, plans, manual approval mode, Stop, and panel persistence are unchanged.

## Verification

- Seven focused regressions pass. Four of these failed against the pre-fix behavior, including elapsed-time prompt exposure and incomplete fallback state.
- 758 selected workflow, approval, chat renderer, and panel tests pass, with no failures or skips.
- Desktop TypeScript, backend syntax, and task whitespace checks pass. The first typecheck lacked renderer dependencies; restoring the existing shared `node_modules` junction resolved that environment issue without installing packages.
- Current-source impact analysis reports HIGH risk for `screenOne` through `screenApprovals`, `driveRun`, and observation/start paths. The approval visibility helper reports LOW risk. The scoped graph cannot resolve the Surface's outer JSX callers; `ChatPages` and split-pane callers were confirmed in source. Structured change analysis covers all three changed production files without partial/truncated result flags, while the graph's bounded flow-catalog limitations remain disclosed.

No real reviewer/model requests, installed-app changes, or restarts were performed. The app browser tools were disconnected during this follow-up, so live visual behavior remains unverified; renderer filtering and fallback behavior are covered by local tests.
