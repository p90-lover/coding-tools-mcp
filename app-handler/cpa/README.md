# CPA module

Coding Tools owns CPA as a **managed child** on `http://127.0.0.1:8317/`. Consumers call Coding Tools APIs; they do not launch the CLIProxyAPI management window.

## Call

```js
await codingTools.apps.call({ moduleId: "cpa", operation: "inspect" });
await codingTools.apps.call({ moduleId: "cpa", operation: "models" });
await codingTools.apps.call({ moduleId: "cpa", operation: "listProviders" });
await codingTools.apps.call({
  moduleId: "cpa",
  operation: "linkProvider",
  arguments: { providerId: "claude-oauth", label: "Claude", auth: "oauth", enabled: true },
});
await codingTools.apps.call({
  moduleId: "cpa",
  operation: "chatCompletions",
  arguments: { model: "gpt-4o-mini", messages: [{ role: "user", content: "ping" }] },
});
```

Loopback HTTP is owned by the managed child. An enabled, already-installed CPA
starts after the desktop's first paint; startup does not download a missing CPA.
There is no separate apps HTTP listener.

## Embedded panel login

The desktop authenticates its CPA management iframe automatically. No key-copy
step is needed when opening CPA or Runtime OAuth. The panel's upstream auth
store receives a per-window opaque marker, not the management key. The main
process substitutes the managed key only for that window's CPA management
requests, from the exact management iframe to the configured loopback origin.
Other pages, windows, and origins do not receive the credential.

This signs in to the **local management console**, not to provider accounts.
Existing provider sessions stay with CPA; expired or new provider OAuth sessions
still require the user's authorization. Explicitly disabled CPA stays disabled.

Operations: `inspect`, `start`, `stop`, `restart`, `repair`, `install`, `health`, `models`, `chatCompletions`, `managementHealth`, `listProviders` (`providers`), `linkProvider`, `unlinkProvider`, `providerStatus`.

## Authenticated management API

The same host also exposes `authFiles`, `authFileModels`, `oauthStart`,
`oauthStatus`, `oauthCancel`, `plugins`, and `pluginStore`. Discover operations
and their read/write classification with `codingTools.apps.catalog()`.

```js
const files = await codingTools.apps.call({ moduleId: "cpa", operation: "authFiles" });
const models = await codingTools.apps.call({
  moduleId: "cpa", operation: "authFileModels", arguments: { name: "account.json" },
});
const login = await codingTools.apps.call({
  moduleId: "cpa", operation: "oauthStart", arguments: { provider: "codex" },
});
if (!login.ok) throw new Error(login.result.reason);
// Present login.result.url for the user to open and approve sign-in.
const progress = await codingTools.apps.call({
  moduleId: "cpa", operation: "oauthStatus", arguments: { state: login.result.state },
});
```

OAuth providers currently supported by this handler are `codex`, `anthropic`,
and `antigravity`. Gemini auth-file import remains in the existing provider
adapter. OAuth completion does not by itself create a Coding Tools provider
binding: use `linkProvider` and `providerStatus` to select and verify that account.
Starting/cancelling OAuth is a write operation and requires the host's normal
approval boundary. Management credentials are resolved in the main process;
callers cannot select arbitrary management URLs. Plugin operations are read-only;
installation/execution is intentionally not exposed here.

`models` uses the in-process handler with the managed CPA proxy API key. When the auth-dir is empty or provider-network accounts are disabled/archived it returns `{ ok: false, models: [], reason }` instead of a fake catalog. After a provider is linked and connected, `/v1/models` (via the handler) returns that catalog.

Claude/Anthropic egress stays on ProxyBridge `http://127.0.0.1:17891` (SOCKS/proxy inherit). Direct is not a supported path for that family.
