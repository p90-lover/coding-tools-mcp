# Instant MCP Tools — in-process `codingTools.apps`

Follow-up on CPA PR #234 (`cursor/cpa-in-process-panel-f630`). Instant MCP Tools (即時 MCP 工具) is a Coding Tools managed in-process app. The control surface is `codingTools.apps`, not a dedicated listen port.

## IDs for LOL

| Field | Value |
| --- | --- |
| Handler id | `instant-mcp-tools` |
| Module id / handle | `instant-mcp-tools` |
| Host | `window.codingTools.apps` |
| IPC | `coding-tools:apps:list` / `catalog` / `call` (`invoke` uses the same `call` channel; `handle` → `moduleId`) |

## Operations

| `operation` | Alias | JSON `arguments` |
| --- | --- | --- |
| `inspect` | — | `{}` |
| `listTools` | `tools` | `{ "workspaceId"?: string }` |
| `runTool` | `callTool` | `{ "tool": string, "arguments"?: object, "workspaceId"?: string, "requestId"?: string }` |
| `listWorkspaces` | — | `{}` |

Host-level: `codingTools.apps.list()` / `.catalog()` include this module. Ready = `inspect` / `catalog`. Do not add a Start button or bind a panel port.

```js
await codingTools.apps.invoke({
  handle: "instant-mcp-tools",
  operation: "listTools",
  arguments: { workspaceId: "ws-1" },
});
await codingTools.apps.invoke({
  handle: "instant-mcp-tools",
  operation: "runTool",
  arguments: { tool: "apps_list", arguments: {} },
});
```

Canonical tree: `app-handler/instant-mcp-tools/`. `modules/instant-mcp-tools/` is a re-export shim.
