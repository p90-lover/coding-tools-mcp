# Cline Pass Switcher CPA plugin

Pinned upstream: [munmunjaklin458-afk/cline-pass-switcher](https://github.com/munmunjaklin458-afk/cline-pass-switcher), commit `02538a3137a08948a94f26f17dd4aeff8c029ed1` (MIT; original sources and notice in `upstream/`).

The native CPA v8 plugin exposes the full original console at **Plugins → Cline Pass**, with authenticated management APIs, and a `cline` auth/model/executor provider. The bundled managed Bun runtime runs the original zero-dependency server on an ephemeral loopback port. CPA remains the client endpoint (`http://127.0.0.1:8317/v1`). Add account keys in the console; keys remain in private local Cline data, not the bundle or CPA bridge auth file. Existing upstream selection, exclusions, failover, account pooling, model sync and history are preserved.

Runtime adaptations cover ephemeral-port readiness/client URLs, CPA marker bootstrap and authenticated API mapping, SSE prelude buffering for keepalives/fragmentation, managed outbound proxy and parent-owned lifecycle. The upstream server and console remain unchanged in source; package.json supplies a minimal private ESM runtime declaration. A private loopback proxy key is generated on startup; rotation from the console is supported, but removing authentication is not.

Plugin YAML: `runtime-executable` (absolute Bun/Node path), `data-dir` (absolute private data directory), `proxy-url` (selected outbound HTTP proxy). Coding Tools configures these automatically and creates a credential-free `auth/cline-pass-switcher.json` bridge marker.

Build with the repository's portable Go/Zig toolchain (`CGO_ENABLED=1`, `CC="zig cc -target x86_64-windows-gnu"`), using `go build -buildmode=c-shared -trimpath -ldflags "-s -w"`. The ABI glue is adapted from the existing MIT CommandCode plugin. Tests cover native lifecycle/routes/models/inference and SSE framing; Node tests cover the pinned binary and scoped panel credential exchange.
