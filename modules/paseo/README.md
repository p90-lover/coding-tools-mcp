# Paseo module

Coding Tools owns Paseo as a **managed child** (`http://127.0.0.1:6768/`, `ws://127.0.0.1:6768/ws`). Drive it through `codingTools.apps`; do not open the Paseo web app as the integration path.

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

In-tree source pointer: `modules/paseo/source/`. Handlers stay in this folder’s `handler.cjs` / `handlers.cjs` and load through the shared `modules/handler-registry.cjs`.
