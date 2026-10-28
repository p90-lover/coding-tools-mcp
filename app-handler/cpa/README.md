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

Operations: `inspect`, `start`, `stop`, `restart`, `repair`, `install`, `health`, `models`, `chatCompletions`, `managementHealth`, `listProviders` (`providers`), `linkProvider`, `unlinkProvider`, `providerStatus`, `checkUpdate`, `update`.

## Updates

CPA follows its upstream releases (`router-for-me/CLIProxyAPI`) instead of staying on the version the installer bundles:

- **Download:** every 6 hours the app downloads the newest release, checks it against the release's `checksums.txt`, and installs it into `components/cpa/<version>/` beside the running CPA.
- **Switch:** switching restarts CPA, so it waits for a quiet moment: no chat turn running, and CPA idle for 5 minutes by its usage log. Without that log, it waits for the next app start. The next start switches through the same health check.
- **Health check:** a version that fails its health check rolls back and is never tried again. Starts after that run the last version that passed, which may be an earlier update.
- **Opting out:** set `automaticComponentUpdates: false` in the launcher state to stop automatic updates.

```js
await codingTools.apps.call({ moduleId: "cpa", operation: "checkUpdate" });
// → { current: "8.0.32", latest: "8.0.46", available: true, ... }
await codingTools.apps.call({ moduleId: "cpa", operation: "update" });
// → { staged: true, swapped: true, from: "8.0.32", to: "8.0.46" } (or rolledBack: true, error)
await codingTools.apps.call({ moduleId: "cpa", operation: "update", arguments: { swap: false } });
// installs only; the next start (or a quiet moment) switches
```

`models` uses the in-process handler with the managed CPA proxy API key. When the auth-dir is empty or provider-network accounts are disabled/archived it returns `{ ok: false, models: [], reason }` instead of a fake catalog. After a provider is linked and connected, `/v1/models` (via the handler) returns that catalog.

Claude/Anthropic egress stays on ProxyBridge `http://127.0.0.1:17891` (SOCKS/proxy inherit). Direct is not a supported path for that family.
