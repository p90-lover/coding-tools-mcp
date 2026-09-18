# Coding Tools rc.9 One-App Managed Five-Stack Design

## Status

Approved architecture: **Option A — one-app managed**.

The user installs and operates Coding Tools as the only product UI. Coding Tools may download, verify, build, repair, and supervise pinned upstream engines on first use, but the user must not need to install or launch Codex Router, CPA / CLIProxyAPI, CommandCode Proxy, Paseo, or Anneal as separate applications.

This design consolidates the verified work currently spread across the rc.9 release branch and pull requests #174, #177, #178, #179, and #180. Existing branches, pull requests, releases, source files, and retained evidence remain untouched. Temporary work belongs under `aiTemp/`; replaced or failed material is moved under `Trash/` instead of being deleted.

## Goals

1. Provide one Coding Tools installer and one Coding Tools control surface for all five engines.
2. Make first-run installation, repair, startup, shutdown, restart, health checks, credentials, account routing, and updates app-managed.
3. Preserve the original upstream user interfaces where they exist while hosting them inside Coding Tools rather than requiring a separately launched application.
4. Keep CPA as the central multi-account and OAuth authority for supported providers, with CommandCode’s dedicated session adapter retained where necessary.
5. Keep all network listeners loopback-only by default.
6. Support beta/prerelease updates from `p90-lover/coding-tools-mcp` and preserve the existing installation directory during silent updates.
7. Fail closed when a download, checksum, prerequisite, credential, migration, or health check is ambiguous.
8. Never delete retained project or runtime files. Move superseded, failed, or temporary material to a uniquely named path beneath `Trash/`.

## Non-goals

1. Bundling every upstream source tree and dependency inside the initial installer. This is Option A, not the fully offline Option B.
2. Removing advanced external-service overrides. They may remain as an opt-in recovery mechanism, but app-managed runtimes are the default and required supported path.
3. Replacing upstream engine behavior with simplified mock interfaces.
4. Automatically enabling Windows optional features without explicit operating-system consent. Coding Tools may guide and invoke the approved setup flow, but Windows can still require elevation or restart for WSL2 prerequisites.

## Product experience

### First run

Coding Tools presents a single **System Setup** card with these states:

- `Ready`: all required app-managed components are installed and healthy.
- `Setup required`: one or more components or prerequisites are missing.
- `Repair required`: installed state does not match its pinned manifest or health contract.
- `Action required`: an operating-system prerequisite, credential, restart, or provider login needs user participation.

The primary action is **Install and start all**. It executes the managed dependency graph and reports per-component progress. The user does not clone repositories, run package-manager commands, edit environment files, or start services manually.

### Daily operation

Coding Tools starts only the components required by enabled features. The Integrations surface exposes install, repair, start, stop, restart, health, version, process ID, logs, and original UI access. Provider Hub exposes accounts, OAuth/import flows, models, defaults, fallbacks, and proxy routing. A global status strip reports degraded components without blocking unrelated features.

### Original user interfaces

- CPA’s original `management.html` application is hosted full-bleed inside the Coding Tools CPA page through a loopback URL and constrained session bridge.
- Codex Router Control Center is built from the pinned source and hosted inside the Coding Tools main window using an isolated Electron `WebContentsView` with a least-privilege `routerControl` bridge. It must not launch a second standalone desktop application.
- Paseo’s original interface is embedded using its real routes, including sessions, project opening, and settings.
- Anneal’s original hash-routed interface is embedded using its real routes, including tasks, projects, and inbox.
- CommandCode Proxy has no upstream HTML dashboard. Coding Tools provides its original CLI-oriented status information, account/session actions, model discovery, and lifecycle controls without inventing a second chat interface.

## Architecture

### 1. Managed component controller

`desktop-electron/electron/managed-components.cjs` remains the single authority for component installation and process lifecycle. Its component catalog contains:

- `cpa`
- `codex-router`
- `commandcode-proxy`
- `paseo`
- `anneal`

Each component has a versioned manifest under `desktop-electron/vendor/managed-components/`. Every source commit, release asset, and checksum is pinned. Runtime source is installed beneath the application data component root; durable configuration, databases, account bindings, generated keys, and logs live in a separate state root so repair and version replacement cannot overwrite them.

Install and repair use a staging directory below the application-data `aiTemp/managed-components/` root. An installation becomes active only after checksum/source verification and all manifest assertions pass. An existing active version is moved to `Trash/managed-components/` before replacement. Failed staging is also moved to `Trash/managed-components/` with timestamped evidence.

No managed path uses recursive deletion, `git clean`, destructive Docker teardown, or shell deletion commands.

### 2. Unified setup orchestrator

Add a small orchestration layer above the component controller with a deterministic dependency graph:

