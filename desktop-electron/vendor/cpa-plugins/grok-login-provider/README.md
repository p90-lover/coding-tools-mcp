# Grok Login Provider CPA plugin

A CLIProxyAPI v8 provider plugin (provider key `grok`) that serves Grok through the provider layer of [chenyme/grok2api](https://github.com/chenyme/grok2api) (MIT). It covers three upstreams:

| Upstream | Login | Models |
| --- | --- | --- |
| Grok Build (`cli-chat-proxy.grok.com`) | xAI OAuth (device flow), or an SSO cookie converted to OAuth tokens | live catalog, e.g. `grok-4.6`, `grok-build-0.1` |
| Grok Web (`grok.com`) | SSO cookie (+ optional Cloudflare cookies) | `grok-chat-fast`, `-auto`, `-expert`, `-heavy` (by account tier) |
| Grok Console (`console.x.ai`) | SSO cookie | `grok-4.3`, `grok-4.5`, `grok-4.20-*`, `grok-build-0.1` |

CPA's built-in `xai` provider keeps plain Build OAuth files (`"type":"xai"`); this plugin owns `"type":"grok"` files.

## Source

- `backend/`: grok2api `backend/` at commit `7c889a960e2638341b4dae9a5c81af0e0f38c87f` (v3.1.6), without upstream tests; `LICENSE.grok2api` is its license.
- One patch in the vendored tree, `internal/infra/provider/web/sso_build.go`: the SSO→Build conversion reads xAI's one-time ES256 `consent+jwt` from the consent page and sends it to `/oauth2/device/approve` with `Origin: https://accounts.x.ai`, as [ssfun/cpa-plugin-grok-sso2auth](https://github.com/ssfun/cpa-plugin-grok-sso2auth) (MIT) documents. Pages without a token keep grok2api's original form. `sso_consent_test.go` covers it.
- `backend/cmd/cpa-grok-login-provider/`: the plugin. The C ABI glue follows `../auth-commandcode`. `quality_guard.go` and `quality_scan.go` are grok2api's `application/gateway/quality_retry*.go` with the gateway service code removed.

## Login

CPA's **OAuth Login → Grok** button opens a loopback page (random `127.0.0.1` port, 30-minute session) with two choices:

- **Sign in with xAI**: xAI device flow; saves a Grok Build account with refreshable tokens.
- **SSO cookie**: paste the grok.com `sso` cookie (the `sso=…; sso-rw=…` form is accepted) and choose Build, Web, Console or all. The form POSTs to the page; the cookie never travels in a URL. Web and Console cookies are checked against the upstream session endpoint; Build converts the cookie to OAuth tokens.

API callers can pass `?method=oauth` to `/v8/management/oauth/auth-url?provider=grok` to get xAI's verification URL directly.

## Import detection

Auth files without a `type` are offered to every CPA plugin; this one claims a file only on a Grok-specific signal:

| Layout | Signal |
| --- | --- |
| Grok Build `~/.grok/auth.json` | a `https://auth.x.ai::<client>` key with `key`/`refresh_token` |
| grok2api exports | `"provider": "grok_build" / "grok_web" / "grok_console"` (top level or on every batch entry) |
| grok2api legacy `token.json` | `ssoNormal` / `ssoSuper` / `sso` pools of objects |
| bare cookie | `{"sso": "<jwt>"}` or `{"sso_token": "<jwt>"}` |

Each account of a multi-account file gets its own CPA auth (`<file>#<account>`). A bare cookie on import creates Web and Console accounts (per `sso-default-target`); Build conversion needs the network, so it runs only from the login page. CPA only accepts `.json` objects, so plain-text and top-level-array exports must be wrapped as `{"provider":"grok_web","accounts":[…]}`.

## Anti-downgrade guard

grok2api's `qualityGuard.requestRetry`, on by default for Build and Console reasoning models. A stream is held (up to `hold-timeout`) until it shows streamed reasoning; an answer that arrives without it, or dumps its output in under 2 s, is withheld and the plugin returns a retryable `503 quality_degraded` so CPA's `request-retry` moves to another Grok account. After 6 withholds of the same request, `on-exhausted: fail_closed` rejects it and `fail_open` delivers the last one.

## Configuration

`plugins.configs.grok-login-provider` in CPA's `config.yaml`. CPA does not load a plugin without an entry there; Coding Tools' `cpa-managed.cjs` writes `enabled: true`. Optional keys: `proxy-url`, `build-base-url`, `build-client-version`, `web-base-url`, `console-base-url`, `statsig-mode` (`url`|`manual`), `statsig-signer-url`, `statsig-manual-value`, `sso-default-target` (`all`|`build`|`web`|`console`), `quality-guard` (`enabled`, `hold-timeout`, `min-output-tokens`, `on-exhausted`).

Grok Web requests need an `x-statsig-id`. In the default `url` mode the plugin asks grok2api's signer (`https://grok.wodf.de/sign`), sending only the HTTP method, path and the public grok.com `<meta>` value; no cookie or token leaves the machine. Set `statsig-mode: manual` to avoid that service.

Proxy order: the auth file's `proxy_url`, then the plugin's `proxy-url`, then CPA's global `proxy-url`.

## Build

Go 1.26.8 with CGO and Zig 0.16.0 as the C compiler (portable copies under the repo's git-ignored `.tools/`, see `.tools/env.sh`):

```bash
source .tools/env.sh
cd desktop-electron/vendor/cpa-plugins/grok-login-provider/backend
go test ./cmd/cpa-grok-login-provider ./internal/infra/provider/web
go build -buildmode=c-shared -trimpath -ldflags "-s -w -X main.pluginVersion=0.1.0-codingtools.1" -o ../build/grok-login-provider-v0.1.0-codingtools.1.dll ./cmd/cpa-grok-login-provider
```

The Windows binary is pinned by `../../bundled/cpa-plugins/BUNDLE.json` and installed by `desktop-electron/electron/cpa-managed.cjs`. An isolated CPA 8.0.2 run verified registration, the login page, untyped grok2api import, per-account IDs for multi-account files, tier-based model discovery, and executor error handling; live inference with real Grok accounts is still a cutover check.
