# Coding Tools rc.9 Managed Five-Stack Integration Plan

## Goal

Make Codex Router, CPA/CLIProxyAPI Provider Hub, CommandCode Proxy, Paseo, and Anneal operable from inside Coding Tools without requiring the user to manually clone repositories, locate executables, or type launch commands.

Process isolation remains intentional: third-party services run as loopback-only child services, while Coding Tools owns installation, lifecycle, health, routing, encrypted credentials, and embedded UI. This avoids fusing unrelated runtimes into the Electron process while meeting the in-app management requirement.

## Exact integration lineage

- Repository: `p90-lover/coding-tools-mcp`
- Release baseline: `release/codex-router-multiprovider-0.7.0-rc.8`
- Baseline SHA: `5aa516e35e8f9824d3309a4016f3f309f33d956c`
- Managed-runtime source: `integration/v0.7.0-rc.9-managed-five-stack`
- Unified CPA OAuth source: `fix/v0.7-rc9-unified-cpa-oauth-accounts`
- Combined validation branch: `integration/v0.7.0-rc.9-five-stack-cpa-union`

## Defects in rc.8

1. Codex Router has a control plane but no complete in-app pinned installation and foreground lifecycle.
2. CommandCode OAuth/session import exists, but the proxy process must already be installed and running.
3. CPA-backed Codex, Claude, Gemini, and Antigravity accounts do not share one explicit adapter/account model throughout the Provider Hub.
4. Paseo can be embedded only after a source checkout and launch command are configured manually.
5. Anneal launches only a partial web surface; its PostgreSQL, API, runner, configuration, build, and migration lifecycle is not managed as one topology.
6. The Integrations page exposes raw executable fields before it exposes an install/repair lifecycle.

## Managed architecture

### Shared component manager

The main-process-only managed component manager:

- reads pinned manifests shipped in `desktop-electron/vendor/managed-components/`;
- validates component IDs, strategies, URLs, commits, SHA-256 values, commands, and loopback endpoints;
- stages downloads/checkouts under application `aiTemp/`;
- activates verified installs under application `components/`;
- stores mutable service state separately under application `state/`;
- moves superseded, partial, or mismatched installs under application `Trash/managed-components/`;
- never calls recursive deletion APIs;
- records an immutable install marker and a bounded install log;
- exposes inspect/install/repair through focused-window IPC;
- never returns provider or service credentials to the renderer.

### CPA Provider Hub

- Exposes first-class CPA adapters for Codex, Claude, Gemini, and Antigravity.
- Keeps every OAuth/session credential in the encrypted Electron main-process store.
- Records adapter identity and credential source on each account without exposing tokens to the renderer.
- Supports multiple accounts, default-account selection, health/model refresh, and approved fallback routing.
- Keeps provider credentials separate from Paseo/Anneal control-plane credentials.

### Codex Router

- Pins `duolahypercho/codex-router` v0.6.0 at commit `930f547d8d8861a47e18a83216e15e73a73aa97c`.
- Uses a pinned source checkout plus a Coding Tools main-process adapter on every platform.
- Runs the upstream prepare-only installation path, validates the package identity and required sources, and creates platform wrappers under managed state.
- Starts `src/foreground-start.mjs` as a supervised foreground child service.
- Preserves the generated caller secret outside the source checkout and uses it only for loopback health/control requests.
- Exposes managed router and model-curation commands without placing credentials in ordinary configuration.

The final source-managed adapter supersedes the initial release-binary-only design because it provides one consistent foreground lifecycle, state boundary, model-curation path, and caller-secret verification across supported platforms.

### CommandCode Proxy

- Pins `zahidhussaina2l/commandcode-proxy` commit `c123a3ebe017415ef45e619600a1110198dea7f8`.
- Clones to the managed component root and launches with loopback-only host/port settings.
- Uses a main-process-only generated proxy API key.
- Reuses the existing CommandCode CLI-session import/OAuth account binding from Provider Hub.
- Exposes `/v1/models` health/model discovery without returning the proxy key to the renderer.

### Paseo

- Pins `getpaseo/paseo` commit `1e4ba65c6d75a6b061a1d54141f2f105b5908a96` / v0.8.0.
- Runs locked dependency installation, builds the server, and launches on `127.0.0.1:6768`.
- Keeps the dedicated execution WebSocket route and embeds upstream sections inside the app.
- Receives approved provider/account/model routing from Provider Hub while provider secrets remain inside the main process.

### Anneal

- Pins `mosonlab/anneal` commit `e43b72b10ad389f090a0be18eea5d2bcef468f5e` / v0.9.0.
- Uses managed WSL2 execution on Windows because upstream does not support native Windows; Linux/macOS use native execution.
- Persists `.env` under managed state, restores it on repair, and creates it through `npm run setup:local` only when absent.
- Requires the GitHub read credential through the main-process secret boundary and applies restrictive permissions to persisted configuration.
- Builds Anneal, starts its dedicated PostgreSQL compose project, and uses initialization markers to prevent an unmarked existing database from being reset.
- Runs the release migration with `--fresh` only for a newly created dedicated database, then records a completed marker.
- Supervises PostgreSQL, API, runner, and web as one topology.
- UI endpoint is `http://127.0.0.1:5173/`; API/execution endpoint is `http://127.0.0.1:3000/`.

## Shared API reconciliation

The CPA and managed-runtime branches both modify the preload and renderer type surfaces. The union materializer must preserve both sets of contracts:

- optional CPA adapter selection in `beginProviderLogin`;
- provider credential-source/account metadata;
- managed component snapshot, install, repair, and credential methods;
- managed component state/process types;
- idempotency when rerun on an already materialized source tree.

## Renderer behavior

The Provider and Integrations surfaces show:

- installation state (`not installed`, `installing`, `installed`, `repair required`, `external`);
- pinned version/commit;
- Install / Repair controls;
- Start / Stop / Restart / Health controls after installation;
- provider account, adapter, model, proxy, and fallback routing;
- prerequisites and actionable diagnostics;
- advanced executable/home fields behind a disclosure rather than as the primary path;
- English and Traditional Chinese copy.

## Test-first gates

1. CPA adapter tests cover Codex, Claude, Gemini, and Antigravity login/import routing.
2. Provider tests prove multiple accounts, model selection, proxy policy, fallback, and provider/orchestrator credential separation.
3. Manifest tests cover all strategies and reject remote listeners, unpinned sources, malformed hashes, path escape, and destructive commands.
4. Managed lifecycle tests prove staging, activation, repair, state preservation, and Trash retention without destructive cleanup.
5. CommandCode tests prove session import, loopback routing, and proxy keys staying out of snapshots/logs.
6. Codex Router tests prove pinned source identity, managed wrappers, caller-secret creation, and supervised foreground execution.
7. Paseo tests prove managed install, server build, embedded sections, and provider-account routing.
8. Anneal tests prove persistent config, marker-protected database initialization, PostgreSQL/API/runner/web topology, and Windows WSL2 boundaries.
9. Strict TypeScript and production renderer builds pass on the combined source.
10. Packaging retains every managed manifest, adapter, manager module, and bilingual UI asset.
11. No project path is deleted; transient output stays under `aiTemp/`, and superseded retained material stays under `Trash/`.

## Release boundary

No rc.9 tag or installer is published until the exact combined source head passes the Linux contracts and the authoritative Windows package, installer migration, packaged-launcher, checksum, provenance, and remote asset-readback gates. Live provider/OAuth acceptance remains a manual, no-quota boundary and must not be represented as automated acceptance evidence.
