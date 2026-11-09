# Chrome login: waiting for close is not importing

## Report and cause

The screenshot shows an authenticated ChatGPT page in the dedicated normal Chrome window, while Coding Tools says `Importing…`. On Windows, `captureSystemBrowserLogin` intentionally waits for BOTH normal Chrome exit and the explicit Continue signal before offline capture; the window in the screenshot is still open. However, `RuntimeHost.continuePasskeyLogin` published `Capturing and verifying the passkey session` as soon as Continue was written, and the browser surface's local requested flag always displayed Importing. There was no distinct close-wait phase.

Regression tests also reproduced two latch defects: a synchronous stdin write throw left `passkeyContinuationRequested` set, and an asynchronous failure left the global capture message in place even after the local UI cleared its request. A late write error could reset a newer owned child's latch.

The immediate supported action for the existing flow is to close only the dedicated Chrome login window, not Coding Tools. If Continue has already been accepted, no second Continue is needed. This source patch does not modify the running app or close any live browser.

## Repair

- Report `Waiting for the dedicated Chrome window to close before importing` on Windows after Continue, not premature capture.
- The login child emits bounded human-readable progress through its existing stdout collection: waiting-for-close when Continue arrives first, then capturing only after normal exit AND Continue. The stdin consent message and capture/verification boundaries are unchanged.
- Both Browser buttons/empty-state text and the cross-page Chrome notice distinguish waiting for close from actual capture. Backend phase prevents duplicate Continue when moving between surfaces; English, Chinese and Japanese Browser copy includes the waiting state.
- Sync/async write failures restore the retryable Continue phase. An older child's failure cannot clear or publish state for a different current child.
- Preserve normal Chrome close for cookie flushing, isolated offline capture, proxy-route checks, account ownership checks, sanitized storage transfer, session verification and the existing activate/show handoff after successful import. No authentication bypass, automatic Continue, debug flags before sign-in, forced normal-login close, credential export or raw session logging is added.

## Verification

Five new Node checks failed before production edits. With the fix, five affected Node suites report 114 tests: **113 passed, zero failed, one skipped** because this machine cannot create symlinks without Windows Developer Mode. Coverage includes Continue failure recovery, stale child callbacks, close-wait notices and cross-surface wiring, runtime lifecycle, private account identity/import and renderer wiring.

The Bun browser-login suite reports six passing checks / 34 assertions, including both Windows event orders. It verifies no capture before both prerequisites, the waiting/capturing phase sequence, proxy preservation, offline-only capture, cookie-domain sanitization and profile cleanup. Its first run had one environment failure because the test source was under the configured TEMP root; using a separate project-drive temporary directory fixed that without weakening durable-runtime checks.

The renderer TypeScript check passes. The modified CLI bundles successfully (94 modules). Full runtime TypeScript checking is **locally blocked** by the existing shared dependency tree lacking `toml-eslint-parser`, with dependent implicit-any diagnostics in the unchanged `codex-interrupt-hook.ts`; remote applicable CI must validate the fresh dependency install. No live-account end-to-end or interactive visual/Preview verification is claimed.

A broad renderer fixture refresh was blocked and was not retried. The subsequent narrow refresh only replaced individually hash-verified, older committed dependency fixtures (types/styles/browser dock/surface) and added the missing tracked sidebar helper. Those fixture restorations are not part of this task's diff; all unrelated edits are preserved.

## Source and graph boundary

Based on main `bef8bf53ebb4e4f9b373c7d973119e2eda728d41` in the reused isolated task workspace. UI impact is LOW in the available current login-notice graph. Runtime/CLI targets were absent/UNKNOWN in available older indexes, not unused: source checks confirm the trusted main/preload Continue IPC, the owned child's stdout/stdin lifecycle, the CLI login command and the two capture callers. A fresh five-source task graph (535 nodes, 1,576 edges) maps the final `detect-changes --scope all --limit 10000` result: ten task files, thirteen symbols, ten affected processes and HIGH aggregate risk. Graph generation reports 117 untraced entry points, dropped processes/callees and cross-language property gaps; this is not a clean safety verdict. Repeating all-change analysis does not waive those coverage limits.

This is a progress/latch fix, not proof that every installed import failure is the same issue. If the dedicated Chrome is already closed and the app remains in capture/verification, the distinct phase and existing error/timeout path are the next diagnostic boundary. No live processes, accounts, files or login sessions were modified.
