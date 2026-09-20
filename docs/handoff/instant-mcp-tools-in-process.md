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
| `listTools` | `list-tools`, `tools` | `{ "workspaceId"?: string }` |
| `runTool` | `run-tool`, `callTool` | `{ "tool": string, "arguments"?: object, "workspaceId"?: string, "requestId"?: string }` |
| `listWorkspaces` | — | `{}` |

Host-level: `codingTools.apps.list()` / `.catalog()` include this module. Ready = `inspect` / `catalog`. Do not add a Start button or bind a panel port.

LOL typed stub (#235) should call kebab-case `inspect` / `list-tools` / `run-tool`. CamelCase remains valid.

```js
await codingTools.apps.call({
  moduleId: "instant-mcp-tools",
  operation: "list-tools",
  arguments: { workspaceId: "ws-1" },
});
await codingTools.apps.call({
  moduleId: "instant-mcp-tools",
  operation: "run-tool",
  arguments: { tool: "apps_list", arguments: {} },
});
```

Canonical tree: `app-handler/instant-mcp-tools/`. `modules/instant-mcp-tools/` is a re-export shim.
