# Codex tools inside MCP: local execution, real boundaries

## Runtime and scope

ChatGPT is the reasoning client. This app supplies authenticated, policy-checked tools; it does not start a Codex model or spend Codex quota. `codex_tools_status` reports every currently exposed tool, its live policy revision, and a handler-family inventory pinned to `openai/codex` commit `634ebc1865c6ac840ed3ba118f040d527bf4b55d`. An inventory entry is not an executable tool. Only entries with a real registered schema and dispatch path are marked as local counterparts.

The existing command/stdin/output/stop, patch, files, Git, plan, tool search, permission-request, image and native computer-use tools remain available according to the workspace profile. Seven additional model-free tools now have real handlers: `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`, `request_user_input`, `read_user_input`, `clock_sleep`, and `wait_for_environment`.

These are local implementations of applicable Codex interfaces, not all internals of the Codex agent. Model and subagent execution, host context-window management, dynamic extension callbacks, host plugin installation, unsolicited host messages and code-mode orchestration need their real host/provider. They are not replaced by tools that return fake success. The unverified native command sandbox and unfinished inference bridge remain excluded; command security is the existing policy layer, not a newly asserted OS sandbox.

## Resource workflow

Use `list_mcp_resources` to obtain the current listener's environment and plan URIs. `read_mcp_resource` requires the returned server name and a supported URI. `list_mcp_resource_templates` describes bounded stdout/stderr resources for command IDs already owned by that listener. These three handlers also serve standard MCP `resources/list`, `resources/templates/list`, and `resources/read` requests, under the same authentication and policy checks. No subscription or resource-change notification stream is advertised.

The adapter does not fetch arbitrary network endpoints, other MCP servers, `file://` URIs, or unapproved workspace paths. Command output pages are limited to 8192 bytes; resources to 64 KiB. A command ID from another listener is not authorization to read it. Existing output retention limits still apply. Resource reads do not launch commands or write screenshot files.

## Human-in-the-loop workflow

The client calls `request_user_input` with one to three questions, each with an ID, short header, question and two or three choices. It immediately receives `status: pending` and `request_id` rather than holding the MCP HTTP connection open. The local desktop displays the actual questions in English or Traditional Chinese UI, allows the user to choose an option or type an Other answer, and requires an explicit Send or Cancel.

The client calls `read_user_input` with that ID to retrieve the real answer or pending/cancelled state. It cannot answer its own question through MCP. Only the visible, focused main desktop window can submit answers over local IPC. A per-question local form nonce prevents a stale form from answering a different session's question. Answers are information only: they never grant permissions, launch commands or click on the user's behalf.

Questions are isolated per listener, held in RAM for up to ten minutes, and capped at 32 entries. Reusing a request ID for different questions is rejected. Permission changes cancel pending questions and clear answer data at the next access; listener replacement drops its active store. Do not enter passwords or tokens. This does not provide cryptographic RAM erasure or control retention by the receiving client.

## Waiting and live permissions

`clock_sleep` waits 1–5000 milliseconds and reports actual elapsed time. It is not the upstream twelve-hour wait and does not claim to receive ChatGPT new-message events. `wait_for_environment` checks first and optionally waits up to 5000 milliseconds for the current workspace directory to be readable; it does not manage remote environments. Both waits stop when the policy revision changes and do not hold the permission-write lock throughout the delay.

Permission-only updates still take effect without restarting the listener, changing the tunnel URL or relinking MCP. The tool catalog has grown in this version, so refresh the existing ChatGPT plugin's tool definitions once after upgrading. That catalog refresh is separate from ordinary future permission changes. Installing a new EXE requires restarting the desktop app once to load that binary.

## Connection repair and verification

This version also carries the OAuth metadata challenge, empty HTTP 202 notification response, authenticated SSE-GET 405 response, resource-discovery alias and status-only diagnostics documented in [MCP connection repair](mcp-connection-repair.md). A recognized @mention or a copied endpoint does not prove that a chat loaded the tools. Missing namespaces alone cannot establish a stale tunnel or disabled ChatGPT backend.

Focused tests exercise real resource handlers/protocol paths, genuine answer-state transitions and isolation, bounded waits interrupted by a policy change, and the three existing local HTTP connection cases. Frontend and installer checks do not constitute an end-to-end test of the user's actual Windows, Cloudflare or ChatGPT account. No model, Codex inference or AI reviewer is needed for this validation.

## AI and human learning

The working loop is goal → small plan → approved tools → observable result → human question/review → revised plan → verified checkpoint. AI can ask where evidence is insufficient rather than fabricate a preference. Humans can compare a predicted result with the returned output, select a correction and record the reason in approved project notes. Later sessions can reuse those notes; that is context reuse, not automatic training of model weights. Never mark a task done solely because a question was answered or a checklist item was clicked.

The legacy `compat-readonly-all` profile now retains truthful safety annotations, matching the advanced catalog; it no longer disguises writes as reads to influence host approval. A client may legitimately ask for approval or restrict a write tool.
