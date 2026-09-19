# CPA module

Coding Tools owns CPA as an **in-process** `codingTools.apps` handle. The Settings / 原始介面 / CPA panel render inside the Coding Tools GUI and call `inspect`, `listProviders`, `models`, `managementHealth`, and `providerStatus` without opening a window or binding `:8317`.

The optional CLIProxyAPI child on `http://127.0.0.1:8317/` is only for live proxy traffic. Opening the panel must not Start that process, must not download it, and must not fetch `management.html`.

## Call

```js
await codingTools.apps.invoke({ handle: "cpa", operation: "inspect" });
await codingTools.apps.invoke({ handle: "cpa", operation: "models" });
await codingTools.apps.invoke({ handle: "cpa", operation: "listProviders" });
await codingTools.apps.call({
  moduleId: "cpa",
  operation: "linkProvider",
  arguments: { providerId: "claude-oauth", label: "Claude", auth: "oauth", enabled: true },
});
```

`inspect` and `managementHealth` stay in-process (`listening: false`). `models` reads provider-network first when the optional proxy is down. `chatCompletions` still needs the proxy process.

There is no apps HTTP listener.

Operations: `inspect`, `start`, `stop`, `restart`, `repair`, `install`, `health`, `models`, `chatCompletions`, `managementHealth`, `listProviders` (`providers`), `linkProvider`, `unlinkProvider`, `providerStatus`.

Do **not** unlink or mutate Antigravity OAuth accounts from this panel.

Claude/Anthropic egress stays on ProxyBridge `http://127.0.0.1:17891` (SOCKS/proxy inherit). Direct is not a supported path for that family.
