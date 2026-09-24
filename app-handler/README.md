# Coding Tools app-handler

CPA, Codex Router, CommandCode Proxy, Paseo, and Anneal live under one tree: `app-handler/<app>/`. Coding Tools is the single host. **#224 / #228 (CommandCode / Paseo / Anneal) use this same root** via `app-handler/handler-registry.cjs`.

Handlers run **in-process**. The designed surface is `window.codingTools.apps`
(IPC); there is no separate apps HTTP listener. Handlers may call managed child
loopbacks (`:8317`, `:4202`, `:9090`, `:6768`, `:3000`, `:5173`) for real upstream
operations. Loading a handler or inspecting its bundled source does not prove
the upstream runtime is running. Consumers use the host API rather than wiring
their own unauthenticated calls to those ports.

```
app-handler/
  handler-registry.cjs   Shared registry: loads module.json + handler.cjs
  host.cjs               codingTools.apps list/catalog/call/invoke
  cpa/                   LOL slot — in-process CPA handlers + CT-hosted visual
  codex-router/          LOL slot — in-process Router handlers + CT-hosted Control Center chrome
  commandcode-proxy/     CommandCode handle (not app-handler/commandcode/) — shared with #224/#228
  paseo/                 shared with #224/#228
  anneal/                shared with #224/#228
```

Each folder has `module.json`, `handler.cjs` (`invoke`), and `handlers.cjs` (operation table). Visuals are **embedded inside the Coding Tools GUI** (iframe/webview in CT). Modules must not launch their own windows.

## Launch + visual manifest (`module.json`)

Everything Coding Tools needs to bring a module up and show it under **More**
is declared in the module's own `module.json`; nothing about ports, ordering,
ready timeouts or embed mode is hardcoded in `desktop-electron/electron`. The
normaliser and defaults live in [`lib/launch-manifest.cjs`](lib/launch-manifest.cjs).

```jsonc
"launch": {
  "order": 10,                 // tie-break after dependsOn (lower first)
  "autoStart": true,           // launch after the Coding Tools core is ready
  "startupPolicy": "auto",     // auto | installed-only | manual
  "installOnStartup": true,    // may install from the bundled payload on first run
  "dependsOn": ["cpa"],        // launched after these modules
  "requires": ["core-runtime"],
  "readyTimeoutMs": 45000      // how long the CT visual waits for the child
},
"visual": {
  "embed": "iframe",           // iframe | file | none
  "endpoint": "http://127.0.0.1:8317/",   // loopback only
  "manifest": "vendor/upstream/cpa.json", // sections + section paths
  "initialSection": "dashboard",
  "controls": ["module-lifecycle", "provider-oauth"],
  "icon": "providers",
  "navGroup": "more"
}
```

Runtime flow (`desktop-electron/electron/apps-launch.cjs`):

1. `handler-registry.launchOrder()` orders modules by `dependsOn` then `order`
   (currently `cpa → codex-router → commandcode-proxy → paseo → anneal`).
2. `main.cjs` waits for the core (runtime supervisor, browser host, provider
   network, bounded by 120 s) and only then runs one sequential managed
   bootstrap pass over the planned modules. Nothing app-related starts in the
   after-first-paint hook any more.
3. Per-module overrides (`autoStart`, `enabled`) and the outcome of every pass
   (`lastLaunch`: time, reason, status, app version, install state) are
   persisted in `<userData>/apps-config.json`, so a new build reads the shipped
   manifests plus the operator's saved choices instead of rediscovering them.
4. The renderer reads the same data through `codingTools.apps.list()`
   (`launchOrder`, `launch`, `visual`) and the launcher IPC
   (`appsLaunchSnapshot`, `runAppsLaunch`, `configureAppLaunch`,
   `onAppsLaunchChanged`).

