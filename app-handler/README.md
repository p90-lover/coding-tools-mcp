# Coding Tools app-handler

`app-handler/` hosts the active in-process CPA and agent-orchestrator APIs. `handler-registry.cjs` loads their `module.json` and `handler.cjs` files; `host.cjs` exposes `window.codingTools.apps` through IPC. Other retained handler sources are outside the active app catalog.

CommandCode Go and CommandCode Studio run as CPA plugins under `desktop-electron/vendor/cpa-plugins/`. Their OAuth login and auth files belong to CPA. The managed CPA process copies the pinned plugin binaries into its state directory before startup. No standalone CommandCode handler or listener is packaged.

```js
const apps = window.codingTools.apps;
await apps.list();
await apps.call({ moduleId: "cpa", operation: "inspect" });
```

The renderer uses `coding-tools:apps:list`, `coding-tools:apps:catalog`, and `coding-tools:apps:call`. Packaged active handlers are copied next to `app.asar`; they are not downloaded at runtime.
