# Correctness review — 2026-10-18

## Scope and method

Repository-wide test baselines, followed by focused manual review of active first-party code: desktop startup/recovery, goal execution, persistence, provider/network routing, the in-process module host, runtime-web transport, Svelte checks, and Rust lifecycle/data-store code. This is not a line-by-line audit of every archived or vendored implementation. Pinned upstream snapshots and historical `old/` sources were left unchanged.

## Confirmed defects fixed

### 1. A CONTINUE goal could be treated as achieved

- Location: `desktop-electron/electron/chat-goals.cjs`, `goalVerdict`.
- Trigger: `GOAL: CONTINUE — login achieved; tests still need fixing`.
- Before: the parser selected the correct marker line, then searched its entire text for `ACHIEVED`, prematurely stopping the goal.
- Fix: use the captured marker value. The final marker in each answer retains precedence, as before.
- Regression: `desktop-electron/tests/chat-goals.test.cjs` covers explanations containing the opposite verdict word and repeated markers.

### 2. Rejected goal writes changed live state

- Location: `desktop-electron/electron/chat-goals.cjs`, `createGoalStore`.
- Triggers: an invalid status, or an inaccessible persistence directory during set/update/clear.
- Before: the in-memory object changed before validation or persistence succeeded. A failed operation could therefore affect autonomous goal execution while the saved file still contained the previous goal.
- Fix: validate and atomically persist a proposed snapshot before changing live state. Successful updates preserve existing object references.
- Regression: invalid-status and real filesystem-failure tests verify unchanged memory, timestamps, and saved data; successful writes are reopened and checked.

### 3. Installed Codex was not discovered on macOS/Linux

- Location: `desktop-electron/electron/agent-orchestrator-workflow.cjs`, `findInstalledCodexExecutable`.
- Trigger: a working `codex` executable exists on PATH on a non-Windows host, with no manually chosen executable.
- Before: discovery returned null because it only considered Windows installation paths.
- Fix: search PATH on macOS/Linux, require an executable regular file, follow package-manager symlinks, and skip broken/non-executable entries. Windows discovery is unchanged.
- Regression: `desktop-electron/tests/codex-executable-discovery.test.cjs` uses real temporary files, permissions, directories and symlinks.

### 4. A truncated local HTTP response could hang a module request

- Location: `app-handler/lib/loopback.cjs`, `requestJson`; the compatibility module delegates to this implementation.
- Trigger: a service sends headers, optionally part of a JSON body, then disconnects.
- Before: the request promise stayed pending because only request-level errors and response `end` were handled. A real local server reproduced this without external dependencies.
- Fix: reject response abortion and response-level errors. Existing request authentication, limits, and successful parsing are preserved.
- Regression: `desktop-electron/tests/module-loopback-interruption.test.cjs` exercises both interrupted-response cases and a complete response; module-host and CPA handler tests also pass.

## Candidate requiring Rust validation

`rust-core/coding-tools-headless/src/lib.rs`, `Lifecycle::wait_idle` checks `active_requests` before creating its notification future. The last lease can be dropped between those operations; `notify_waiters()` then has no registered waiter, so an already-idle service may wait until the drain timeout. This is a static concurrency candidate, not a validated runtime finding, and was not changed. A deterministic concurrency test should register the notification before checking the predicate and cover a lease dropping in that interval.

Rust execution was unavailable: this machine has no Rust compiler/Cargo and lacks the GTK/WebKit development libraries required by the current Tauri dependency graph. Native Rust and Go plugin suites were not claimed as passed.

## Validation and baseline limitations

- Full desktop baseline before these fixes: **1,481 tests; 1,441 passed, 35 failed, 5 skipped**. This baseline was not clean and is not represented as clean after the review.
- Full runtime-web suite after installing its declared dependencies and using its pinned Bun 1.4.0 from a durable path: **770 tests; 766 passed, 4 skipped, 0 failed**.
- Root Node contracts: **55 passed, 0 failed**.
- Svelte check: **0 errors, 0 warnings**; production build passed.
- Runtime-web TypeScript check passed.
- Focused final desktop regression selection: **69 passed, 0 failed**; existing goal/compact integration selection: **7 passed, 0 failed**.

The final GitNexus change analysis reported **critical** risk. Its generic `set` method entry has no resolved symbol ID and expands into many unrelated execution flows; increasing the result limit did not establish a bounded impact set. Other changed helpers were absent from its symbol results. This is unresolved graph coverage, not an all-clear. Source inspection confirmed the goal store's production caller in the orchestrator, and the goal integration and persistence tests above cover that path. A full desktop/platform validation remains outstanding.

The desktop baseline failures were investigated rather than counted as 35 application bugs:

- Native orchestrator fixtures assume Windows executable paths and filesystem semantics on this Linux runner.
- Antigravity archive extraction fixture selects the Windows extraction executable on a Linux host.
- Connector browser fixtures hard-code the Windows Chrome executable.
- One Electron relay fixture cannot run with this host's Chromium sandbox setup.
- Browser-host fixtures initially lacked the pinned launcher's Electron installation.
- A native AO tree test reads a file that is absent at its hard-coded historical commit/path.
- Package-content fixtures require the missing `aiTemp/CLIProxyAPI_8.0.32_windows_amd64.zip` release archive.
- A WebGPT test uses an outdated source-pattern assertion; existing behavioral picker/routing tests are separate checks.

Windows-specific scenarios, packaged installer execution, live authenticated providers, and the Rust candidate remain outside verified runtime coverage. No test assertions were disabled to make the baseline appear green.
