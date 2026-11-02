# Native conversation compaction and saved model tuning

## Scope and reference

The requested reference is the local Codex context-compaction behavior, not tool-card folding. The local reference bundles are `app-initial-2b6b8063022d.js` and `app-primary-98d23d806dbd.js` from the existing `aiTemp/codex-settings-ref` snapshot. They submit `thread/compact/start` with only `threadId`, distinguish pending manual compaction from provider completion, refuse manual compaction during a running task, and let the native runtime own automatic model-token compaction.

Changes are based on main `73ab7c3de77571c9964fe6666ec4194fcf78f93f`, assembled in an isolated source copy without changing the shared checkout's branch or unrelated edits.

## Implemented

- Project instructions require task-scoped commits and PR delivery, with no merging unless requested.
- Model effort/window preferences are saved per harness/provider/account/model. Unconfigured fields use defaults; delayed metadata fits runtime values without overwriting saved preferences. Initial mounting restores unset fields without replacing explicit settings on an existing chat.
- `/compact` now targets the selected single-model chat's owned live conversation, not its task description and not a separate CPA summarizer request. AO uses its existing conversation-compaction endpoint; native Codex uses a scoped headless route and the bridge's existing compact operation/admission ledger.
- Acceptance remains pending until a provider compaction timestamp changes or the native operation settles. New input waits rather than steering into manual compaction. Polling is bounded; uncertain outcomes are not labeled successful. Replaced-session and unacknowledged-start results cannot complete another operation.
- `/context` uses AO's reported tokens rather than the task's 8,192-character metadata limit. Native Codex token usage is explicitly reported as unavailable; native thread IDs are never queried as AO sessions. The obsolete byte-threshold `/autocompact` choice is not offered as native context control. Automatic session compaction remains the agent runtime's responsibility.
- A queued message rechecks its owned compaction on normal queue retries after the short completion watcher expires. Pending or uncertain provider status keeps the message queued; confirmed completion allows one normal turn. Native compaction status reads preserve shared workflow reads, while starting compaction still invalidates them.

## Initial verification (historical; updates below supersede these blockers)

