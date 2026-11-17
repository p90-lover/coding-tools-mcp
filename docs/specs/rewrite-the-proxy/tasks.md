# 任务清单：rewrite-the-proxy

## 概述

实现 rewrite-the-proxy 功能的任务分解。每条任务都要回链到需求（FR）与设计章节，确保不漏、不越界。

> **二元禁令（零容忍）**：本文件及后续实现的交付物中，禁止出现未填写的占位、未完成标记或省略号代码。

---

## 交付物清单（Scope-lock）

- **预计新建文件数**: 6 (3 modules, 3 test files)
- **预计修改文件数**: 14
- **预计新增/修改函数数**: about 45
- **交付物逐项列举**:
  1. `desktop-electron/electron/egress-router.cjs`: the worker router.
  2. `desktop-electron/electron/egress-routes.cjs`: route resolution, tokens, router URLs, NO_PROXY.
  3. `desktop-electron/electron/routed-agent.cjs`: the app's own Node requests through the router.
  4. `desktop-electron/tests/egress-router.test.cjs`, `tests/egress-routes.test.cjs`, `tests/routed-agent.test.cjs`.
  5. `electron/provider-network.cjs`: credentials policy, lifecycle with replacement, router start, env, sessions, login answers, test with exit IP, status for IPC.
  6. `electron/provider-bootstrap.cjs`, `electron/preload.cjs`, `src/types.ts`: new IPC.
  7. `electron/managed-external-services.cjs`, `electron/cpa-managed.cjs`: CPA on router URLs, per-credential `proxy_url`.
  8. `electron/main.cjs`, `electron/update.cjs`, `electron/chatgpt-desktop.cjs`, `electron/antigravity-auth-browser.cjs`, `electron/signed-proxy-relay.cjs`: consumers.
  9. `src/features/NetworkProxySurface.tsx`, `src/features/network-proxy.css`: the page, rewritten in place.
  10. Updated tests: `network-proxy-surface`, `network-proxy-localization`, `rc2-paseo-anneal-network-surfaces`, `cpa-outbound-proxy`, `signed-proxy-relay`, `provider-network-save`, `proxy-sign-in-check`.

---

## 文件变更清单

| 文件 | 变更 | 任务 |
|------|------|------|
| `desktop-electron/electron/egress-router.cjs` | 新建 | 1.1 |
| `desktop-electron/electron/egress-routes.cjs` | 新建 | 1.2 |
| `desktop-electron/electron/routed-agent.cjs` | 新建 | 1.3 |
| `desktop-electron/tests/egress-router.test.cjs` | 新建 | 1.1 |
| `desktop-electron/tests/egress-routes.test.cjs` | 新建 | 1.2 |
| `desktop-electron/tests/routed-agent.test.cjs` | 新建 | 1.3 |
| `desktop-electron/electron/provider-network.cjs` | 修改 | 2.1, 2.2, 2.5 |
| `desktop-electron/electron/provider-bootstrap.cjs` | 修改 | 2.2, 2.5 |
| `desktop-electron/electron/preload.cjs` | 修改 | 2.5 |
| `desktop-electron/src/types.ts` | 修改 | 2.5 |
| `desktop-electron/electron/managed-external-services.cjs` | 修改 | 2.3 |
| `desktop-electron/electron/cpa-managed.cjs` | 修改 | 2.3 |
| `desktop-electron/electron/main.cjs` | 修改 | 2.4 |
| `desktop-electron/electron/update.cjs` | 修改 | 2.4 |
| `desktop-electron/electron/chatgpt-desktop.cjs` | 修改 | 2.4 |
| `desktop-electron/electron/antigravity-auth-browser.cjs` | 修改 | 2.4 |
| `desktop-electron/electron/signed-proxy-relay.cjs` | 修改 | 2.4 |
| `desktop-electron/src/features/NetworkProxySurface.tsx` | 修改（重写） | 2.6 |
| `desktop-electron/src/features/network-proxy.css` | 修改（重写） | 2.6 |
| pinned tests (`network-proxy-surface`, `network-proxy-localization`, `rc2-paseo-anneal-network-surfaces`, `cpa-outbound-proxy`, `signed-proxy-relay`, `provider-network-save`, `proxy-sign-in-check`) | 修改 | 3.1 |

