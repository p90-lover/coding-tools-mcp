# 需求文档：rewrite-the-proxy

## 功能概述

The user (2026-11-15): "rewrite the proxy ui and get it better on showing useful details, get a plan and make it fully working and route all traffic that selected on global or specific custom config on provider. think deeper to analyse many problem … its included that route all its app traffic though proxy, app plugins etc".

Two goals:
1. **Routing that is enforced.** When a route is selected, globally or as a custom route for a model provider, an account or a Browser-tab account, every byte of the app's traffic that it covers leaves through that proxy, signed in, or fails. That includes the app's own requests (update checks, app plugins, component downloads, Decodo), every program the app starts, and CPA's model traffic. Nothing silently goes direct, unsigned or through another route.
2. **A Proxy page that tells the truth.** It states what is routed where right now, whether each proxy works (reachable, sign-in accepted, exit IP and country, when tested), which programs follow the route, and what failed.

### Problems found (main 57c26dff9, live settings 2026-11-15)

| # | Problem | Evidence |
|---|---|---|
| P1 | Per-provider and per-account routes are saved and shown but not enforced; only CPA as a whole follows the `cpa` row | `provider-execution-router.cjs:106-154` is the only reader of provider/account policies; nothing applies its result |
| P2 | CPA keeps a stale route: live `config.yaml` `proxy-url` is the Decodo proxy while Global Routing is off | live config shape `http://<user>@isp.decodo.com:10000`, `routing.globalEnabled=false`; CPA's config is only rewritten at start |
| P3 | The proxy password is placed in every child's environment (`HTTPS_PROXY=http://user:pass@…`) | `provider-network.cjs` `applyGlobalEnvironment`; any agent tool can print it |
| P4 | Direct leaks: updater fallback (Node https), worker `fetch` (Decodo API, health), register host forced direct, SOCKS5 global leaves Node children direct | `update.cjs:202-210`, `main.cjs:589`, `provider-network.cjs:1337` |
| P5 | Unsigned leaks: ChatGPT Desktop instances get a bare URL, Antigravity sign-in window has no relay, SOCKS with a sign-in in Chromium, decrypt failure and relay failure fall back to the bare URL | `chatgpt-desktop.cjs:94`, `antigravity-auth-browser.cjs:23-30`, `provider-network.cjs:1230-1255,1329` |
| P6 | App plugins, updates and component downloads exit through the proxy of whichever Browser-tab account is on screen | `main.cjs:551-576` uses `browserHost.partition` |
| P7 | Route changes do not reach running programs (AO and every agent, the Codex bridge, the MCP tunnel, CPA) until they restart; nothing says so | env copied at spawn |
| P8 | A disabled or archived global proxy silently turns routing off (direct) | `dropProxyReferences` `provider-network.cjs:796`, `activeProxy` null |
| P9 | The relay accepts any local program without a sign-in | `signed-proxy-relay.cjs` listens on loopback with no client check |
| P10 | NO_PROXY differs between Chromium, children, CPA and agy | `DEFAULT_BYPASS` vs `managed-external-services.cjs:15-21` |
| P11 | Proxy page: active route unclear, untested proxies show nothing, errors hover-only, "Proxy" mode cannot be picked from scratch, "App proxy" is a no-op, raw provider ids, no per-program status, Decodo on another page | Proxy page map, 2026-11-15 |

## 历史经验与坑（来自记忆库）

- **必须规避的坑**:
  - Decodo drops unsigned requests instead of answering 407 (2026-11-15): never rely on Chromium answering a 407; sign in up front.
  - A saved sign-in can be refused while TCP connect succeeds: a test must try the sign-in, not just connect.
  - Never print proxy URLs, `HTTPS_PROXY`, CPA `config.yaml` or auth files: they hold passwords and tokens.
  - Proxy-settings saves blocked the main thread (fsync); all store writes go through `createStateFileWriter`.
  - CI forbids deleting source files: restyle and rewrite in place, add new files beside.
  - CPA restarts interrupt running chats; a design that needs CPA or AO restarts on every route change is a regression.
  - An outside proxy app (ProxyBridge Nova) is no longer used; the app must do this alone.

## 术语定义