- Before the repair, all four initial session-compaction regressions failed because the workflow tried to call the task-writing/summarization path.
- 857 tests passed across the selected workflow, upstream, renderer, model-preference, chat, and context-breakdown suites.
- Six final session-compaction tests passed after adding unacknowledged-start and foreign-workspace safeguards.
- Renderer TypeScript checking passed. Production renderer build passed (562 modules), retaining the existing unresolved `$app/tsconfig` and large-chunk warnings.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check` passed after restoring the tracked fixture files in the scratch copy.
- Native Clippy did not complete: the initial project-drive dependency download reached the 30-minute task limit; an offline retry specifically failed for missing `webview2-com-sys v0.39.1`. Native compilation and the added Rust route-contract assertions are not verified.
- GitNexus staged change analysis was run twice at limit 1000 and reported low risk, but its index is 1,460 commits behind and maps several changed lines to obsolete symbols. Its zero affected-process count is not evidence of zero impact. Source call-site and ownership checks supplement, not erase, that limitation.
- Browser tools are disconnected. No real-app visual or end-to-end native-session test was run; pixel parity is not claimed.

## Initial boundaries (historical)

This is not a claim that every Codex compaction feature has been ported. The existing, separate board-task metadata rollover remains in place for bounded workflow records; it is not the agent's token context or the `/compact` operation. Team-wide compaction is not guessed or broadcast: the manual action requires a single-model session. Provider-specific unsupported compaction is reported rather than replaced with another model's summary. Full native build/test and local-Codex visual/lifecycle comparison remain required before treating this draft as ready.

No installed-app patch, packaging, restart, merge, live user-session modification, or tool-call folding changes were performed.

## Integration follow-up (2026-11-02)

The original PR head `5bcf4affe618b450ff633f6fec7a35ea7989849e` was locally integrated with main `365289f97fb489422fefc45afdeb72f8a55984cd`, preserving both parents. The command contract test now rejects `/compact` focus arguments. Regressions cover queued input after the completion watcher expires, native status reads preserving the shared workflow cache while starts invalidate it, and the real context command refusing to query a native thread as an AO session.

- The focused regressions reproduced all four integration findings before the fixes; all 10 selected checks pass afterward.
- The surrounding eight-file Node suite ran 671 tests: 666 passed in the sandbox, and the five loopback-dependent failures passed on a reviewed host rerun after sandbox `EACCES` blocked their fixture sockets.
- Renderer TypeScript checking and a 562-module production build passed with the existing project-drive dependencies. The build retains the existing large-chunk warning; it is verification output, not a release package.
- Local headless route-test compilation could not begin: the isolated offline Cargo cache has no `axum`. No toolchain or dependency was downloaded, and Cargo did not use C-drive storage. The original PR's remote Rust jobs pass, but exact integrated-head Rust CI and a fresh canonical native artifact remain release gates.
- Bounded impact queries timed out and change detection could not resolve this unindexed worktree. Graph impact remains UNKNOWN; direct caller review and the focused regressions do not establish live UI/native-compaction success.

The integration work does not install, restart, change models, push, or publish. Those actions and the final release validation remain with the coordinating task.

## Uncertain-start follow-up

A compaction HTTP timeout can occur after native admission while the RPC continues. Starts now retain their logical operation on an uncertain response. Native starts and status observations share one client request ID in the existing owned-thread admission ledger; a missing receipt or stopped/unknown outcome does not prove failure or completion. Repeated admission of the same key reuses its receipt. AO captures the previous compaction timestamp before its POST, so losing that response cannot make an older timestamp look like completion. Confirmed API permission/non-submission refusals still release the busy latch; only bounded status/code metadata is retained through the sanitized headless transport.

A real loopback HTTP fixture withholds the response after admission and times out: later completion reconciles the same operation with exactly one start. Real HTTP permission refusal and lost AO response cases also pass. The focused compaction/transport suites pass 17 checks, and the surrounding selected queue/compaction/recovery suites pass 46 checks. A Rust receipt regression covers missing/pending/settled/unknown/not-submitted receipts, duplicate-key admission and foreign-thread rejection. That native regression had not run locally because the isolated offline dependency cache was unavailable. These Rust changes required exact final-head Rust CI and a new canonical native artifact before release; the CI result is recorded below.

## Record-rollover and verification follow-up (2026-11-02)

PR [#888](https://github.com/p90-lover/coding-tools-mcp/pull/888) merged the saved tuning and owned-session compaction fixes. All seven reported checks passed on its final head `3da28679a5c18e72f8230daa59dfc147ff1e52f1`, including Rust test/Clippy on Windows, Linux and macOS, Linux formatting/build, Electron tests, frontend checks/build/contracts/audit, and goal transport/typecheck. The initial native-dependency download failure is therefore a historical local limitation, not an outstanding compile failure on that delivered revision.

One legacy mismatch remained: the hidden `autoCompact` switch and percent still controlled the board task's 8,192-byte description. A saved `off` blocked a full record with instructions to use `/compact`, although native `/compact` cannot shrink that record. A low saved percent also invoked a separate summarizer well before the record actually needed space.

The follow-up makes record rollover mandatory only when appending the follow-up would exceed the hard board byte limit. Legacy preference reads/writes remain compatible but no longer control rollover or native token compaction. The operation description identifies that compatibility-only scope. Failures explicitly identify the task record, leave it unchanged, and never suggest native `/compact` or the hidden `/autocompact` switch as a repair. Existing UTF-8 limits, reserved follow-up space, stale-write checks and native-compaction admission remain unchanged.

Verification:

- Three new regressions failed against the unchanged main workflow, then passed with the repair: no early summary at legacy 20/50/95/100 percent thresholds, rollover despite a saved `off`, and unchanged records with accurate errors after summarizer failure.
- Six focused record-rollover checks passed, including multibyte UTF-8, CRLF and a long goal-round follow-up.
- Seven surrounding suites exercised 865 checks: 864 passed initially; the one failure was an omitted `runtime-web/src/cli.ts` fixture in the isolated source copy, and it passed after restoring that exact main file. These suites include per-model A-B-A/default/Auto/restoration/capability-fitting/storage-isolation checks and native receipt/ownership/queue regressions. A final full workflow plus owned-session compaction rerun passed all 412 checks; both changed JavaScript modules also passed syntax checking.
- The existing built real-chat renderer fixture was opened in this chat's Preview pane. `/compact` stayed pending until the fixture's provider-completion acknowledgement, then displayed `Context compacted`; usage changed from 72k/128k to 12k/128k and the visible messages remained. Screenshot and DOM checks covered pending and completed states. No new console errors or failed requests occurred after the working fixture loaded. Vite's first launch failed on the unrelated root `$app/tsconfig` resolution and sandbox process-spawn restriction; the already-built fixture was served without Vite instead.
- This is a renderer check with a simulated provider, not an installed-app or real-native-session end-to-end test. The local Codex source snapshot still uses the same `thread/compact/start` request with only `threadId`; pixel-identical local-Codex styling is not established by this fixture.
- Pre-edit graph analysis reported HIGH risk for shared `chatSend` (workflow dispatch/main IPC callers), with partial traversal, and UNKNOWN for current tuning/rollover symbols absent from the stale index. Shared-checkout change analysis reported 38 files, 41 symbols and nine affected processes at HIGH risk, including unrelated dirty files. A separate task-only index then allowed `detect-changes --scope all --limit 1000` to inspect exactly these four files: it reported two symbols, zero affected processes and low risk, but mapped to obsolete symbols in the 1,460-commit-stale index. That zero is not an all-clear and does not waive the HIGH warning. Current caller review and regression tests supplement these unresolved graph limitations.

The separate hard-limit record summarizer still exists; this change does not claim lossless unlimited task storage or every Codex compaction feature. No installed-app patch, restart or live conversation modification is part of this follow-up.

### Final publication verification

The recovered source copy was compared with main `5ec4a93d6abf8447eb9e4e359dc4c21d74e9f81b`. Its outdated workflow/test files were restored from that revision before applying only the rollover repair, preserving the newer task-scoped history, message-deletion ownership, expected-turn observation and response-budget fixes. The delivered diff contains exactly four files.

- All three new regressions reproduced on that main workflow before the production repair. The full workflow and owned-session compaction suites then passed. The initial default-isolation test launch failed with sandbox `spawn EPERM`; running Node's supported `--test-isolation=none` avoided that spawn and passed without changing permissions.
- Five surrounding suites passed all 470 tests, covering saved tuning/defaults, renderer commands, queues, context reporting and upstream transport. Both changed production modules pass `node --check`; the diff passes `git diff --check`.
- This session repeated the built renderer fixture in the Preview pane: 72k/128k before `/compact`, pending until the explicit simulated-provider acknowledgement, then `Context compacted` and 12k/128k, with both messages preserved. DOM and screenshot checks passed; no console errors or failed requests were reported. Port 4193 was unavailable, and the fixture was successfully served on 42189 instead. This remains a simulated-provider renderer check, not a live native conversation or pixel-parity claim.
- Fresh impact queries timed out or returned UNKNOWN against the 1,460-commit-stale index. The first all-changes check also counted files absent from the partial source fixture and returned a capped CRITICAL result; those were not actual patch deletions. After marking absent tracked fixture files skip-worktree in the task-only index, `detect-changes --scope all --limit 1000` inspected exactly four changed files without capping: two obsolete symbols, zero processes, low reported risk. Its stale mappings are not a clean graph safety result, and do not waive the prior HIGH shared-send risk. Current caller inspection confirms the send path also serves queued input, goals, wake-ups and loops; the regression suites cover these surrounding paths.
