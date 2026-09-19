# CPA module

Coding Tools owns CPA as a **managed child** on `http://127.0.0.1:8317/`. Consumers call Coding Tools APIs; they do not launch the CLIProxyAPI management window.

## Call

```js
await codingTools.apps.call({ moduleId: "cpa", operation: "inspect" });
await codingTools.apps.call({ moduleId: "cpa", operation: "models" });
await codingTools.apps.call({
  moduleId: "cpa",
  operation: "chatCompletions",
  arguments: { model: "gpt-4o-mini", messages: [{ role: "user", content: "ping" }] },
});
```

Loopback HTTP (optional, started by Coding Tools, never at UI bootstrap):

`POST http://127.0.0.1:<apps-port>/api/v1/apps/call`

Operations: `inspect`, `start`, `stop`, `restart`, `repair`, `health`, `models`, `chatCompletions`, `managementHealth`.

Claude/Anthropic egress stays on ProxyBridge `http://127.0.0.1:17891` (SOCKS/proxy inherit). Direct is not a supported path for that family.
