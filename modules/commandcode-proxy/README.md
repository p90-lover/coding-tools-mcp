# CommandCode Proxy module

Canonical handlers live at [`app-handler/commandcode-proxy/`](../../app-handler/commandcode-proxy/). This file is a compatibility stub so `modules/commandcode-proxy/README.md` is not deleted.

Coding Tools owns CommandCode Proxy as an **in-process handler**. `inspect` / `health` / `banner` read `app-handler/commandcode-proxy/source/` and `vendor/bundled/commandcode-proxy/` and do **not** probe `:9090` or `:3050`. Legacy loopback URLs are compatibility metadata only.

## Call

```js
await codingTools.apps.call({ moduleId: "commandcode-proxy", operation: "health" });
await codingTools.apps.call({ moduleId: "commandcode-proxy", operation: "plan", arguments: {} });
```

Operations: `inspect`, `start`, `stop`, `restart`, `repair`, `health`, `models`, `chatCompletions`, `plan`, `applyPlan`.

In-tree source for this lane lives at `app-handler/commandcode-proxy/source/` (`proxy.mjs`). Handlers stay in `handler.cjs` / `handlers.cjs` and register through the shared `app-handler/handler-registry.cjs`.
