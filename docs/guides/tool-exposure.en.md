# Why ChatGPT does not see every tool

## Four separate layers

A registered tool is not the same as a tool advertised by the selected profile, a tool enabled in ChatGPT's saved connection, or an operation authorized on this computer. The desktop cannot infer the account's loaded namespace from a copied URL or a healthy tunnel.

In the workspace's ChatGPT setup, **Tool exposure** reads the current running MCP context. When MCP is stopped, it explicitly shows saved configuration only. It displays advertised versus registered definitions, names excluded by the profile, a SHA-256 of the actual tool metadata, and unavailable definitions. `server_info.tool_catalog` supplies the same evidence through MCP. `client_loaded_tools` remains null: this is not a remote ChatGPT registration check.

## Correct profile selection

Version 0.4.3-rc.1 used `core` as the default and normalized `full` to `advanced`, but its dropdown contained neither `core` nor `advanced`. The 0.4.3-rc.2 selector represents both values and treats `full` as the `advanced` alias. It no longer initially displays Full for a Core configuration or produces an empty selection for Advanced.

Select **Advanced / Full**, then Save, to advertise all registered definitions. Core remains a smaller, explicit choice; Read-only and Compatibility retain their existing server behavior. The update does not silently change existing profiles, expose new tools, disable approvals, or grant screen capture. Some advertised definitions require local activation; `sandbox_exec` remains an unavailable stub, not a functioning executor.

## Refresh the receiving client

For a developer-mode connection, open the existing connection in ChatGPT Plugins, select Refresh, review/enable the required actions, and test in a new chat with the connection selected. Published plugins use reviewed metadata snapshots and can need an administrator-approved update. Changing the local permission mode is not the same as changing that tool snapshot. Permission-only saves retain MCP, its endpoint and OAuth; loading a newly installed binary still requires one application restart.

If the desktop reports a complete advertised catalog but ChatGPT still lacks actions, check the client connection's enabled actions, selected account/workspace/chat and actual scan error. Do not label every action read-only to bypass client approvals. Do not delete OAuth credentials or recreate the connector merely because a model says it lacks tools. No complete client-side diagnosis is possible without the actual connection/scan evidence.

OpenAI's current developer guide and its workspace Help Center article differ on plan eligibility. This app does not assume eligibility from the plan name and does not impose a hard-coded Pro restriction. Use the controls available in the actual account and workspace. No fixed maximum tool count is assumed here.

## Scope and learning

Paseo/Anneal autonomous engines and complete proprietary/internal Codex tool parity are missing implementations, not hidden catalog entries. The existing model-free command path, shared workflow board, memory-only vision, local consent and Stop controls remain unchanged. Native model operations stay separately opted in; this repair makes no model requests. Neither silent account authorization nor publisher signing is added by a catalog fix.

Human + AI workflow: define a goal → inspect the current catalog → identify a supported tool → verify local permission → execute the smallest approved step → inspect the result → record an observation → let the human review → checkpoint. A task observation is evidence to review, not an automatic human approval. Saved notes improve later context reuse; they do not train model weights.

## Sources

Checked 2026-09-10:
- https://developers.openai.com/api/docs/guides/developer-mode
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://developers.openai.com/plugins/deploy/troubleshooting
- https://help.openai.com/en/articles/12584461
