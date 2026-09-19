# CommandCode Proxy module

Coding Tools owns CommandCode Proxy as a **managed child** on `http://127.0.0.1:9090/`.

## Call

```js
await codingTools.apps.call({ moduleId: "commandcode-proxy", operation: "health" });
await codingTools.apps.call({ moduleId: "commandcode-proxy", operation: "plan", arguments: {} });
```

Operations: `inspect`, `start`, `stop`, `restart`, `repair`, `health`, `models`, `chatCompletions`, `plan`, `applyPlan`.

In-tree source for this lane lives at `modules/commandcode-proxy/source/` (`proxy.mjs`). Handlers stay in `handler.cjs` / `handlers.cjs` and register through the shared `modules/handler-registry.cjs`.
