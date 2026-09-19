# Paseo module

Coding Tools owns Paseo as an **in-process handler**. `inspect` / `plan` use bundled module source and do **not** require `:6768` or a ready five-stack control plane. Protocol `send`/`run` soft-fail when the daemon is not started. Drive it through `codingTools.apps`; do not open the Paseo web app as the integration path.

## Call

```js
await codingTools.apps.call({ moduleId: "paseo", operation: "inspect" });
await codingTools.apps.call({
  moduleId: "paseo",
  operation: "send",
  arguments: { agentId: "agent-1", text: "ping" },
});
await codingTools.apps.call({
  moduleId: "paseo",
  operation: "plan",
  arguments: { brief: "Reproduce login", workspaceId: "ws-1" },
});
```

Protocol operations: `send`, `resume`, `cancel`, `archive`, `permission`, `create`.
Five-stack: `plan`, `run`, `submitResult`, `review`.

In-tree source pointer: `app-handler/paseo/source/`. Handlers stay in this folder’s `handler.cjs` / `handlers.cjs` and load through the shared `app-handler/handler-registry.cjs`.
