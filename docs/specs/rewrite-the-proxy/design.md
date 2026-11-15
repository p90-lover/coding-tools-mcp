# 设计文档：rewrite-the-proxy

## 概述

One loopback **egress router** becomes the only way the app and everything it starts reaches the network. Consumers never get a proxy's address or password; they get the router's address and a **route token** that names who they are (App, a model provider, a CPA credential, a Browser-tab account). The router looks up that target's route on every new connection and forwards through it, signed in, or fails. Route changes therefore apply live, passwords stay in the app, and per-provider and per-account routes become enforceable because CPA can give each credential its own token.

**对应需求:** FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7, FR-8, FR-9, NFR-1, NFR-2, NFR-3, NFR-4

---

## 技术方案

### 技术选型

| 类别 | 选择 | 理由 | 关联需求 |
|------|------|------|----------|
| Router runtime | Node `http` server in a `worker_threads` worker, as `signed-proxy-relay.cjs` does today | Off the main thread (NFR-1); the existing relay already proves the pattern in this app | FR-1 |
| Client protocol | HTTP proxy: CONNECT and absolute-form requests, `Proxy-Authorization: Basic <token>:<key>` | Every consumer speaks it (Chromium, Node, Bun, Go, Rust reqwest, git, curl, Python) | FR-1, FR-4 |
| Upstream protocols | HTTP and HTTPS (CONNECT with Proxy-Authorization), SOCKS5 (RFC 1928 + RFC 1929 sign-in, remote DNS), SOCKS4a | The four protocols a profile can have; Chromium and Node cannot sign in to SOCKS themselves | FR-4 |
| Chromium sessions | `session.setProxy` to the router; `app.on("login")` answers the router's 407 with the session's token | Chromium cannot put credentials in proxy rules | FR-2, FR-3 |
| Programs the app starts | `HTTP(S)_PROXY`/`ALL_PROXY=http://<token>:<key>@127.0.0.1:<port>`, `NO_PROXY` loopback list, `NODE_USE_ENV_PROXY=1` | Constant URL: route changes need no restart; no password in the environment | FR-2, FR-4, FR-5 |
| CPA | global `proxy-url` = router with the `cpa` token; each credential's `proxy_url` = router with its credential token; API-key groups and the Provider Manager plugin get provider tokens | CPA's own per-credential proxy, so the router knows whose traffic it is | FR-3 |
| App's own Node requests | an `https.Agent` whose `createConnection` opens a CONNECT through the router (`routed-agent.cjs`) | Works in workers and on Node versions without env-proxy support | FR-2, FR-8 |
| Exit check | `https://www.cloudflare.com/cdn-cgi/trace` through the profile | Plain text `ip=` and `loc=`, no account, already used for diagnosis | FR-7 |

### 架构设计

```
 Chromium sessions ──(setProxy, 407 → app.on("login") token)──┐
 App Node requests ──(routed https.Agent, app token)──────────┤
 AO, agents, tools, bridge, tunnel, MCP servers ──(env URL)───┤
 ChatGPT Desktop instances ──(per-instance open port, app)────┤      ┌────────────── route table (pushed by main)
 CPA default ──(proxy-url, cpa token)─────────────────────────┤      │ token → target
 CPA credential X ──(auth file proxy_url, credential token)───┼──▶ Egress router (worker, 127.0.0.1:<stable port>)
 Provider Manager plugin ──(plugin proxy-url, provider token)─┘      │ target → route: proxy profile + sign-in | direct | broken
                                                                     │ per-target stats → main → Proxy page
                                                                     ▼
                                                upstream proxy (HTTP / HTTPS / SOCKS4a / SOCKS5, signed) or direct
```

Resolution (in main, `egress-routes.cjs`):

- **App traffic:** App (global route) → Direct when off.
- **Model traffic:** credential → provider → "All model providers" (`cpa` row) → global → Direct.
- **Browser-tab account:** its binding → global → Direct.
- A route naming a missing or disabled proxy is **broken**: its connections fail with a clear error, never direct.

Main pushes the flat result (target → { mode, endpoint, sign-in } and token → target) to the worker on every change. The worker does lookups only.

---

## 数据模型

`provider-network.json` (`routing`), extended; existing fields keep their meaning (NFR-3):