- **Proxy profile**: a saved proxy (protocol, host, port, optional sign-in).
- **Route**: what a target uses: a proxy profile, Direct, or Follow (inherit from the level above).
- **Target**: who a route applies to: App (global), a model provider, a model account (a CPA credential), a Browser-tab account.
- **Egress router**: the app's loopback proxy that every consumer sends its traffic to; it resolves the target's route per connection.
- **Route token**: the loopback sign-in a consumer presents to the router; it names the target and proves the consumer was given it by the app.

## 范围边界

**In Scope:**
- One egress router for all outbound traffic of the app and the programs it starts (FR-1).
- Enforced global route (FR-2), per-provider, per-account and Browser-account routes (FR-3).
- Sign-in handling for HTTP, HTTPS, SOCKS4 and SOCKS5 upstreams; no passwords in child environments (FR-4).
- Live route changes without restarting AO, CPA or agents (FR-5).
- Safe proxy lifecycle: removing or disabling a proxy in use (FR-6).
- Proxy tests with sign-in, latency, exit IP and country (FR-7).
- App plugins, updates and component downloads on the App route (FR-8).
- Proxy page rewrite in place, EN + zh-TW (FR-9).

**Out of Scope:**
- Traffic of programs the app does not start (the user's own browser, shells, other apps). The user's own Chrome used for "Sign in with Chrome" keeps its own proxy settings and is labelled as such.
- Per-model routes (one route per model name).
- A system-wide (WFP / TUN) capture.

## 需求列表

### FR-1: One egress router for all outbound traffic

**优先级**: Must

The app runs one loopback router. Every consumer (Chromium sessions, the app's own Node requests, every program it starts, CPA) sends its outbound traffic to it with a route token, and the router forwards each connection through the target's current route.

#### 验收标准（EARS）

1. WHEN the app starts THEN 系统 SHALL start the router on 127.0.0.1 before any consumer is started or any remote request is made, reusing its previous port when free.
2. WHEN a consumer connects with a valid route token THEN 系统 SHALL forward the connection (CONNECT and absolute-form HTTP) through that target's route as resolved at that moment.
3. IF a connection carries no token or an unknown token THEN 系统 SHALL refuse it with 407 and forward nothing.
4. IF the target's proxy is unreachable, refuses the sign-in or times out THEN 系统 SHALL fail that connection (502 or 407 to the consumer) and record the error for the target; it SHALL NOT fall back to direct.
5. WHILE the app runs THE 系统 SHALL keep per-target counters: open connections, last success time, last error and its time.

### FR-2: The global route covers all app traffic

**优先级**: Must

#### 验收标准（EARS）

1. WHEN Global Routing is on with a proxy THEN 系统 SHALL route through it: every Chromium session not bound to its own route, the updater and its fallback, app plugin, CPA and component downloads, Decodo requests, every program the app starts (AO, agents and their tools, MCP servers, git/npm, the Codex bridge, the MCP tunnel, ChatGPT Desktop instances, the Antigravity CLI and sign-in window) and CPA's default upstream.
2. WHEN Global Routing is off THEN 系统 SHALL send the same traffic direct, CPA included (fixes P2).
3. WHILE a consumer cannot follow the router (a program outside the app's control) THE 系统 SHALL list it on the Proxy page with what it uses instead.

### FR-3: Custom routes per provider, per account and per Browser account are enforced

**优先级**: Must

#### 验收标准（EARS）

1. WHEN a model provider (Codex, Claude, Gemini, Antigravity, API-key and Provider Manager providers) has a route THEN 系统 SHALL send that provider's model traffic through it, whatever Global Routing says.
2. WHEN a model account (one CPA credential) has a route THEN 系统 SHALL send that account's traffic through it, over its provider's route and the global route.
3. WHEN a route says Follow THEN 系统 SHALL use the next level up: account → provider → global → direct.
4. WHEN a route says Direct THEN 系统 SHALL send that target's traffic direct even while Global Routing is on.
5. WHEN a Browser-tab account is bound to a proxy THEN 系统 SHALL use it for that account's pages and session reads only, never for app-level requests (fixes P6).
6. IF a credential is added after the app started (a new sign-in) THEN 系统 SHALL route it from its first request, by its provider's route until it gets its own.

### FR-4: Sign-in always applied, never exposed

**优先级**: Must

#### 验收标准（EARS）

1. WHEN the router forwards through a proxy with a saved sign-in THEN 系统 SHALL sign in on the first request (HTTP/HTTPS: Proxy-Authorization; SOCKS5: username/password method; SOCKS4: user id).
2. THE 系统 SHALL NOT put a proxy password in any environment variable, command line, log line or CPA file; consumers get the loopback router URL with a route token only.
3. IF a saved sign-in cannot be decrypted THEN 系统 SHALL fail the target's connections and show "Sign-in unreadable", never connect unsigned.

### FR-5: Route changes apply live

**优先级**: Must

#### 验收标准（EARS）

1. WHEN the user changes any route THEN 系统 SHALL apply it to new connections at once, for every consumer, without restarting AO, CPA, agents, the bridge or the tunnel.
2. WHEN the user asks to "Reconnect" a target THEN 系统 SHALL close that target's open tunnels so long-lived connections move to the new route.
3. IF a running program still uses an old route (started before the router, after an update) THEN 系统 SHALL show it as "Restart to follow" with a restart action.

### FR-6: A proxy in use is never removed silently

**优先级**: Must

#### 验收标准（EARS）

1. WHEN the user removes or disables a proxy that a route uses THEN 系统 SHALL ask which proxy (or Direct) those routes take instead, and apply that choice.
2. IF a route's proxy is gone or disabled by any other path (sync, file) THEN 系统 SHALL fail that route's traffic and show the route as broken; it SHALL NOT go direct.

### FR-7: Proxy tests tell whether it works

**优先级**: Must

#### 验收标准（EARS）

1. WHEN the user tests a proxy THEN 系统 SHALL connect through it with its sign-in and report: reachable or not, sign-in accepted or refused, latency, exit IP and country, and the time of the test.
2. WHEN real traffic through a proxy is refused for its sign-in THEN 系统 SHALL mark the proxy "Sign-in refused" with the time, and clear it on the next accepted sign-in.

### FR-8: App-level downloads follow the App route

**优先级**: Must

#### 验收标准（EARS）

1. WHEN the app checks for or downloads updates, app plugins, CPA or other components THEN 系统 SHALL use the App (global) route, and its fallback path SHALL use the same route.
2. IF the App route fails THEN 系统 SHALL report the proxy failure in the error, not go direct.

### FR-9: Proxy page rewrite

**优先级**: Must

#### 验收标准（EARS）

1. WHEN the page opens THEN 系统 SHALL state the App route in one line ("All app traffic → <proxy>" or "Direct, no proxy"), its health, and the router's state.
2. WHEN a proxy is listed THEN 系统 SHALL show protocol, host:port, username, sign-in state, last test (time, latency, exit IP and country), the last error inline, and how many routes use it.
3. WHEN the user opens Routes THEN 系统 SHALL list App, each model provider and each account by name (not raw ids), with Follow / Direct / proxy, the effective route after inheritance, and live state (connections, last error).
4. WHEN the page shows programs THEN 系统 SHALL list each consumer group with its route and whether it follows the router or needs a restart.
5. IF loading fails THEN 系统 SHALL show the error inline with a Retry action.
6. THE 系统 SHALL provide every label in English and Traditional Chinese (the page's existing Cantonese wording kept), be usable by keyboard, and keep working at narrow widths.

## 非功能需求

- **NFR-1（性能）**: The router adds under 5 ms per new connection on loopback and no measurable throughput loss for streaming model responses; it runs off the main thread.
- **NFR-2（安全）**: Only consumers given a route token can use the router; tokens are per install and never written to logs; no proxy password leaves the app's memory except to the upstream proxy.
- **NFR-3（兼容性）**: Existing profiles, the global route and saved provider/account policies keep their meaning after the update; Browser-tab bindings are kept.
- **NFR-4（可靠性）**: A router that stops is restarted on the same port within 2 s; until then connections fail, never go direct.

## 依赖关系

- CPA 8.0.63: global `proxy-url` and per-credential `proxy_url` (present in the binary; per-credential use to be verified live before relying on it for FR-3.2).
- Electron 45 `session.setProxy`, `app.on("login")` for proxy authentication of Chromium sessions.
- Node `NODE_USE_ENV_PROXY` for Node programs the app starts.

## 检查清单

- [x] 已消化记忆库的历史经验，并逐条规避「历史坑」
- [x] 需求覆盖核心场景与边界场景
- [x] 每条需求有唯一 ID（FR-n），将在 design.md / tasks.md 中被引用
- [x] 验收标准使用 EARS 格式且可测
- [x] 已标注优先级（MoSCoW）
- [x] 范围边界（In/Out of Scope）明确
- [x] 非功能需求明确、尽量可量化
- [x] 依赖关系完整
