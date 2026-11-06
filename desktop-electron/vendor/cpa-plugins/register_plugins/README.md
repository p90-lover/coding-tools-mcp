# Register CPA plugin

`register_plugins` is a management-only native CPA ABI 1 / RPC schema 6 plugin. CPA’s **Plugins → Register** console imports eligible OAuth accounts from Coding Tools’ bundled Register application and can enable automatic import and noninteractive renewal. It has no executor, login, browser-control, management-key, or general proxy capability.

Coding Tools supplies the absolute `bridge-descriptor` path and private `data-dir`. The descriptor contains a rotating, narrowly scoped loopback credential, not the CPA management key. The plugin accepts only a bounded regular descriptor file, exact `http://127.0.0.1:<port>`, no redirects and no outbound proxy. Browser management routes retain CPA authentication.

Automation defaults off. Once enabled, jobs run at the saved interval (60–86400 seconds, default 900), never overlap, and cancel on shutdown. Automatic import selects eligible active source accounts; automatic renewal selects only active accounts already owned by this plugin. Manual actions require 1–100 explicit IDs; empty lists never select all accounts. Login-required accounts remain unchanged.

CPA files use a stable source/account filename and an `_register_plugins` ownership marker. The private state stores successful source revisions. Repeated revisions are skipped even if CPA renewed its copy; a changed credential fingerprint is preserved as `cpa_newer`. Disabled CPA accounts, foreign filename collisions and CPA routing preferences are preserved. The console and logs never receive OAuth tokens or bridge credentials.

Build with portable Go and Zig: `CGO_ENABLED=1`, `CC="zig cc -target x86_64-windows-gnu"`, `go build -buildmode=c-shared -trimpath -ldflags "-s -w"`. Keep toolchains, caches, generated headers and fixture state under project `aiTemp/`. The bundled Windows DLL digest is recorded in `vendor/bundled/cpa-plugins/BUNDLE.json`. The C ABI adapter is adapted from the existing Coding Tools MIT plugin template.
