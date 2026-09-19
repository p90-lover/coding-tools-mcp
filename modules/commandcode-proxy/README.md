# CommandCode Proxy module

Coding Tools owns CommandCode Proxy as an **in-process handler**. `inspect` / `health` / `banner` read `modules/commandcode-proxy/source/` and `vendor/bundled/commandcode-proxy/` and do **not** probe `:9090` or `:3050`. Legacy loopback URLs are compatibility metadata only.

## Call

```js
await codingTools.apps.call({ moduleId: "commandcode-proxy", operation: "health" });
await codingTools.apps.call({ moduleId: "commandcode-proxy", operation: "plan", arguments: {} });
```

Operations: `inspect`, `start`, `stop`, `restart`, `repair`, `health`, `models`, `chatCompletions`, `plan`, `applyPlan`.

In-tree source for this lane lives at `modules/commandcode-proxy/source/` (`proxy.mjs`). Handlers stay in `handler.cjs` / `handlers.cjs` and register through the shared `modules/handler-registry.cjs`.
