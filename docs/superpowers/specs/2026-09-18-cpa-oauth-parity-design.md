# CPA OAuth Parity Design

## Goal

Make Provider Center account login behave like the real CPA/CLIProxyAPI account manager for Codex, Claude, Gemini CLI, and Antigravity while preserving the existing ChatGPT Web BrowserHost and CommandCode-specific flows.

The selected product architecture remains **Architecture B**: Codex Router, CPA/CLIProxyAPI, CommandCode Proxy, Paseo, and Anneal are separately installed loopback services, while Coding Tools owns the unified GUI, encrypted configuration, account routing, health/lifecycle controls, and orchestration bindings.

## Verified root cause

Provider Center currently marks every OAuth or browser-backed provider as login-capable, but the main-process implementation has only four complete login paths:

1. ChatGPT Web and Codex use the isolated ChatGPT BrowserHost.
2. CommandCode uses its own loopback callback flow.
3. Antigravity uses CPA management OAuth and auth-file discovery.
4. Claude and Gemini-facing entries merely open a public webpage and return without binding an account, polling completion, refreshing models, or exposing health checks.

This is a contract mismatch between the renderer catalogue and the main-process account authority. It cannot be fixed by changing button copy alone.

## Upstream CPA contract

The pinned CPA-compatible management API exposes:

- `GET /v0/management/anthropic-auth-url?is_webui=true`
- `GET /v0/management/codex-auth-url?is_webui=true`
- `GET /v0/management/antigravity-auth-url?is_webui=true`
- plugin-owned `GET /v0/management/<provider>-auth-url?is_webui=true`
- `GET /v0/management/get-auth-status?state=...`
- `GET /v0/management/auth-files`
- `GET /v0/management/auth-files/models?name=...`

The Gemini CLI OAuth route is plugin-provided. Coding Tools must probe it through `gemini-cli-auth-url` and fail closed with actionable guidance when the installed CPA build does not expose that provider.

## Architecture

### 1. First-class CPA external service

Add `cliproxyapi` to the external-services control plane with:

- default loopback endpoint `http://127.0.0.1:8317/`;
- separately encrypted management key;
- install/start/stop/restart/inspect controls;
- health inspection through the management auth-file endpoint;
- an internal-only `providerConnection()` method returning the normalized endpoint and decrypted management key;
- no management key in renderer snapshots, logs, errors, IPC responses, release evidence, or runtime environment.

Existing per-account Antigravity management credentials remain readable as a migration fallback. New CPA-managed accounts use the central service authority.

### 2. Generic CPA OAuth adapter

Replace the Antigravity-only flow with a provider mapping:

| Provider Center ID | CPA provider | OAuth route |
|---|---|---|
| `codex-oauth` | `codex` | `codex-auth-url` |
| `claude-oauth` | `anthropic` | `anthropic-auth-url` |
| `gemini-oauth` | `gemini-cli` | `gemini-cli-auth-url` |
| `cliproxyapi-antigravity` | `antigravity` | `antigravity-auth-url` |

The adapter must:

1. capture the matching auth-file baseline;
2. request a CPA OAuth URL and state;
3. open the URL through the operating system browser;
4. poll CPA status with a bounded timeout;
5. bind the exact newly-created auth file, or an exact previously-bound name/index;
6. persist only binding metadata in the encrypted account record;
7. read identity and health from the bound auth file;
8. discover models for that exact auth file;
9. fail closed if a previously-bound auth file disappears;
10. never return the management key, OAuth token, refresh token, or auth-file contents to the renderer.

### 3. Provider catalogue and UI

Add `cpa_oauth` as a login mode and add a separate `gemini-oauth` provider. Preserve `gemini-reverse-proxy` and `gemini-api` for backward compatibility.

Provider Center must:

- show CPA-managed login/refresh/test controls for Codex, Claude, Gemini OAuth, and Antigravity;
- identify CPA as the account authority;
- direct missing-management-key users to Integrations instead of displaying a generic token field;
- retain multiple accounts per provider, default/fallback selection, model lists, account health, and proxy policy;
- provide English and Traditional Chinese copy;
- avoid reporting an account as connected until CPA reports a bound healthy auth file.

ChatGPT Web continues to use BrowserHost. CommandCode continues to use its dedicated OAuth/import path.

### 4. Wiring boundary

`provider-bootstrap.cjs` receives an internal CPA connection getter, analogous to the BrowserHost getter. `main.cjs` wires it after constructing the external-services controller.

The renderer never receives the management key. Provider-network requests receive only a short-lived `{ baseUrl, managementKey }` object inside the Electron main process.

### 5. Expansion model

Future CPA OAuth providers are added by extending one mapping entry rather than adding a bespoke controller. Static CPA routes and plugin routes share the same start/status/auth-file/model contract.

The provider mapping contains display labels and unsupported-provider guidance, enabling Kimi, xAI, Meta, Devin, or plugin providers to be added without another account-store redesign.

## Safety and compatibility

- No project file or branch is deleted.
- Temporary and retained validation data stays under `aiTemp/` or `aiTemp/Trash/`.
- Existing Antigravity per-account management credentials remain a read-only migration fallback.
- Existing ChatGPT Web and CommandCode sessions are not migrated or overwritten.
- CPA endpoints remain loopback-only unless HTTPS is explicitly configured.
- Login redirects require HTTPS, except loopback callback URLs.
- OAuth state polling is bounded and errors are redacted.
- Gemini plugin absence is reported as unsupported, not as a successful login.

## Acceptance criteria

1. Codex, Claude, Gemini OAuth, and Antigravity each complete the same CPA-managed start/poll/bind/probe/model flow.
2. Multiple accounts bind to the correct newly-created CPA auth file.
3. A missing bound auth file changes the account to pending and requires login again.
4. Expired, disabled, unavailable, and healthy states are distinguished.
5. CPA management secrets never appear in snapshots, renderer state, errors, logs, or artifacts.
6. Provider Center and Integrations expose complete English and Traditional Chinese controls.
7. Codex Router, CommandCode, Paseo, Anneal, and subagent routing remain green.
8. Strict TypeScript, Electron syntax, renderer production build, Windows packaging, packaged-launcher smoke, no-delete gates, and focused OAuth contracts pass before merge.
