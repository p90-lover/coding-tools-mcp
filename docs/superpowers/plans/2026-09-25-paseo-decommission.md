# Legacy App Decommission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AO the only Coding Tools task/orchestration board, with standalone Paseo, Codex Router, CommandCode Proxy, and Anneal inactive and recoverable rather than deleted.

**Architecture:** Archive each retired module's private runtime state before any normalized configuration write, preserving shared CPA/AO stores and Anneal's separate Postgres task volume. Remove only retired branches from shared Electron/Rust services and the renderer. The existing AO board stays visible but explicitly unavailable for execution until the separate AO execution plan passes its real three-stage run.

**Tech Stack:** Electron CommonJS, React/TypeScript, Rust saved profiles, existing Node and Rust tests.

**Spec:** [Native AO Orchestrator design](../specs/2026-09-25-native-ao-orchestrator-design.md).

## Global Constraints

- Do not create a Git worktree, permanently delete data, alter credentials, restart Codex, or auto-approve a model tool. Keep unrelated dirty files and staged changes intact.
- Use the exact project root with Unified Agent Tools for reads and checks; put scratch under `aiTemp/`. Archive source and generated runtime in project Trash with original paths. Store sensitive saved state only in app-private restricted backup storage.
- Run GitNexus upstream impact before each changed symbol. `actUpstream` and `paseoRpc` are HIGH; `buildLoopbackMesh` is CRITICAL. Keep shared CPA/MCP/native behavior and test those branches.
- Do not move, blank, or rewrite the complete `profiles.json`: it includes shared CPA/AO accounts, secrets, and board records. Retain legacy deserialization but make retired jobs non-runnable. Anneal task rows live in a separate Docker Postgres volume; preserve that volume or a verified private export before removing its runtime.
- No intermediate AO screen may imply that a CPA draft is a completed Web GPT plan, worker run, or review. Avoid a model run until the exact routes and approvals in the execution plan are ready.
- Build and install the non-DEV app only after comparing its exact current archive and backing it up. Restart only Coding Tools when its active turns are safe; keep Codex open.

## Review Focus

1. Missing or unreadable backup target, key file, or Anneal Postgres volume/export must prevent decommission before shared config normalization or runtime removal; test failed-backup refusal and verify inherited private ACL before live migration.
2. Saved keep-alive, prior lease, or caller-supplied bootstrap ID for any retired module must not respawn it; test boot and reopen with legacy records present.
3. Removing retired branches must not disable CPA, MCP, native Codex, or CPA-owned CommandCode OAuth providers; test shared callers.
4. A renderer or MCP request naming a retired module must receive an explicit retired-module error, not silently route to AO or a stale handler; test both boundaries.
5. Packaging must contain AO/CPA and MCP/native support but no runnable retired bundle or handler; test staged contents and installed process/listener state.

---

### Task 1: Preserve retired state and disable startup

**Files:**
- Modify: `desktop-electron/electron/external-services.cjs`, `managed-external-services.cjs`, `managed-components.cjs`, `managed-bootstrap.cjs`, `main.cjs`
- Modify: `src-tauri/src/integrations/live.rs` only at retired lease restore/connect branches
- Preserve/verify: Anneal Docker Compose volume `agentos_postgres_data` under project `coding-tools-anneal`; Electron `integrations/state/{paseo,anneal}` and retired component homes
- Test: `desktop-electron/tests/external-services-control-plane.test.cjs`, `managed-bootstrap.test.cjs`, `managed-components-runtime.test.cjs`; focused Rust live-restore and private archive/volume checks

**Interfaces:** Extend the reviewed app-private `archivePaseoState` pattern to snapshot current shared external-service config/key and each retired module's daemon/component state and required key before normalization. Keep CPA entries in live shared stores. Preserve Rust's full-profile backup and the Anneal Docker Postgres volume (or verified private export) with original-path metadata. Archive paths are private and never return contents or secrets. Verify inherited ACL and volume recoverability before live migration; do not build a generic backup framework.

- [ ] Write focused failing tests: legacy enabled or caller-injected retired entries never autostart; a backup/key/Anneal-volume failure leaves original state unchanged; after raw archive, live normalized secrets contain CPA only; CPA still starts as configured.
- [ ] Run only those tests and confirm failure on Paseo's current startup path.
- [ ] Extend the private backup and retired-ID startup exclusion from the already reviewed Paseo slice. Do not change shared CPA lifecycle methods. Make old leases read-only and held, never runnable.
- [ ] Re-run the focused tests. Inspect the archive's metadata and restrictive location without printing its contents.

### Task 2: Retire four module routes and GUI without removing shared code