Under **More**, every module renders through
[`IntegratedModuleSurface`](../desktop-electron/src/features/IntegratedModuleSurface.tsx):
the original upstream visual plus a **Coding Tools controls** tab built from
[`ModuleControlsPanel`](../desktop-electron/src/features/ModuleControlsPanel.tsx)
(auto-launch state and toggle, lifecycle, and the handler operations the module
exposes to Coding Tools).

PR #224/#228 add in-tree source under `app-handler/commandcode-proxy/source/`, `app-handler/paseo/source/`, and `app-handler/anneal/source/`. They share this registry. CPA and Codex Router also live here.

Temporary compatibility: repo-root `modules/` re-exports this tree so older simon asar packs that `require("../../modules/host.cjs")` keep working mid-cut.

## Attach map (Bot GG / Main seeker / hello)

One tree. Do not add a second `app-handler/` root. CommandCode’s folder/handle is `commandcode-proxy`.

| Handle | Folder | Handler entry | Host / IPC | CT visual |
| --- | --- | --- | --- | --- |
| `cpa` | [`app-handler/cpa/`](cpa/) | [`handler.cjs`](cpa/handler.cjs) → [`handlers.cjs`](cpa/handlers.cjs) | [`handler-registry.cjs`](handler-registry.cjs) `invoke("cpa", op, args, ctx)` · [`host.cjs`](host.cjs) `call`/`invoke` · preload `codingTools.apps` | More → CPA: [`IntegratedModuleSurface`](../desktop-electron/src/features/IntegratedModuleSurface.tsx) `toolId="cpa"` (management.html iframe) + controls `ModuleControlsPanel` · `ProviderCenterSurface focus="oauth"` |
| `codex-router` | [`app-handler/codex-router/`](codex-router/) | [`handler.cjs`](codex-router/handler.cjs) → [`handlers.cjs`](codex-router/handlers.cjs) | same registry/host; `FOREIGN_SLOTS` | More → Codex Router: `IntegratedModuleSurface toolId="codex-router"` (Control Center `dist/index.html` file URL; no second Electron window) + `ModuleControlsPanel` |
| `commandcode-proxy` | [`app-handler/commandcode-proxy/`](commandcode-proxy/) | [`handler.cjs`](commandcode-proxy/handler.cjs) → [`handlers.cjs`](commandcode-proxy/handlers.cjs) | same; aliases `banner`, `registration-plan`, `registration-apply` | More → CommandCode: `ModuleControlsPanel` stacked above [`CommandCodeHostSurface`](../desktop-electron/src/features/CommandCodeProxySurface.tsx) (`visual.embed: "none"`) |
| `paseo` | [`app-handler/paseo/`](paseo/) | [`handler.cjs`](paseo/handler.cjs) → [`handlers.cjs`](paseo/handlers.cjs) | same; `ctx.act` / lazy `ctx.getFiveStack` | More → Paseo: `IntegratedModuleSurface toolId="paseo"` + `ModuleControlsPanel` · [`PaseoOrchestratorSurface`](../desktop-electron/src/features/PaseoOrchestratorSurface.tsx) |
| `anneal` | [`app-handler/anneal/`](anneal/) | [`handler.cjs`](anneal/handler.cjs) → [`handlers.cjs`](anneal/handlers.cjs) | same; aliases `board`, `activity`, `task-start`, `inbox_decision` / `inbox_reply` / `inbox_close` | More → Anneal: `IntegratedModuleSurface toolId="anneal"` (visual origin `:5173`) + `ModuleControlsPanel` · [`AnnealTasksSurface`](../desktop-electron/src/features/AnnealTasksSurface.tsx) |

Shared call path (in-process, no new ports):

```js
window.codingTools.apps.invoke({ handle: "<id>", operation: "inspect" })
window.codingTools.apps.call({ moduleId: "<id>", operation: "start" })
```

IPC channels (registered before first paint): `coding-tools:apps:list`, `coding-tools:apps:catalog`, `coding-tools:apps:call`. `apps.invoke` is the same channel (`handle` → `moduleId`).

