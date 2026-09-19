# Coding Tools modules

CPA, Codex Router, CommandCode Proxy, Paseo, and Anneal live under one tree: `modules/<app>/`. Coding Tools is the single host. **#224 (CommandCode / Paseo / Anneal) uses this same root** via `modules/handler-registry.cjs`.

Handlers run **in-process**. The designed surface is `window.codingTools.apps` (IPC). **Do not open extra listen ports** for these modules. Existing child loopbacks (`:8317`, `:4202`, `:9090`, `:6768`, `:3000`, `:5173`) are legacy compatibility only so already-running managed children can keep their sockets; consumers must not be told to hit those ports.

```
modules/
  handler-registry.cjs   Shared registry: loads module.json + handler.cjs
  host.cjs               codingTools.apps list/catalog/call/invoke
  cpa/                   LOL slot — in-process CPA handlers + CT-hosted visual
  codex-router/          LOL slot — in-process Router handlers + CT-hosted Control Center chrome
  commandcode-proxy/     shared with #224
  paseo/                 shared with #224
  anneal/                shared with #224
```

Each folder has `module.json`, `handler.cjs` (`invoke`), and `handlers.cjs` (operation table). Visuals are **embedded inside the Coding Tools GUI** (iframe/webview in CT). Modules must not launch their own windows.

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

IPC (before first paint): `coding-tools:apps:list`, `catalog`, `call`. `invoke` is the same in-process channel (`handle` maps to `moduleId`). There is no apps HTTP listener.

Desktop MCP/shell tools map onto the same host (no loopback-port overlay):

| MCP tool | Maps to |
| --- | --- |
| `apps_list` | `codingTools.apps.list()` |
| `apps_catalog` | `codingTools.apps.catalog()` |
| `apps_call` | `codingTools.apps.call({ moduleId, operation, arguments })` |
| `apps_invoke` | `codingTools.apps.invoke({ handle, operation, arguments })` |
| `apps_status` | inspect-only ready report (`listening: false`, no dedicated ports) |

`apps_status` never starts children and never opens listen ports. Temporary child loopbacks remain smoke-only.

## Operations

| Module | Lifecycle | Meaningful functions |
| --- | --- | --- |
| `cpa` | inspect/start/stop/restart/repair/install | health, models, chatCompletions, managementHealth |
| `codex-router` | same | health, models, chatCompletions, sync |
| `commandcode-proxy` | same | health, models, banner, plan, applyPlan, registration-plan, registration-apply |
| `paseo` | same | send, resume, cancel, archive, permission, create, plan, run, submitResult, review |
| `anneal` | same | listTasks/board, preview/activity, create, startTask/task-start, retry, hold, resume, archive, unarchive, inboxDecision/inbox_decision, inbox_reply, inbox_close, openFromReview |

## Visuals

CT hosts original chrome in-app: CPA management panel, Codex Router Control Center `dist/index.html` (file URL, not a second Electron window), Paseo web UI, Anneal board (`:5173` visual origin). Handlers power those screens.

## Network

Claude/Anthropic traffic uses ProxyBridge `http://127.0.0.1:17891` (SOCKS/proxy inherit). Direct is not a supported path for that family.

## Anneal / Postgres

If Postgres is down, Anneal handlers return `{ ok: false, unavailable: true, dependency: "postgres" }`. The Coding Tools shell stays up.
