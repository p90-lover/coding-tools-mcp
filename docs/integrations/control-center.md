# Paseo + Anneal control center

## What is integrated

This release connects to existing **local** Paseo and Anneal services using their actual wire contracts, and adds a native planning board. It does not bundle their agent runners, install them, launch models, or grant external approvals. The adapter surface intentionally has no create-agent/send-prompt/resume-run/approve/merge method. An already running external agent can still spend its own provider quota independently of this viewer.

Paseo is pinned for compatibility review at `da8c1b5c94e752b01d451645e5fa52aba2c1b2f0` (Apache-2.0). The adapter sends a protocol-v1 `hello`, opts into explicit/selective subscriptions without subscribing to content, then a correlated `fetch_agents_request`. It reads agent directory metadata and bounded pagination, not transcript content or model responses. Optional password authentication uses the upstream `paseo.bearer.` WebSocket subprotocol. No relay, pairing, voice, multi-host control or provider execution is included.

Anneal is pinned at `088f0d5971a1692134aaa3db0230cc541b014c07` (MIT). The adapter sends only GET `/tasks?view=board` to an existing API origin or `/api` web proxy. It shows task status, chain identity/status, assignee and review-gate metadata. It cannot approve or execute chains. The upstream runtime's Windows-unsupported status is not changed by adding this Windows-compatible observer.

The local planning board adapts Anneal's five board columns and pure counting/status helpers. Local tasks support specifications, priority, workspace filters, revisions, completion notes and reversible archival. They are NOT synchronized writes into Anneal; marking Done is an operator record, not proof of CI success or merge authorization. No automated merge is performed.

## Connection setup

Open **Connections**. For Paseo, enter the already-running local daemon URL (default `ws://127.0.0.1:6767/ws`), add its password if needed, and select **Save & verify**. Then open **Sessions** and refresh or page through the directory. For Anneal, use your existing web proxy (default `http://127.0.0.1:5173/api`) or direct API origin with its bearer token. Open **Task board → Anneal** and refresh.

Only literal loopback IPv4/IPv6 hosts are accepted. No public/private LAN hostnames, external HTTP redirects, credential-bearing URLs or arbitrary paths are accepted. A user-managed local forwarding service may be used separately; this app does not configure or secure it. A connection marked Configured is not necessarily currently reachable; last successful read and errors are displayed separately.

Credentials are held only in the Rust process memory and never returned through the load command or written into AppData. The password field clears after submission. Connection metadata (URL/enabled) is saved; a credential must be supplied again after the native process restarts. Disconnect/reconfiguration invalidates in-flight results. External refresh is manual, globally limited to two non-queued requests with an eight-second deadline and 2 MiB per message/document. Directory/board row counts are bounded; unknown statuses are never counted as Done. Error text does not reflect raw credentials or response bodies.

## Interface and preserved features

A new responsive shell provides Overview, Task board, Sessions, Computer control and Connections. Search/Ctrl+K, locale preference, light/dark theme, project links, empty/error/stale states and focused task dialogs are native code, not static mockups. English/Traditional Chinese navigation and new workflows are included; legacy configuration forms retain their existing localized copy. Existing workspace service/auth/tunnel/log/health and settings controls remain reachable with the shared visual system. The large computer panel has moved to its own page.

Remembered always-enabled grants, background observation, exact agent-frame monitor, Pause/Stop, emergency shortcut and RAM-only screenshot behavior are preserved. Native screenshot/GUI executor files are not changed by this integration. No continuous screenshot upload or screenshot cache is introduced. The experimental command sandbox remains withheld with no unsandboxed fallback. This is not a new multi-tenant hosted SaaS service; it is a locally running product-style control center.

## Verification boundary

Focused protocol tests use real loopback HTTP/WebSocket servers with pinned upstream message shapes and assertions about outbound read-only operations. They are not a deployment test against the user's actual Paseo/Anneal installations. Browser journeys use explicit QA-only native IPC fixtures, kept outside the production frontend, to verify navigation, editing/gates, connection controls and responsive layouts. No real desktop screenshots, provider credentials, model calls or personal task content are used for these UI tests.

Current runtime compatibility can change with upstream updates. Do not report a configured endpoint as connected before an actual read succeeds. For installations requiring unsupported relay/auth transports, fail visibly instead of falling back to an insecure public endpoint.
