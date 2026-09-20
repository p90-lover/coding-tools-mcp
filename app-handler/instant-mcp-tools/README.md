# Instant MCP Tools module

Handler id / module id: **`instant-mcp-tools`**.

Coding Tools owns Instant MCP Tools (即時 MCP 工具) as an **in-process handler**. Ready means `inspect` / `catalog` — not an open-port Start, and not a dedicated listen port. The panel talks to `codingTools.apps`; it does not download a runtime and does not iframe an external MCP host.

## Call (for LOL panel embed)

LOL typed stub (#235) uses kebab-case. CamelCase stays for backwards compatibility.

```js
await codingTools.apps.call({ moduleId: "instant-mcp-tools", operation: "inspect" });
await codingTools.apps.call({ moduleId: "instant-mcp-tools", operation: "listWorkspaces" });
await codingTools.apps.call({
  moduleId: "instant-mcp-tools",
  operation: "list-tools", // alias of listTools
  arguments: { workspaceId: "ws-1" }, // optional
});
await codingTools.apps.invoke({
  handle: "instant-mcp-tools",
  operation: "run-tool", // alias of runTool
  arguments: {
    workspaceId: "ws-1", // optional for in-process apps_* tools
    tool: "apps_list",
    arguments: {},
  },
});
```

CamelCase remains valid:

```js
await codingTools.apps.call({
  moduleId: "instant-mcp-tools",
  operation: "listTools",
  arguments: { workspaceId: "ws-1" },
});
await codingTools.apps.invoke({
  handle: "instant-mcp-tools",
  operation: "runTool",
  arguments: { tool: "apps_list", arguments: {} },
});
```

`invoke` is the same in-process channel (`handle` → `moduleId`). There is no apps HTTP listener.

## `codingTools.apps` operations

| Operation | Alias | readOnly | Arguments | Result |
| --- | --- | --- | --- | --- |
| `inspect` | — | yes | `{}` | `{ ok, status: "ready", listening: false, dedicatedListenPort: false, startRequired: false, transport: "in-process" }` |
| `listTools` | `list-tools`, `tools` | yes | `{ workspaceId?: string }` | `{ ok, tools: [{ name, description?, readOnly?, via? }], count, workspaceId, headlessUnavailable?, fiveStackUnavailable?, listening: false }` |
| `runTool` | `run-tool`, `callTool` | no | `{ tool: string, arguments?: object, workspaceId?: string, requestId?: string }` | `{ ok, tool, result, reason?, softFail?, listening: false }` |
| `listWorkspaces` | — | yes | `{}` | `{ ok, items: [{ id, name, path, mcpState, policyRevision }], nextCursor, headlessUnavailable? }` |
| `catalog` / `list` | host-level | yes | — | Module appears in `codingTools.apps.list()` / `.catalog()` |
| `start` / `stop` / `restart` / `repair` / `install` | — | no | `{}` | No-op ready. Do **not** treat these as a required Start button. |

Prefer kebab-case `list-tools` / `run-tool` for new panel embeds (PR #235). `listTools` / `runTool` remain. `listTools` / `list-tools` is the MCP page tool list (`apps_list` overlay + five-stack + workspace catalog). `runTool` / `run-tool` is the MCP page **執行工具** / Run tool control with JSON params.

When underlying MCP / headless servers are down, `listTools` still returns in-process `apps_*` tools when the overlay is present, and otherwise `{ ok: true, tools: [], softFail hints }`. `runTool` returns `{ ok: false, softFail: true, unavailable: true, reason }` instead of throwing. Never require a dedicated listen port for this API.

## Transport

- preferLocal / offline / bundled: `app-handler/instant-mcp-tools/` ships in `resources/app-handler` and `resources/app-modules`.
- No download-to-use.
- No `:port` product surface.
