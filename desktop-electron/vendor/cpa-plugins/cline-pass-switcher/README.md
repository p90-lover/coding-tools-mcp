# Cline Pass Switcher CPA plugin

Pinned upstream: [munmunjaklin458-afk/cline-pass-switcher](https://github.com/munmunjaklin458-afk/cline-pass-switcher), commit `02538a3137a08948a94f26f17dd4aeff8c029ed1` (MIT; original sources and notice in `upstream/`).

The native CPA v8 plugin exposes the full original console at **Plugins → Cline Pass**, with authenticated management APIs, and a `cline` auth/model/executor provider. The bundled managed Bun runtime runs the original zero-dependency server on an ephemeral loopback port. CPA remains the client endpoint (`http://127.0.0.1:8317/v1`). Add account keys in the console; keys remain in private local Cline data, not the bundle or CPA bridge auth file. Existing upstream selection, exclusions, failover, account pooling, model sync and history are preserved.

Runtime adaptations cover ephemeral-port readiness/client URLs, CPA marker bootstrap and authenticated API mapping, SSE prelude buffering for keepalives/fragmentation, managed outbound proxy and parent-owned lifecycle. The upstream server and console remain unchanged in source; package.json supplies a minimal private ESM runtime declaration. A private loopback proxy key is generated on startup; rotation from the console is supported, but removing authentication is not.

Plugin YAML: `runtime-executable` (absolute Bun/Node path), `data-dir` (absolute private data directory), `proxy-url` (selected outbound HTTP proxy). Coding Tools configures these automatically and creates a credential-free `auth/cline-pass-switcher.json` bridge marker.

A request's reasoning effort (the body's `reasoning_effort`, or a `model(level)` suffix, which wins) runs at the model's nearest level it takes, a tie going up (`takenEffort`); "auto", an empty one or an unknown word sends none. A level a model lacked used to be refused with a 400, which Claude Code retried until the chat's launch looked stuck.

A model Cline lists but no longer serves answers 502 `{"error":"model not found"}`; that becomes a non-retryable 404 (`upstreamStatus`). As a 5xx, Claude Code retried it for about four minutes, so the chat looked stuck launching.

A spent ClinePass window comes back from the switcher as 502 `{"error":"Error 429: You have reached your weekly Clinepass limit..."}`; that becomes a 429 (`upstreamStatus`), so CPA puts the model on its quota cooldown and answers retries itself. As a 502 it was a transient error, which Coding Tools does not cool down, so each of Claude Code's ten retries went to Cline four times (CPA's `request-retry: 3`), the whole context each time.

A streamed reply that has not started within 60 s is asked for once more (`startStream`); two that never start are a retryable 504. The switcher sends its response headers only once the upstream stream has begun, so the wait for headers is the wait for the model's first word. Before, one that never started took the switcher's whole 120 s attempt budget, and the chat sat "quiet" for two minutes after a tool call.

A model that writes a tool call as text (Qwen XML `<tool_call><function=NAME><parameter=K>V</parameter></function></tool_call>`, or JSON inside `<tool_call>`), as MiMo V2.6 Pro does, gets it turned into a real `tool_calls` entry for a tool the request offered, streamed or whole (`texttools.go`); anything else stays text.

Build with the repository's portable Go/Zig toolchain (`CGO_ENABLED=1`, `CC="zig cc -target x86_64-windows-gnu"`), using `go build -buildmode=c-shared -trimpath -ldflags "-s -w"`. The ABI glue is adapted from the existing MIT CommandCode plugin. Tests cover native lifecycle/routes/models/inference and SSE framing; Node tests cover the pinned binary and scoped panel credential exchange.
