# Codex Auto Review account selector

Native CPA 8.0.32 plugin. Only the exact model `codex-auto-review` is intercepted. It runs through CPA's native Codex executor with the selected opaque `auth_id` and `forced_provider: codex`. Other models return `Handled: false`.

Open **Plugins → Codex Auto Review**, select an available existing Codex account, and save. Missing, disabled, unavailable or quota-limited selected accounts fail without another account fallback. The account is captured once per request; changing the selection affects new requests only. Disabling the plugin restores ordinary CPA routing.

Coding Tools’ managed CPA connection signs the page in automatically. When CPA’s parent page has “Remember me” off, use **Sign in for this page** with the existing CPA management key. The key stays only in the page’s memory until it closes, and the parent’s preference stays unchanged.

Configuration under `plugins.configs.codex-review-account-selector`:

```yaml
data-dir: 'C:\absolute\private\codex-review-account-selector'
```

The private directory contains only `selection.json` with `{"selectedAuthId":"opaque-host-id"}`. No account credential files are read or copied. The authenticated management API exposes:

- `GET /v0/management/codex-review-account-selector/accounts`: sanitized Codex account IDs, labels, emails, refresh timestamps and availability.
- `GET /v0/management/codex-review-account-selector/settings`.
- `PUT /v0/management/codex-review-account-selector/settings` with `{"selectedAuthId":"opaque-host-id"}`.
- Resource `/v0/resource/plugins/codex-review-account-selector/index.html`.

The executor attaches `X-Codex-Review-Auth-Id` to its response. Public visibility follows CPA's `passthrough-headers` setting, which defaults to false and filters this header. The authenticated settings API exposes the saved account ID. Both OpenAI Chat Completions and Responses protocols support normal and streaming execution.

The ABI adapter is reused from the repository's MIT Cline/CommandCode adapter. Pinned host API references: [plugin types](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.32/sdk/pluginapi/types.go), [host callbacks](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.32/internal/pluginhost/host_callbacks.go), and [pinned candidate selection](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.32/sdk/cliproxy/auth/conductor_selection.go). No new Go module dependency.

Build with the repository Go/Zig toolchain, `CGO_ENABLED=1` and `CC="zig cc -target x86_64-windows-gnu"`, then `go build -buildmode=c-shared -trimpath -ldflags "-s -w" -o <task-aiTemp>/codex-review-account-selector.dll`. Build/test caches and generated headers belong under project `aiTemp/`.