1. Validate host prerequisites and writable data roots.
2. Install/configure CPA because it is the default provider-account authority.
3. Install Codex Router and CommandCode Proxy in parallel when safe.
4. Install Paseo.
5. Install Anneal after its platform prerequisites and operator credential are satisfied.
6. Start enabled components.
7. Verify authenticated health and model/account projections.

The orchestrator persists no secrets. It consumes redacted component snapshots and returns a bounded progress model to the renderer. A failed component does not roll back or stop already healthy independent components. Retry resumes at the failed step.

### 3. CPA / CLIProxyAPI

Use the official pinned CLIProxyAPI release binaries and platform-specific SHA-256 hashes from the verified #179 implementation. Coding Tools safely extracts the expected executable only, writes a private loopback configuration for `127.0.0.1:8317`, and generates separate encrypted management and proxy API keys.

CPA-backed Codex, Claude, Gemini, Qwen, iFlow, and supported Antigravity account flows use the centralized CPA runtime. Existing CPA OAuth and auth-file adapters remain the account-binding state machine. CommandCode continues to use its dedicated OAuth/CLI-session adapter, while its traffic can still participate in the same provider, account, model, fallback, and proxy policies.

Renderer snapshots expose only readiness, counts, labels, and whether credentials exist. They never expose management keys, API keys, OAuth tokens, auth-file names, auth indexes, or generated caller secrets. Copying a management key is an explicit focused-window IPC action and never places the key in React state.

### 4. Codex Router

Keep Codex Router pinned to its verified upstream commit. Coding Tools prepares the router, creates state-isolated wrappers, supervises its foreground process, and performs caller-secret-aware health checks on `127.0.0.1:4202`.

The original Control Center renderer is built during managed installation. Coding Tools hosts it in an isolated `WebContentsView` attached to the main application window. A dedicated preload exposes only the minimum router-control methods required by the upstream UI. The view uses a persistent partition under the managed state root and shares the same router state and caller-secret authority as the supervised service.

Closing or navigating away from the view does not stop the router. Stop and restart actions terminate both router-owned child processes and the embedded Control Center view cleanly before replacing or preserving state.

### 5. CommandCode Proxy

Keep the pinned source and app-managed loopback process on `127.0.0.1:9090`. The proxy API key is generated and encrypted in the Electron main process. Health and model discovery send the required Bearer credential and accept only configured success statuses.

The Coding Tools page displays the upstream CLI identity, listen address, Cursor-compatible `/v1` URL, Claude Code environment value, active session/account projection, model count, and lifecycle actions. Provider logins and session import remain in Provider Hub so there is one account-management authority.

### 6. Paseo

Keep the pinned Paseo source, app-managed dependency installation, server build, daemon supervision, and execution WebSocket. The embedded UI must use actual upstream routes rather than invented paths. Coding Tools supplies provider/account/model routing through the existing execution bridge and does not fork a separate Paseo account store.

Install and build output remains beneath managed component staging. Dependencies are reused across repair when their exact lockfile identity matches; ambiguous caches are preserved to `Trash/` and rebuilt.

### 7. Anneal

Keep the pinned Anneal source and its PostgreSQL, API, runner, and web topology. On Windows, Coding Tools manages the topology through WSL2; Linux and macOS use the native managed mode. The supported Windows path does not require a user-managed SSH port-forward.

Coding Tools detects WSL2, Docker availability, distribution readiness, loopback forwarding, and restart requirements before installation. Missing OS prerequisites produce one actionable setup screen and may require Windows consent/restart. Once prerequisites exist, Coding Tools runs all remaining commands itself.

Anneal configuration and database state live outside replaceable source. The GitHub read token is encrypted. A fresh migration is allowed only when the dedicated managed volume does not exist. Existing volume without a completed initialization marker fails closed and offers diagnostics rather than resetting data.

### 8. Shell and navigation

Adopt the restored shell behavior from #177: primary navigation remains focused on Browser, Setup, MCP, Activity, and Settings. Provider and engine surfaces remain reachable under a scrollable integrations group. Sidebar open state and width persist. MCP and setup pages remain scrollable and all live IPC handlers must exist for exposed preload methods.

The original engine surfaces are hosted by the same main window and navigation model. No component requires the user to launch a second desktop executable.

### 9. Updates and installation location

Integrate the verified #174 update changes and extend settings with an explicit update channel:

- `stable`: ignore prereleases.
- `beta`: accept stable, RC, beta, and alpha releases.
- `automatic`: prerelease installations follow beta; stable installations follow stable.

Existing rc.8 users default to `automatic`, which makes rc.8 eligible for rc.9. The updater reads published, non-draft GitHub Releases, selects the highest compatible complete release, requires the exact platform installer and `SHA256SUMS.txt`, verifies SHA-256, prompts Install/Later before download, and preserves the current installation directory.

