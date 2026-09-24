# Anneal module

Coding Tools owns Anneal through an **in-process handler**. `inspect` describes
the bundled source; it is not a running-service health check. `board` and
`listTasks` call the managed Anneal API and return real tasks, not a hardcoded
empty list. Drive these operations through `codingTools.apps`. The Runtime
Tasks tab hosts the original Anneal board, with separate Coding Tools controls.

Anneal reads and mutations require its running backend and may require
Postgres. If the database is down, handlers return
`{ ok: false, softFail: true, unavailable: true, dependency: "postgres" }`
instead of crashing the Coding Tools shell. If no runtime adapter is installed,
the dependency is `anneal-runtime`. `activity` reads `/tasks/{id}/activity`,
not the task preview endpoint.

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

In-tree source pointer: `app-handler/anneal/source/`. Handlers stay in this folder’s `handler.cjs` / `handlers.cjs` and load through the shared `app-handler/handler-registry.cjs`. Postgres outages soft-fail; they must not freeze Coding Tools.
