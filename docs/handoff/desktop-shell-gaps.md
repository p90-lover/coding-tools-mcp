# Desktop shell handoff — remaining gaps

This PR restores the **main Coding Tools Desktop shell** (sidebar, surfaces, MCP wiring). The following work stays with sibling bots and must not be treated as finished here.

## Out of scope (do not implement in this lane)

### CPA + Codex Router panels — Bot GG
- Provider Center / Codex Router account login, OAuth, routing, and credential vault UX
- `ProviderHubSaasSurface` internals and CPA adapter completion
- Sidebar **Providers** remains a live navigation target only

### commandcode-proxy + Paseo + Anneal panels — Main seeker
- Paseo orchestrator and Anneal task-monitor internals
- CommandCode proxy session import / CLI auth surfaces
- `tasks.list` and execution-book editing beyond the honest empty page this shell now returns when the headless catalog has no task records
- Sidebar **Paseo / Anneal / Integrations** remain reachable under **More**

### Chrome fast-access-extension HUD / Desktop pairing — LOL
- Extension HUD pairing, Computer overlay, and Desktop↔Chrome session bind
- `computer.status` now reports `available: false` with that handoff reason instead of a decorative control

## Still true after this PR
- Native WebView end-to-end of ChatGPT tabs still requires a packaged launcher
- Live user Paseo/Anneal instances are not started by the main shell
- Headless `/api/v1/tools/*` needs a running `coding-tools-headless` binary and local workspace profiles (`%APPDATA%\\coding-tools-mcp-desktop\\data\\profiles.json` / `%LOCALAPPDATA%\\Coding Tools MCP\\`)
- mcp-probe-kit `4.0.0-rc.20` is not published on npm in this environment; the CLI start_ui plan could not be opened from the pinned installer