On Windows, the detached installer receives `/S` and a final `/D=<current executable directory>` argument. Legacy NSIS/MSI migration sets `$INSTDIR` from one validated prior install location. Update staging and cancelled/failed downloads are moved into `aiTemp/Trash/update/`; they are not recursively deleted.

The rc.9 release must publish exactly:

- tag `v0.7.0-rc.9`
- prerelease enabled, draft disabled
- `Coding.Tools_0.7.0-rc.9_windows_x64_setup.exe`
- `SHA256SUMS.txt` containing the exact installer entry
- provenance and validation evidence generated from the immutable source SHA

### 10. Security boundaries

- All service endpoints are loopback-only unless an explicit advanced override is enabled.
- All downloads use HTTPS, pinned identities, size limits, expected inventory, and SHA-256 verification.
- Secrets are encrypted with Electron safe storage when available and a private authenticated fallback otherwise.
- Renderer IPC is schema-validated, focused-window gated for sensitive actions, and returns redacted results.
- Original upstream views receive purpose-specific bridges, not the full Coding Tools API.
- Component commands are allowlisted and checked for destructive executables and shell fragments.
- Provider quota is not consumed by automated tests.

## Error handling and recovery

Every setup operation has a durable redacted operation state: component, step, start time, status, and bounded error message. Raw secrets and tokens are removed from logs. Network and build retries are bounded and use exponential backoff only for retryable conditions.

If source installation or repair fails, the previous active version remains usable. If activation fails after preserving the previous version, Coding Tools restores the previous active directory and records both errors. Locked Windows evidence directories use bounded process shutdown and retry before preservation; a failed move is reported and retained in place rather than deleted.

Health state distinguishes `not-installed`, `installing`, `starting`, `ready`, `degraded`, `repair-required`, `action-required`, `stopped`, and `error`. HTTP authentication failures are never treated as healthy.

## Verification and release gates

### Focused contracts

- Manifest validation for all five components.
- CPA download/extraction/checksum and real loopback launch.
- CPA OAuth/auth-file binding and secret non-exposure.
- Codex Router preparation, caller-secret health, wrapper identity, and embedded Control Center bridge.
- CommandCode OAuth/session import, authenticated health, and model discovery.
- Paseo real-route UI mapping and execution routing.
- Anneal persistent configuration, WSL path conversion, dedicated-volume marker behavior, and topology lifecycle.
- Unified install-all progress, retry, and partial-failure behavior.
- Stable/beta/automatic update selection and exact installer naming.
- Legacy install-location migration and `/D=` silent update behavior.
- No tracked deletion and no destructive managed command.

### Build and smoke gates

- Node syntax checks for all main-process modules.
- TypeScript `tsc --noEmit`.
- Isolated production renderer build under `aiTemp/`.
- Linux managed-component process smoke.
- Windows installer build and package inventory verification.
- Packaged launcher smoke with every required ASAR/unpacked module present.
- Windows installer migration acceptance from legacy NSIS and MSI fixtures.
- Native Windows app smoke covering install-all, CPA, Codex Router, CommandCode Proxy, and embedded upstream pages.
- Anneal WSL2/Docker smoke on an authorized Windows runner with prerequisites available.
- SHA-256, provenance, immutable-source, and remote release-asset readback.

A release is not declared complete until all required gates are green on the same immutable source SHA. Platform-prerequisite tests that cannot execute on GitHub-hosted runners require retained evidence from an authorized native runner; they cannot be silently waived.

## Consolidation strategy

Create one integration branch from `release/codex-router-multiprovider-0.7.0-rc.9`. Port changes in this order, using tests before implementation and retaining all source branches:

1. #174 update prompt, channel, and install-location work.
2. #177 shell and live MCP wiring.
3. #179 verified managed CPA runtime.
4. CPA original management UI and Codex Router embedded Control Center from #180, excluding duplicate CPA runtime and duplicate shell changes.
5. Real Paseo/Anneal/CommandCode UI routing from #178, excluding its user-managed Anneal port-forward behavior.
6. Windows smoke preservation lock repair.
7. Unified install-all orchestrator and final exact-source release gates.

Overlapping pull requests are not merged blindly. Each useful change is reconciled against the integration head, and the final pull request targets the rc.9 release branch. Superseded pull requests remain open or are closed only by explicit repository-owner decision; no branch is deleted.

## Acceptance criteria

The architecture is accepted when a clean Windows user can install Coding Tools, open one application, select **Install and start all**, complete only unavoidable OS consent/restart and provider-login interactions, and then operate CPA, Codex Router, CommandCode Proxy, Paseo, and Anneal from Coding Tools without separately cloning, building, configuring, or launching those engines.