| 实体/字段 | 类型 | 约束 | 说明 |
|-----------|------|------|------|
| `routing.globalEnabled`, `routing.globalProfileId` | bool, string | as today | App route |
| `routing.providers[]` `{providerId, inheritGlobal, profileId?}` | list | `providerId` is `cpa` (all model providers) or a CPA provider type (`codex`, `claude`, `gemini`, `antigravity`, `provider-manager`, `openai-compatibility:<name>` …); legacy app ids (`codex-oauth`, `claude-oauth`, `cliproxyapi-antigravity`, `gemini-oauth`) are read as their CPA type | provider routes |
| `routing.credentials[]` `{authName, mode: "follow"\|"direct"\|"profile", profileId?}` | list, new | `authName` = CPA auth file name | per-credential routes |
| `routing.accounts[]` | list | kept, read for its CPA credential when it names one | legacy |
| `router` `{port}` | object, new | 1024–65535 | the port to reuse |
| `secrets.router` | encrypted string, new | 32 random bytes, hex | the router key |

In memory only, worker → main: per target `{open, total, lastOkAt, lastError, lastErrorAt, upstream}`.

---

## API 设计

| 方法/函数 | 路径/签名 | 入参 | 出参 | 关联需求 |
|-----------|-----------|------|------|----------|
| `startEgressRouter` | `egress-router.cjs` | `{ port?, key, onEvent }` | `{ port, setRoutes(table), openPort(target) → port, closePort(port), reconnect(target), stats() , close() }` | FR-1, FR-5 |
| `resolveEgressRoutes` | `egress-routes.cjs` | store snapshot, credentials list, browser bindings | `{ targets: {id: {mode, profileId?, endpoint?, broken?}}, tokens }` | FR-2, FR-3, FR-6 |
| `routeToken` / `routerUrl` | `egress-routes.cjs` | target id, key, port | `http://<token>:<key>@127.0.0.1:<port>` | FR-4 |
| `createRoutedAgent` | `routed-agent.cjs` | router URL | `https.Agent` | FR-8 |
| IPC `launcher:egress-status` | preload `egressStatus()` | — | `{ router: {port, running, error}, targets: [...stats], consumers: [...] }` | FR-9 |
| IPC `launcher:proxy-credential-policy` | preload `setCredentialProxyPolicy({authName, mode, profileId?})` | | snapshot | FR-3 |
| IPC `launcher:proxy-reconnect` | preload `reconnectProxyTarget(target)` | | `{closed}` | FR-5 |
| IPC `launcher:proxy-test` (extended result) | `testProxyProfile(id)` | | adds `exitIp`, `exitCountry`, `checkedAt` | FR-7 |
| `archiveProxyProfile(id, {replacement})` | extended | `replacement`: profile id or `"direct"` | snapshot | FR-6 |

---

## 文件结构

```
desktop-electron/
├── electron/egress-router.cjs          (new: the worker router; HTTP/HTTPS/SOCKS upstreams, tokens, stats)
├── electron/egress-routes.cjs          (new: route resolution, tokens, router URLs, NO_PROXY)
├── electron/routed-agent.cjs           (new: https.Agent through the router for the app's own Node requests)
├── electron/signed-proxy-relay.cjs     (kept; re-exports from egress-router for old callers)
├── electron/provider-network.cjs       (routing model, credentials policy, lifecycle, controller wiring)
├── electron/provider-bootstrap.cjs     (IPC, startup order: router before consumers)
├── electron/managed-external-services.cjs, electron/cpa-managed.cjs (CPA proxy-url, per-credential proxy_url)
├── electron/main.cjs                    (launcher fetch on the App route, register host, login answers)
├── electron/update.cjs                  (fallback through the routed agent)
├── electron/chatgpt-desktop.cjs         (per-instance open port)
├── electron/antigravity-auth-browser.cjs (provider route)
├── electron/preload.cjs, src/types.ts   (new IPC)
├── src/features/NetworkProxySurface.tsx (rewritten in place)
├── src/features/network-proxy.css       (rewritten in place)
└── tests/egress-router.test.cjs, tests/egress-routes.test.cjs, tests/network-proxy-surface.test.cjs (updated) …
```

---

## 设计决策

### 决策 1: one router with route tokens（关联需求: FR-1, FR-3, FR-5）

**问题**: Routes are applied three different ways, per-provider routes are not applied at all, and running programs keep old routes.