**Files:**
- Modify: `desktop-electron/electron/loopback-mesh.cjs`, `five-stack-cross-use.cjs`, `upstream-tools.cjs`, `upstream-actions.cjs`, `original-ui.cjs`, `five-stack-control-plane.cjs`, `orchestration-headless.cjs`
- Modify: `app-handler/host.cjs`, `app-handler/handler-registry.cjs`, `desktop-electron/electron/ipc-schema.cjs`
- Modify: `src-tauri/src/integrations/{mod,actions,live}.rs`, `src-tauri/src/integrations/execution/{service,transport}.rs` only at retired dispatch branches; keep serde fields
- Modify: `desktop-electron/src/App.tsx`, `desktop-electron/src/features/AgentOrchestratorSurface.tsx`, `desktop-electron/src/features/ExternalServicesSurface.tsx`, `desktop-electron/src/features/InProcessAppsPanel.tsx`, `desktop-electron/src/features/NetworkProxySurface.tsx`, related contracts and localization; archive the unused `AnnealTasksSurface.tsx` after imports are removed
- Modify: legacy Svelte `src/routes/integrations`, `work`, `missions`, `orchestrator-run`, and `orchestrators` only where they still expose retired actions
- Test: `desktop-electron/tests/modules-handler-surface.test.cjs`, `loopback-mesh.test.cjs`, `upstream-actions.test.cjs`, `renderer-wiring.test.cjs`, `localization.test.cjs`; focused Rust retired-route and old-record tests

**Interfaces:** AO remains an allowed app module. Calls for Paseo, Router, CommandCode Proxy, and Anneal fail with an explicit retired-module code. Remove the old Anneal task screen; old Anneal Postgres rows stay archived, not auto-run. The AO screen shows `execution unavailable` until the execution plan supplies a proven dispatcher.

- [ ] Write focused failing tests for AO's currently rejected `apps.call` IPC request, rejection of all retired IDs, no retired navigation, and no fallback dispatch. Verify CPA/MCP/native and CPA-owned CommandCode OAuth paths remain.
- [ ] Run those tests to capture the current failure. Read every HIGH/CRITICAL caller before changing its Paseo branch.
- [ ] Remove retired-module branches and UI entries; keep shared CPA/MCP/native mesh and AO paths. Make the AO capability state honest and prevent `plan`/`next` from being labeled an execution result.
- [ ] Re-run the focused tests and frontend typecheck. Verify that reopening the AO board does not start work and old saved tasks remain readable.

### Task 3: Remove retired packaged runtimes and verify recovery

**Files:**
- Modify: `desktop-electron/scripts/prepare-five-stack-runtime.cjs`, `vendor-upstream-bundles.cjs`, `prepare-package-resources.cjs`, `verify-package.cjs`, `desktop-electron/vendor/managed-components/*.json` where retired IDs are listed
- Archive after references are removed: retired `app-handler/` and `modules/` source, generated runtimes and managed component assets; never touch `old/` or Anneal's Postgres volume
- Test: `desktop-electron/tests/package-resource-preparation.test.cjs`, `package-contents.test.cjs`, `vendor-upstream-bundles.test.cjs`, `bundled-components.test.cjs`, `module-host-parity.test.cjs`

**Interfaces:** The package manifest and staged archive omit runnable Paseo, Router, CommandCode Proxy, and Anneal assets. A private recovery note maps each archived source/runtime/state path, including Anneal's database volume/export, to its original path and records that old jobs must not auto-resume.

- [ ] Write failing package and catalog checks for no retired binary/source/handler and retained AO, CPA, MCP, and native Codex assets.
- [ ] Run the focused tests; confirm they fail for the current Paseo bundle requirement.
- [ ] Remove retired modules from preparation/verification lists, then move only now-unreferenced source and generated assets to recoverable Trash. Keep legacy saved-record types, Anneal's data volume/archive, and `old/` intact.
- [ ] Re-run package tests, targeted Rust deserialization tests, frontend typecheck/build, and scoped `git diff --check`. Broaden only for a failed shared-service check.
- [ ] With a safe idle window, back up and install the staged non-DEV package, restart Coding Tools only, and verify no retired process/listener or usable handler; verify AO board, CPA, MCP, and native Codex. Report AO execution as pending until its separate plan passes a real Web GPT → selected Gemini → Web GPT review run.

## Stop Conditions

Stop before changing live configuration if any sensitive archive or the Anneal Postgres volume/export cannot be verified. Stop a package or install on source/archive drift, active turns that cannot be safely interrupted, any CPA/MCP/native regression, or inability to identify exact managed retired processes. Restore the archived package/config if a shared-service regression is confirmed; do not silently restart a retired module as a fallback.