Startup stays freeze-safe: `launcher:browser-surface-active` is deferred; five-stack is `createLazyFactory(() => createFiveStackControlPlane(...))`; managed `peerEnv` uses a reentry guard so registerIpc/ready does not recurse.

## How to call (in-process)

```js
const apps = window.codingTools.apps;
await apps.list();
await apps.catalog();
await apps.call({ moduleId: "cpa", operation: "inspect" });
await apps.invoke({
  handle: "paseo",
  operation: "send",
  arguments: { agentId: "agent-1", text: "ping" },
});
```

The in-process host accepts both the contract object and positional forms:

```js
await host.call({ moduleId: "commandcode-proxy", operation: "health" });
await host.call("commandcode-proxy", "health");
```

IPC (before first paint): `coding-tools:apps:list`, `catalog`, `call`. `invoke` is the same in-process channel (`handle` maps to `moduleId`). There is no apps HTTP listener.

Desktop MCP/shell tools map onto the same host (no loopback-port overlay):

| MCP tool | Maps to |
| --- | --- |
| `apps_list` | `codingTools.apps.list()` |
| `apps_catalog` | `codingTools.apps.catalog()` |
| `apps_call` | `codingTools.apps.call({ moduleId, operation, arguments })` |
| `apps_invoke` | `codingTools.apps.invoke({ handle, operation, arguments })` |
| `apps_status` | inspect-only ready report (`listening: false`, no dedicated ports) |

`apps_status` never starts children and never opens listen ports. Treat its
source-inspection result separately from upstream health. Task/model operations
can require the managed child and must report failures rather than fake data.

## Operations

| Module | Lifecycle | Meaningful functions |
| --- | --- | --- |
| `cpa` | inspect/start/stop/restart/repair/install | health, models, chatCompletions, managementHealth, listProviders, linkProvider, unlinkProvider, providerStatus, authFiles, authFileModels, oauthStart, oauthStatus, oauthCancel, plugins, pluginStore |
| `codex-router` | same | health, models, chatCompletions, sync |
| `commandcode-proxy` | same | health, models, banner, plan, applyPlan, registration-plan, registration-apply |
| `paseo` | same | send, resume, cancel, archive, permission, create, plan, run, submitResult, review |
| `anneal` | same | listTasks/board, preview/activity, create, startTask/task-start, retry, hold, resume, archive, unarchive, inboxDecision/inbox_decision, inbox_reply, inbox_close, openFromReview |

## Visuals

CT hosts original chrome in-app: CPA management panel, Codex Router Control Center `dist/index.html` (file URL, not a second Electron window), Paseo web UI, Anneal board (`:5173` visual origin). Handlers power those screens.

## Network

Claude/Anthropic traffic uses ProxyBridge `http://127.0.0.1:17891` (SOCKS/proxy inherit). Direct is not a supported path for that family.

## Packaged layout (offline / preferLocal / noDownload)

Electron Builder copies this tree twice next to `app.asar`:

- `resources/app-handler/` — canonical. Packaged `electron/main.cjs` does `require("../../app-handler/host.cjs")`.
- `resources/app-modules/` — simon/offline alias of the same files.
- `resources/modules/` — temporary re-export shims to `../app-handler/` for mid-cut local packs.

Do **not** git-clone or download handlers at runtime. `preferLocal` / `noDownload` means use the extraResources payload already in the installer. Five-stack Start still uses bundled-source (`skipNetworkPrepare`); that is separate from `codingTools.apps`.

Asar-only renderer patches are not enough: copy this tree into `resources/app-handler` (and `resources/app-modules`). Keep `resources/modules` shims if an older asar still requires `../../modules/host.cjs`.

## Anneal / Postgres

If Postgres is down, Anneal handlers return `{ ok: false, unavailable: true, dependency: "postgres" }`. The Coding Tools shell stays up.
