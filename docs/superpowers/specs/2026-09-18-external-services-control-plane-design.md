# External Services Control Plane Design

## Goal

Implement architecture **B**: Codex Router, CommandCode Proxy, Paseo, and Anneal remain separately installed local services, while Coding Tools becomes the single desktop control plane for configuration, lifecycle, health, browser-backed login, CPA/Provider Hub account routing, and diagnostics.

## Current gaps

- Codex Router is configured only through environment variables and external CLI commands.
- Paseo and Anneal require environment-provided source directories and expose no persistent GUI launch configuration.
- CommandCode exists in Provider Hub, but its local proxy runtime is not represented alongside the other managed services.
- Provider bootstrap initializes with `getBrowserHost: () => null`, so Codex OAuth and ChatGPT Web login cannot use the real BrowserHost.
- Service endpoints and launch settings are process-local rather than persisted.
- Electron Builder can auto-enter publication mode when `GITHUB_TOKEN` is present; packaging must explicitly use `--publish never` because publication is handled by the exact-source release publisher.

## Architecture

### 1. External service controller

Add `desktop-electron/electron/external-services.cjs` as the single main-process owner for four service records:

- `codex-router`
- `commandcode-proxy`
- `paseo`
- `anneal`

Each record persists non-secret configuration under the launcher user-data directory: loopback endpoint, source/home directory, executable, argument vector, enabled flag, and auto-start flag. Service secrets such as the Codex Router caller key are encrypted with Electron `safeStorage`, with the repository's existing private-file AES fallback pattern when platform encryption is unavailable.

The controller exposes bounded methods: `snapshot`, `configure`, `inspect`, `start`, `stop`, `restart`, `syncCodexRouter`, and `dispose`. It never accepts shell command strings; launch commands are executable plus argument arrays. Endpoints must resolve to `127.0.0.1`, `localhost`, or `[::1]`.

### 2. Compatibility with Paseo and Anneal

The existing upstream controller remains the execution adapter for embedded Paseo and Anneal pages. It receives its endpoint, home, executable, and arguments from the persisted external-service controller rather than only from environment variables. Existing upstream manifests remain pinned and licensed. Externally running services continue to work without being owned by Coding Tools; start/stop controls apply only to processes launched by Coding Tools.

### 3. CPA / Provider Hub authority

Provider Hub remains the only account, model, credential, fallback, and proxy policy store used by Coding Tools. CommandCode accounts continue to use browser OAuth or CLI-session import, encrypted in the Electron main process. Paseo and Anneal dispatch continue to resolve through `providerExecutionPlan` and include the selected Provider Hub account.

Fix the browser bridge by making Provider Network's `getBrowserHost` callback mutable and assigning the real BrowserHost after it is ready. No renderer receives OAuth tokens or provider secrets.

### 4. Codex Router integration

The GUI stores Codex Router endpoint, caller key, router CLI path, and model-curation CLI path. Health inspection calls the protected `/models` route. The sync operation invokes the packaged `codex-chatgpt-web router integrate --apply` command, registering Coding Tools Web and the configured CommandCode Proxy without exposing credentials in logs or renderer state. Conflicting provider descriptors remain fail-closed.

### 5. GUI

Add an `Integrations` surface with one status row per subsystem:

- CPA Provider Hub: account/provider counts and link to Provider Center.
- Codex Router: endpoint, caller-key state, CLI configuration, health, and sync.
- CommandCode Proxy: endpoint, account/model counts, lifecycle and link to Provider Center.
- Paseo and Anneal: endpoint, local source/home, executable/arguments, health and lifecycle controls, plus links to their full tabs.

All visible copy is provided in English and Traditional Chinese. The Browser native view is hidden whenever the Integrations surface is active.

### 6. Release safety

Electron packaging is forced to `--publish never`. The exact-source release runner remains the sole publisher and continues to generate checksums, provenance, and validation evidence. No project file, branch, retained evidence, or user configuration is deleted; transient material remains under `aiTemp/` and `aiTemp/Trash/`.

## Acceptance criteria

1. The app can persist, inspect, start, stop, and restart each external service from the GUI.
2. Externally started services are detected and can be opened without Coding Tools claiming ownership of their process.
3. Codex OAuth and ChatGPT Web login use the real BrowserHost.
4. CommandCode login/session import remains encrypted and its account/model totals appear in the unified control plane.
5. Paseo and Anneal dispatch use the selected Provider Hub account and workload-scoped proxy plan.
6. Codex Router sync is explicit, bounded, and secret-safe.
7. TypeScript, syntax, focused contracts, production renderer build, package build, and packaged smoke tests pass.
8. Electron Builder does not try to publish or infer an update channel during package creation.
