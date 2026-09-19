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

Loopback HTTP is started by Coding Tools as a managed child, never at UI bootstrap, and is **not** the product surface. There is no apps HTTP listener.

Operations: `inspect`, `start`, `stop`, `restart`, `repair`, `install`, `health`, `models`, `chatCompletions`, `managementHealth`, `listProviders` (`providers`), `linkProvider`, `unlinkProvider`, `providerStatus`.

`models` uses the in-process handler with the managed CPA proxy API key. When the auth-dir is empty or provider-network accounts are disabled/archived it returns `{ ok: false, models: [], reason }` instead of a fake catalog. After a provider is linked and connected, `/v1/models` (via the handler) returns that catalog.

Claude/Anthropic egress stays on ProxyBridge `http://127.0.0.1:17891` (SOCKS/proxy inherit). Direct is not a supported path for that family.
