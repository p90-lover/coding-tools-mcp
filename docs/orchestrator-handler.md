# Orchestrator handler migration

Date: 2026-11-13. This is the compatibility-boundary stage, **not the removal of the AO fork**.

The independent project is [p90-lover/Orchestrator](https://github.com/p90-lover/Orchestrator). Its design separates the Coding Tools host, handler contract, engine drivers, process supervision and event/storage ownership. It records why replacing the pinned AO daemon with stock AO behind a proxy is not currently a compatible change. Per-session tools and provider routing are implemented inside the fork, and a proxy cannot supply its internal storage/lifecycle fixes.

## What changes here

`createAgentOrchestratorUpstream` constructs the same legacy runtime, then returns the version-1 handler. All 9 runtime methods and all 27 harness methods are exposed. The handler validates the complete interface before invoking anything and binds to that one runtime. It preserves receivers, arguments, result/promise/error identities and synchronous `watch` cancellation. It does not retry a request or select another engine.

`desktop-electron/electron/orchestrator-handler.cjs` is vendored from the separate repository so the installed app has no new runtime network/package dependency. `desktop-electron/vendor/orchestrator-handler.json` pins the source commit and hash. Updating it requires verifying the source, updating both bytes and provenance, and rerunning the handler/adapter contract tests. `BACKEND_MODULES` includes the handler so backend updates carry it.

No AO gitlink, database schema, existing session ID, model route, permission policy, UI or installed runtime is changed by this migration stage. The legacy adapter remains large; this boundary does not itself resolve AO writer stalls or remove fork maintenance.

## Verification and limits

- Standalone handler tests enumerate all methods and cover sync/async identity, missing methods, unsupported versions, cancellation, approval arguments and no replay.
- The real-adapter contract test inventories the actual object, including `setContextWindow`, without launching AO or touching its live store.
- Lifecycle regressions exercise the real factory through mocked daemon/process boundaries, including launch options, tool leases, approval modes, restarts and recovery.
- Backend-bundle and main-thread sync-call checks cover packaging and the main-process constraint.
- There is no new UI, so no visual behavior is claimed.
- A replacement native engine has **not** passed behavioral parity. Shape compatibility must never be advertised as full engine compatibility.

## Cutover gate

The separate repository's `docs/compatibility.md` lists the required launch, provider, tool, approval, turn, history, event, recovery, workspace, product, security, performance and packaging scenarios. A new engine cannot become the default until these have executable passing evidence, a tested data migration and a rollback path. During any canary, old AO sessions stay bound to AO and only explicitly selected new sessions may use the new engine. Never shadow mutating requests to both engines.

Rollback of this initial stage is a source revert only. It needs no data rollback and does not require changing the running installation.
