# Hello Desktop shell / MCP lane — in-app five-stack loopbacks

This PR is **hello’s Desktop shell / MCP lane only**. It hard-targets the in-app loopbacks so the original Coding Tools panel (Browser / Setup / MCP / Activity / Settings) can manage and monitor the five-stack without a separate download/install.

It does **not** redo CPA/Router keep-alive (#190 / #194), Paseo↔Anneal contract (#193), or five-stack glue (#192). Base is `release/codex-router-multiprovider-0.7.0-rc.8` so this can rebase onto #192/#194.

## Locked ports

| Stack | Loopback | Health / API |
| --- | --- | --- |
| CPA / CLIProxyAPI | `127.0.0.1:8317` | `GET /v1/models` (any HTTP response = listening) |
| Codex Router | `127.0.0.1:4202` | TCP / `GET /`; caller-keyed `/_codex-router/{key}/v1/models` is optional |
| CommandCode Proxy | `127.0.0.1:9090` | `/health` + `/v1/models`; fallback `127.0.0.1:3050` |
| Paseo | `127.0.0.1:6768` | protocol v1 HTTP `/`; execution `ws://127.0.0.1:6768/ws` |
| Anneal | `127.0.0.1:3000` | tasks API `GET /tasks`; preview `http://127.0.0.1:3000/#/tasks` (POSTs use the same origin; probes never POST) |

## What this lane owns

- Frozen map: `desktop-electron/electron/five-stack-loopbacks.cjs`
- Quiet 7-day shell↔MCP reconnect: `desktop-electron/electron/five-stack-loopback-probes.cjs`
- MCP overlay tools: `five_stack_loopbacks`, `five_stack_status`, `five_stack_start`
- MCP panel `FiveStackLoopbackPanel` plus Integrations Start that hits loopbacks first (no GitHub-token / Install gate)

## Compose later

- Bundled CPA/Router Start binaries: #194
- CommandCode/Paseo/Anneal engines: #193
- Full five-stack glue (`paseo_plan` / `five_stack_manage` internals): #192
