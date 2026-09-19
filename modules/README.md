# Coding Tools modules

CPA, Codex Router, CommandCode Proxy, Paseo, and Anneal are **modules inside Coding Tools**. Coding Tools is the single host. Consumers call Coding Tools APIs; they do not launch each app’s standalone GUI.

```
modules/
  cpa/                 CLIProxyAPI — OpenAI-compat loopback :8317
  codex-router/        Codex Router — OpenAI-compat loopback :4202
  commandcode-proxy/   CommandCode Proxy — OpenAI-compat loopback :9090
  paseo/               Paseo orchestrator — HTTP/WS :6768
  anneal/              Anneal tasks — API :3000 (web :5173 is not the integration path)
  host.cjs             Coding Tools apps host (IPC + optional loopback HTTP)
  lib/                 Shared loopback client, lifecycle, sanitizer
```

Runtimes stay **managed child services** owned by Coding Tools (bundled five-stack / managed-components). Each folder here is the Coding Tools adapter: handlers, operation catalog, and loopback client. Source is adapted as needed rather than shipping a second standalone app tree.

## How to call

Renderer / preload (`window.codingTools`, same contract style as `codingTools.tools`):

```js
const apps = window.codingTools.apps;
await apps.list();
await apps.catalog();
await apps.call({ moduleId: "cpa", operation: "inspect" });
await apps.call({
  moduleId: "paseo",
  operation: "send",
  arguments: { agentId: "agent-1", text: "ping" },
});
```

IPC channels (registered with the rest of the Coding Tools shell, before first paint):

- `coding-tools:apps:list`
- `coding-tools:apps:catalog`
- `coding-tools:apps:call`

Optional loopback HTTP is **not** started at UI bootstrap. Tests or an explicit host call can bind `127.0.0.1` only:

- `GET /api/v1/apps`
- `GET /api/v1/apps/catalog`
- `POST /api/v1/apps/call` with `{ "moduleId", "operation", "arguments" }`

## Operations

| Module | Lifecycle | Meaningful functions |
| --- | --- | --- |
| `cpa` | inspect/start/stop/restart/repair | health, models, chatCompletions, managementHealth |
| `codex-router` | same | health, models, chatCompletions, sync |
| `commandcode-proxy` | same | health, models, chatCompletions, plan, applyPlan |
| `paseo` | same | send, resume, cancel, archive, permission, create, plan, run, submitResult, review |
| `anneal` | same | listTasks, preview, create, startTask, retry, hold, resume, archive, unarchive, inboxDecision, openFromReview |

Each per-module folder has a README with copy-paste `codingTools.apps.call` examples.

## Network

Claude/Anthropic traffic uses ProxyBridge `http://127.0.0.1:17891` (SOCKS/proxy inherit). Direct is not a supported path for that family.

## Anneal / Postgres

If Postgres is down, Anneal handlers return `{ ok: false, unavailable: true, dependency: "postgres" }`. The Coding Tools shell stays up.
