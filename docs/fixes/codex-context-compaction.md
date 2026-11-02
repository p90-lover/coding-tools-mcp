# Native conversation compaction and saved model tuning

## Scope and reference

The requested reference is the local Codex context-compaction behavior, not tool-card folding. The local reference bundles are `app-initial-2b6b8063022d.js` and `app-primary-98d23d806dbd.js` from the existing `aiTemp/codex-settings-ref` snapshot. They submit `thread/compact/start` with only `threadId`, distinguish pending manual compaction from provider completion, refuse manual compaction during a running task, and let the native runtime own automatic model-token compaction.

Changes are based on main `73ab7c3de77571c9964fe6666ec4194fcf78f93f`, assembled in an isolated source copy without changing the shared checkout's branch or unrelated edits.

## Implemented

- Project instructions require task-scoped commits and PR delivery, with no merging unless requested.
- Model effort/window preferences are saved per harness/provider/account/model. Unconfigured fields use defaults; delayed metadata fits runtime values without overwriting saved preferences. Initial mounting restores unset fields without replacing explicit settings on an existing chat.
- `/compact` now targets the selected single-model chat's owned live conversation, not its task description and not a separate CPA summarizer request. AO uses its existing conversation-compaction endpoint; native Codex uses a scoped headless route and the bridge's existing compact operation/admission ledger.
- Acceptance remains pending until a provider compaction timestamp changes or the native operation settles. New input waits rather than steering into manual compaction. Polling is bounded; uncertain outcomes are not labeled successful. Replaced-session and unacknowledged-start results cannot complete another operation.
- `/context` uses actual reported tokens rather than the task's 8,192-character metadata limit. The obsolete byte-threshold `/autocompact` choice is not offered as native context control. Automatic session compaction remains the agent runtime's responsibility.

## Verification

- Before the repair, all four initial session-compaction regressions failed because the workflow tried to call the task-writing/summarization path.
- 857 tests passed across the selected workflow, upstream, renderer, model-preference, chat, and context-breakdown suites.
- Six final session-compaction tests passed after adding unacknowledged-start and foreign-workspace safeguards.
- Renderer TypeScript checking passed. Production renderer build passed (562 modules), retaining the existing unresolved `$app/tsconfig` and large-chunk warnings.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check` passed after restoring the tracked fixture files in the scratch copy.
- Native Clippy did not complete: the initial project-drive dependency download reached the 30-minute task limit; an offline retry specifically failed for missing `webview2-com-sys v0.39.1`. Native compilation and the added Rust route-contract assertions are not verified.
- GitNexus staged change analysis was run twice at limit 1000 and reported low risk, but its index is 1,460 commits behind and maps several changed lines to obsolete symbols. Its zero affected-process count is not evidence of zero impact. Source call-site and ownership checks supplement, not erase, that limitation.
- Browser tools are disconnected. No real-app visual or end-to-end native-session test was run; pixel parity is not claimed.

## Remaining boundaries

This is not a claim that every Codex compaction feature has been ported. The existing, separate board-task metadata rollover remains in place for bounded workflow records; it is not the agent's token context or the `/compact` operation. Team-wide compaction is not guessed or broadcast: the manual action requires a single-model session. Provider-specific unsupported compaction is reported rather than replaced with another model's summary. Full native build/test and local-Codex visual/lifecycle comparison remain required before treating this draft as ready.

No installed-app patch, packaging, restart, merge, live user-session modification, or tool-call folding changes were performed.
