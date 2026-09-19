# Hello MCP/shell — in-process handler tools

Follow-up on PR #221 (`modules/<app>/` + `codingTools.apps` over existing IPC). This lane is MCP/shell consumer wiring only.

## Surface

MCP tools in the Desktop catalog map onto the in-process host:

| MCP tool | `codingTools.apps` |
| --- | --- |
| `apps_list` | `list()` |
| `apps_catalog` | `catalog()` |
| `apps_call` | `call({ moduleId, operation, arguments })` |
| `apps_invoke` | `invoke({ handle, operation, arguments })` |
| `apps_status` | inspect-only ready report |

There is **no apps HTTP listener** and no dedicated listen ports. `apps_status` reports `listening: false` / `dedicatedListenPorts: false` and never calls `start`. Temporary child loopbacks remain smoke-only.

This supersedes PR #196’s loopback-port overlay (`five_stack_loopbacks` / `five_stack_start`). Original Coding Tools nav is unchanged; the MCP page hosts a thin in-process panel and does not open extra app windows.

Proxy seed: `http://127.0.0.1:17891` (not `:7890`). Claude/Anthropic stay on that SOCKS/proxy path.