---

## 任务列表

### 阶段 1: 准备工作

- [ ] 1.1 Build the egress router worker with token checks, HTTP/HTTPS/SOCKS4a/SOCKS5 upstreams signed on the first request, fail-closed errors, live route table, reconnect, open ports and stats
  - **证据块**: `electron/signed-proxy-relay.cjs:37-103` forwards to one HTTP(S) proxy with a fixed `authorization` and accepts any local client (`server.listen(0, "127.0.0.1")`, no client check); `:127-128` rejects SOCKS.
  - **涉及文件**: `electron/egress-router.cjs` (about 450 lines; worker body and host side in one file, the worker body kept self-contained as the relay is today); `tests/egress-router.test.cjs`.
  - _需求: FR-1, FR-4, FR-5_ ｜ _设计: 技术选型, 决策 1, 决策 3, 决策 5_
- [ ] 1.2 Write route resolution, tokens and router URLs: credential → provider → cpa → global → direct, legacy provider ids, broken routes, one NO_PROXY list
  - **证据块**: `electron/provider-execution-router.cjs:106-154` resolves account → provider → global but nothing applies it; `electron/provider-network.cjs:32` `DEFAULT_BYPASS` vs `managed-external-services.cjs:15-21`.
  - **涉及文件**: `electron/egress-routes.cjs` (about 220 lines); `tests/egress-routes.test.cjs`.
  - _需求: FR-2, FR-3, FR-6.2_ ｜ _设计: 架构设计, 数据模型_
- [ ] 1.3 Write the routed https.Agent for the app's own Node requests
  - **证据块**: `electron/update.cjs:202-210` falls back to Node https direct; worker fetches in `off-thread-run.cjs` use plain fetch.
  - **涉及文件**: `electron/routed-agent.cjs` (about 90 lines); `tests/routed-agent.test.cjs`.
  - _需求: FR-2, FR-8_ ｜ _设计: 技术选型_

---

### 阶段 2: 核心实现

- [ ] 2.1 Store: credentials policy, router port and key, lifecycle that asks for a replacement instead of dropping references, provider ids read as CPA types
  - **证据块**: `electron/provider-network.cjs:796` `dropProxyReferences` turns global off; `:822-881` provider/account policies; `:300-377` secrets.
  - **涉及文件**: `electron/provider-network.cjs` (store part, about +160 lines).
  - _需求: FR-3, FR-6, NFR-3_ ｜ _设计: 数据模型, 决策 3_
- [ ] 2.2 Controller: start the router before any consumer, push the resolved table on every change, set the child env to the router URL, route every Chromium session to the router and answer its 407 with the session's token
  - **证据块**: `electron/provider-network.cjs:1316-1338` `applyGlobalEnvironment` puts `proxyUrl(profile, secret)` (the password) in `HTTP(S)_PROXY`; `:1344-1383` `applyGlobalRouting`; `:1868-1890` `handleProxyLogin` answers only the proxy's own host and port; `electron/provider-bootstrap.cjs:141,164` env first, routing fire-and-forget.
  - **涉及文件**: `electron/provider-network.cjs` (controller part), `electron/provider-bootstrap.cjs`.
  - _需求: FR-1, FR-2, FR-4, FR-5_ ｜ _设计: 架构设计, 决策 2_
- [ ] 2.3 CPA: `proxy-url` = router `cpa` token; each credential file's `proxy_url` = its credential token; the Provider Manager plugin and API-key groups get provider tokens; verify live on one credential that CPA uses its `proxy_url`
  - **证据块**: `electron/managed-external-services.cjs:31-66` `resolveCpaProxyRoute` returns the signed proxy URL; live `config.yaml` `proxy-url` still names the Decodo proxy with Global Routing off; CPA 8.0.63 has `ProxyURL json:"proxy_url,omitempty"`.
  - **涉及文件**: `electron/managed-external-services.cjs`, `electron/cpa-managed.cjs`.
  - _需求: FR-2.2, FR-3_ ｜ _设计: 决策 4_
