# Codex Router module

Coding Tools owns Codex Router as a **managed child** on `http://127.0.0.1:4202/`. The standalone Control Center Electron window is **not** the integration path.

## Call

```js
await codingTools.apps.call({ moduleId: "codex-router", operation: "inspect" });
await codingTools.apps.call({ moduleId: "codex-router", operation: "sync" });
await codingTools.apps.call({ moduleId: "codex-router", operation: "models" });
```

Operations: `inspect`, `start`, `stop`, `restart`, `repair`, `sync`, `health`, `models`, `chatCompletions`.
