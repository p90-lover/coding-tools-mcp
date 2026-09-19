# Anneal module

Coding Tools owns Anneal as an **in-process handler**. `inspect` / `board` / `listTasks` read bundled module state and do **not** probe `:3000` or `:5173`. Drive it through `codingTools.apps`. The original board is not the integration path.

Anneal mutations may require Postgres. If the database is down, handlers return `{ ok: false, softFail: true, unavailable: true, dependency: "postgres" }` instead of crashing the Coding Tools shell.

## Call

```js
await codingTools.apps.call({ moduleId: "anneal", operation: "inspect" });
await codingTools.apps.call({
  moduleId: "anneal",
  operation: "create",
  arguments: { projectId: "proj-1", name: "From Paseo review" },
});
```

Operations: `inspect`, `start`, `stop`, `restart`, `repair`, `listTasks`, `preview`, `create`, `startTask`, `retry`, `hold`, `resume`, `archive`, `unarchive`, `inboxDecision`, `openFromReview`.

In-tree source pointer: `modules/anneal/source/`. Handlers stay in this folder’s `handler.cjs` / `handlers.cjs` and load through the shared `modules/handler-registry.cjs`. Postgres outages soft-fail; they must not freeze Coding Tools.
