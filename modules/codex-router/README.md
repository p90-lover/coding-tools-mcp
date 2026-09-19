# Codex Router module

Coding Tools owns Codex Router as a **managed child** on `http://127.0.0.1:4202/`. The standalone Control Center Electron window is **not** the integration path. CT hosts `apps/control-center/dist/index.html` as a file URL inside the Coding Tools GUI.

## Call

```js
await codingTools.apps.call({ moduleId: "codex-router", operation: "inspect" });
await codingTools.apps.call({ moduleId: "codex-router", operation: "sync" });
await codingTools.apps.call({ moduleId: "codex-router", operation: "models" });
await codingTools.apps.call({
  moduleId: "codex-router",
  operation: "chatCompletions",
  arguments: { model: "gpt-4o-mini", messages: [{ role: "user", content: "ping" }] },
});
```

Operations: `inspect`, `start`, `stop`, `restart`, `repair`, `install`, `sync`, `health`, `models`, `chatCompletions`.

`models`, `health`, and `chatCompletions` authenticate with the in-process caller secret (`/_codex-router/{callerKey}/v1/...`). The secret is never returned on the `codingTools.apps` surface. An empty catalog returns `{ ok: false, models: [], reason }` until `sync` has populated models.
