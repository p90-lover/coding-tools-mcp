# DSH chat UI continuation

Branch: fix/dsh-current-look. Base: 4cc13c88d.
Reference: deepseek-ai/deepseek-harness 22ddee3792402c3e70ec5f86a63c3e3e895a2f60 (rc.3).

Five-file port: collapsed live process groups, ranked activity icons, current tool-detail priorities, failed-command exit capsules, 4px row and 12px reply spacing, hover/focus behavior, scroll following, thought fades and running-footer geometry. Continuation corrections retain full executed commands in expanded terminals, hold the initial live title for 150ms, and match upstream group-icon sizes.

Verified:
- Focused ao-chat, ao-chat-ui and codex-chat-view files: 173 tests passed, zero failures.
- TypeScript --noEmit passed.
- Final CSS follow-up: ao-chat-ui, 34 tests passed, zero failures.
- Isolated hidden Electron fixture passed expand/collapse, raw command display, scroll intent, initial 150ms hold, completion folding, light/dark, exact 1440x900 and 390x844 content viewports, no page overflow and no renderer warnings/errors.
- Screenshots visually inspected. The fixture renders actual source components and CSS; the installed app was not patched or restarted.
- Scoped connected-source review and git diff --check found no remaining blocking issue.

Graph limitation:
The shared graph is 94 commits stale and returned UNKNOWN for newer DSH symbols. All source callers were searched explicitly. detect-changes could not resolve the linked worktree. A separate worktree index attempt stalled in initialization for several minutes and was stopped. No graph all-clear is claimed. The repository requires a successful graph change analysis before committing; no commit, push, PR or merge was performed.

Application-specific adaptations retained: approvals, retry/stall recovery, lazy image loading, diffs, history fallback durations and provider behavior. Full package, Rust/Svelte and installed-app tests were not run for this five-file Electron UI change.

Recovery copies: Trash/dsh-continue-20261024. Other tasks' submodule, dist and scratch files are excluded. Temporary fixture, bundle, profile and logs are cleaned after checkpointing. Preview images and changes.patch are retained as review deliverables.

Publishing requires confirmation under the working agreement's external-write rule.

Cleanup verified: aiTemp/dsh-continue-20261024 removed, no fixture process remains. Recovery copies retained at Trash/dsh-continue-20261024: 448438 bytes. Six workflow files were backed up and verified to differ only in line endings before restoring their original content; their Git content diff is empty.