- [ ] 2.4 Consumers: the launcher fetch on the App route, the updater fallback, the register host, ChatGPT Desktop open port, the Antigravity sign-in window on its provider route, the old relay module as a facade
  - **证据块**: `electron/main.cjs:551-576` reads through `browserHost.partition`; `main.cjs:589` register host `setProxy({mode:"direct"})`; `electron/chatgpt-desktop.cjs:87-97` bare URL; `electron/antigravity-auth-browser.cjs:23-30,68-74`.
  - **涉及文件**: `electron/main.cjs`, `electron/update.cjs`, `electron/chatgpt-desktop.cjs`, `electron/antigravity-auth-browser.cjs`, `electron/signed-proxy-relay.cjs`.
  - _需求: FR-2, FR-8_ ｜ _设计: 决策 5_
- [ ] 2.5 Tests with exit IP and country, IPC for router status, credential policy, reconnect, replacement on archive
  - **证据块**: `electron/provider-network.cjs:1026` `testProxyEndpoint` CONNECTs to github.com only; `electron/provider-bootstrap.cjs:225-297` IPC handlers; `electron/preload.cjs:241,260-265`.
  - **涉及文件**: `electron/provider-network.cjs`, `electron/provider-bootstrap.cjs`, `electron/preload.cjs`, `src/types.ts`.
  - _需求: FR-5, FR-6, FR-7, FR-9_ ｜ _设计: API 设计_
- [ ] 2.6 Rewrite the Proxy page in place: status header, proxies with test details, routes table with friendly names and effective routes, programs, Decodo, EN + zh-TW
  - **证据块**: `src/features/NetworkProxySurface.tsx:298-400` (header switch with no text, hover-only tools and errors, Routes `<details>` with raw ids, "Proxy" mode sends `profileId: undefined`); `src/features/network-proxy.css` `px-` classes.
  - **涉及文件**: `src/features/NetworkProxySurface.tsx` (about 700 lines; split into the page plus `NetworkProxyParts.tsx` for cards, routes and programs if it passes 500), `src/features/network-proxy.css`.
  - _需求: FR-9_ ｜ _设计: 文件结构_

---

### 阶段 3: 集成测试

- [ ] 3.1 Run the focused suites and update the pinned tests deliberately
  - **证据块**: `tests/network-proxy-surface.test.cjs` depends on `useState` order and class names; `tests/network-proxy-localization.test.cjs` pins zh-TW strings; `tests/rc2-paseo-anneal-network-surfaces.test.cjs:40-60` pins IPC names.
  - **涉及文件**: the test files listed in the deliverables.
  - _需求: FR-1 to FR-9_ ｜ _设计: 测试策略_
- [ ] 3.2 Verify live in the installed build: exit IP per path, CPA credential token traffic, children's env, live route change with no restart
  - **证据块**: memory `coding-tools-proxy-route`: the Cloudflare trace through CDP proves the exit; `procenv.ps1` shows a process's proxy host without the password.
  - **涉及文件**: scratch scripts only.
  - _需求: FR-2, FR-3, FR-5_ ｜ _设计: 测试策略_

---

## 检查点

- [ ] 阶段 1 完成后：the router, resolution and agent tests pass with loopback fakes (HTTP, SOCKS5 with sign-in, origin).
- [ ] 阶段 2 完成后：the app starts with the router, the env names 127.0.0.1 only, and CPA's config has no proxy password; the focused suites pass.
- [ ] 阶段 3 完成后：live trace shows the selected exit on every path, and a route change moves it without restarts.

---

## 需求覆盖矩阵

| 需求 ID | 设计章节 | 任务编号 | 状态 |
|---------|----------|----------|------|
| FR-1 | 决策 1, 技术选型 | 1.1, 2.2 | 未开始 |
| FR-2 | 架构设计, 决策 2 | 1.2, 1.3, 2.2, 2.3, 2.4 | 未开始 |
| FR-3 | 决策 4, 数据模型 | 1.2, 2.1, 2.3 | 未开始 |
| FR-4 | 技术选型 | 1.1, 2.2 | 未开始 |
| FR-5 | 决策 2 | 1.1, 2.2, 2.5 | 未开始 |
| FR-6 | 决策 3 | 2.1, 2.5 | 未开始 |
| FR-7 | API 设计 | 2.5 | 未开始 |
| FR-8 | 技术选型 | 1.3, 2.4 | 未开始 |
| FR-9 | 文件结构 | 2.5, 2.6 | 未开始 |