**选项**:
1. Configure each consumer with its proxy (env per process, CPA per credential, Chromium per session) and restart on change.
2. One router; consumers get a constant router URL and a token naming the target; the router resolves live.

**决策**: 选择 2.

**理由**: One place enforces and observes everything; route changes are live; per-credential routes need only a constant token per credential; passwords never leave the app.

### 决策 2: programs point at the router even when routing is off（关联需求: FR-5, NFR-4）

**问题**: Pointing children at the router while Direct makes their traffic depend on the app's router.

**选项**:
1. Give children no proxy while Direct; switching on then needs every program restarted.
2. Always the router; it forwards direct for Direct targets.

**决策**: 选择 2.

**理由**: The user's ask is that a selected route covers everything; restarts interrupt chats. The router is in-process with the app, restarts on the same port, and the programs it serves end with the app.

### 决策 3: fail closed（关联需求: FR-1.4, FR-4.3, FR-6.2）

**问题**: Today a broken relay, a refused or unreadable sign-in, or a removed proxy falls back to the bare URL or to direct.

**决策**: A routed target never falls back. Only an explicit Direct is direct.

**理由**: "Route all traffic" is a guarantee; a silent fallback leaks the real IP and hides the fault.

### 决策 4: per-credential CPA tokens（关联需求: FR-3）

**问题**: CPA has one global proxy; the router cannot tell whose request a connection is.

**选项**:
1. Several CPA instances.
2. CPA's per-credential `proxy_url`, each with its own token.

**决策**: 选择 2, verified live on one credential before it is relied on.

**理由**: CPA supports it, needs no restart for later route changes, and new credentials fall back to the `cpa` token.

### 决策 5: programs that cannot answer a 407 get a per-instance open port（关联需求: FR-2）

**问题**: ChatGPT Desktop instances are separate Chromium apps, whose `--proxy-server` cannot carry a sign-in.

**决策**: The router opens a loopback port for that one instance, bound to the App target, and closes it when the instance ends.

**理由**: It routes them without a password on the command line, and the port lives only as long as the instance.

---

## 测试策略

- **`egress-router.test.cjs`**: a fake HTTP proxy, a fake SOCKS5 server with sign-in, and a fake origin, all on loopback.
  - Token checks: no token, a wrong key and an unknown target are refused.
  - CONNECT and absolute-form forwarding.
  - Sign-in on the first request.
  - 407 and unreachable upstreams fail without a direct fallback.
  - Live route change and reconnect.
  - Stats.
  - An open port.
- **`egress-routes.test.cjs`**:
  - The resolution chain, legacy provider ids and broken routes.
  - Tokens stay stable across changes.
  - NO_PROXY.
- **Updated tests**:
  - provider-network: lifecycle with replacement, credentials policy.
  - CPA config: router URLs, never passwords.
  - Proxy page: render tests, localization.
- **Live checks** (CDP and process environment, no secrets printed):
  - Cloudflare trace from the ChatGPT pane, the updater path and a chat tool.
  - CPA model requests through the router's counters.
  - `HTTPS_PROXY` of AO and an agent names 127.0.0.1.
  - The exit IP changes when the route changes, with no restart.

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| CPA ignores `proxy_url` in an OAuth credential file | 高 | Verify on one credential first; if ignored, credential routes are marked unsupported and provider routes use CPA groups |
| Router port taken after an update | 中 | Stored port tried first, then a new one; programs still on the old port are shown "Restart to follow" |
| Router stops | 高 | Restarted at once on the same port; connections fail meanwhile (never direct); a "router stopped" banner |
| Streaming throughput through the worker | 中 | Tunnels are byte pipes; measure before and after on a model stream |
| A program ignores proxy variables | 中 | Listed as "Not routed" on the page; known: the user's own Chrome |
| Large change to a shared, CI-guarded file set | 中 | No file deletions; old relay module kept as a facade; focused tests per file |

---

## 检查清单

- [x] 技术方案与现有架构一致
- [x] requirements.md 中每条 FR 都被本设计覆盖（或注明不涉及）
- [x] 文件结构对照真实代码库，路径可定位
- [x] 数据模型 / 接口契约清晰（含类型与约束）
- [x] 关键设计决策已记录并关联需求
- [x] 测试策略可验证验收标准
