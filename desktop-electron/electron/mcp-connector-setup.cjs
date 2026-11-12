"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateConnectorName } = require("./connector-identity.cjs");
const { writePrivateFileAtomicAsync } = require("./atomic-file.cjs");
const { loadPastCloudflareCheck, matchBrowserUserAgent, SETUP_CHECK_WAIT_MS } = require("./chatgpt-cloudflare-check.cjs");
// An original result object is usable once during a held workspace operation, never after JSON persistence.
const freshConnectorResults = new WeakMap();
const UNVERIFIED_CONNECTOR = "Existing connector exact tunnel identity is unverified. Creation and connection were not attempted.";
const WORKSPACE_OWNER_REQUIRED = "Only a verified owner of this ChatGPT workspace can create its MCP connector. Add or sign in to the workspace owner account, refresh its workspace details, then retry.";
// Hosts Platform's own sign-in passes through while the setup reads tunnel ownership.
const PLATFORM_SIGN_IN_HOSTS = ["platform.openai.com", "auth.openai.com", "auth0.openai.com"];
const PLATFORM_SIGN_IN_UNFINISHED = "OpenAI Platform asked this account to sign in again, and the sign-in did not finish by itself. Sign in to OpenAI Platform with this ChatGPT account, then retry.";

function requireMcpWorkspaceOwner(context) {
  if (!["workspace", "personal"].includes(context?.workspaceStructure) || context.workspaceRole !== "account-owner") {
    throw new Error(WORKSPACE_OWNER_REQUIRED);
  }
}

// activeAccountId comes from a fresh ChatGPT request in the owned window, never the default alias
// or the JWT's possibly stale workspace claim. The token and unrelated account fields stay there.
function chatGptMcpContext({ user, auth, activeAccountId, accounts } = {}) {
  const unknown = () => new Error("ChatGPT workspace context is unknown. Reload the intended workspace and retry.");
  const userId = user?.id;
  if (typeof userId !== "string" || !/^user-[A-Za-z0-9_-]{1,120}$/.test(userId)) throw unknown();
  if (auth?.chatgpt_user_id !== userId) {
    throw new Error("ChatGPT authentication changed. Sign in to the intended account and retry.");
  }
  if (typeof activeAccountId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(activeAccountId)
    || !accounts || typeof accounts !== "object" || !Object.hasOwn(accounts, activeAccountId)) throw unknown();
  const entry = accounts[activeAccountId];
  const account = entry?.account;
  if (!account || account.account_id !== activeAccountId || typeof entry.can_access_with_session !== "boolean"
    || typeof account.is_deactivated !== "boolean") throw unknown();
  if (!entry.can_access_with_session || account.is_deactivated) {
    throw new Error("ChatGPT workspace access was denied. Select an accessible workspace and retry.");
  }
  if (!["workspace", "personal"].includes(account.structure)
    || typeof account.account_user_role !== "string" || !/^[a-z][a-z-]{0,63}$/.test(account.account_user_role)) throw unknown();
  for (const key of ["account_user_id", "account_owner_id", "organization_id", "workspace_type", "plan_type"]) {
    if (account[key] != null && (typeof account[key] !== "string" || !account[key] || account[key].length > 128)) throw unknown();
  }
  return {
    userId, workspaceId: activeAccountId, workspaceRole: account.account_user_role, workspaceStructure: account.structure,
    workspaceType: account.workspace_type ?? null, workspaceUserId: account.account_user_id ?? null,
    workspaceOwnerId: account.account_owner_id ?? null, chatGptOrganizationId: account.organization_id ?? null,
    planType: account.plan_type ?? null,
    ...(typeof account.name === "string" && account.name.trim() && account.name.length <= 200 ? { workspaceName: account.name.trim() } : {}),
    ...(typeof user.email === "string" && user.email.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) ? { userEmail: user.email } : {}),
  };
}

function chatGptMcpContextScript(activeAccountId) {
  return `(async () => {
    if (location.origin !== "https://chatgpt.com") throw new Error("Open the intended ChatGPT workspace before inspecting MCP access.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let session, auth, accounts, status = 0;
    const readJson = async response => {
      status = response.status;
      if (!response.ok || !(response.headers.get("content-type") || "").includes("application/json") || !response.body) throw new Error();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "", bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 1024 * 1024) { void reader.cancel().catch(() => {}); throw new Error(); }
          text += decoder.decode(chunk.value, { stream: true });
        }
        return JSON.parse(text + decoder.decode());
      } finally { reader.releaseLock(); }
    };
    try {
      session = await readJson(await fetch("/api/auth/session", { credentials: "include", cache: "no-store", redirect: "error",
        headers: { accept: "application/json" }, signal: controller.signal }));
      const token = session && session.accessToken;
      if (typeof token !== "string" || token.length > 65536 || token.split(".").length !== 3) throw new Error();
      const encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      auth = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")))["https://api.openai.com/auth"];
      accounts = await readJson(await fetch("/backend-api/accounts/check/v4-2023-04-27", {
        credentials: "include", cache: "no-store", redirect: "error", signal: controller.signal,
        headers: { accept: "application/json", authorization: "Bearer " + token, "chatgpt-account-id": ${JSON.stringify(activeAccountId)} },
      }));
    } catch {
      if (status === 401) throw new Error("ChatGPT verification is required in the intended account.");
      if (status === 403) throw new Error("ChatGPT workspace access was denied. Select an accessible workspace and retry.");
      throw new Error("ChatGPT workspace context is unknown. Reload the intended workspace and retry.");
    } finally { clearTimeout(timer); controller.abort(); }
    return (${chatGptMcpContext.toString()})({ user: session.user, auth, activeAccountId: ${JSON.stringify(activeAccountId)}, accounts: accounts.accounts });
  })()`;
}

function platformMcpOwnerContext({ user, organizationId, permissions, tunnels } = {}, tunnelId, chatGptContext) {
  const unknown = () => new Error("Platform tunnel ownership is unknown. Open the intended Platform organization and retry.");
  if (typeof user?.id !== "string" || !/^user-[A-Za-z0-9_-]{1,120}$/.test(user.id)
    || typeof chatGptContext?.userId !== "string") throw unknown();
  if (user.id !== chatGptContext.userId) {
    throw new Error("Platform authentication is different from the selected ChatGPT account. Sign in to the intended Platform account.");
  }
  if (typeof organizationId !== "string" || !/^org-[A-Za-z0-9_-]{1,120}$/.test(organizationId)
    || !Array.isArray(user.orgs?.data) || user.orgs.data.length > 1024) throw unknown();
  const memberships = user.orgs.data.filter(org => org?.id === organizationId);
  if (memberships.length !== 1 || typeof memberships[0].role !== "string"
    || !/^[a-z][a-z_-]{0,63}$/.test(memberships[0].role)) throw unknown();
  if (!Array.isArray(permissions?.data) || permissions.data.length > 1024) throw unknown();
  const access = { read: permissions.data.includes("api.organization.tunnel.read"),
    use: permissions.data.includes("api.organization.tunnel.use"), write: permissions.data.includes("api.organization.tunnel.write") };
  if (!access.read || !access.use) throw new Error("Platform tunnel access requires read and use permissions in the selected organization.");
  if (typeof tunnelId !== "string" || !/^tunnel_[a-f0-9]{32}$/.test(tunnelId)
    || !Array.isArray(tunnels?.tunnels) || tunnels.tunnels.length > 1024) throw unknown();
  const matches = tunnels.tunnels.filter(tunnel => tunnel?.id === tunnelId);
  if (matches.length !== 1 || typeof matches[0].creator !== "string"
    || !/^user-[A-Za-z0-9_-]{1,120}$/.test(matches[0].creator)) throw unknown();
  if (matches[0].creator !== user.id) {
    throw new Error("The selected tunnel belongs to a different Platform user. Choose a tunnel created by the signed-in account.");
  }
  const scope = (values, pattern) => Array.isArray(values) && values.length <= 1024
    && values.every(id => typeof id === "string" && pattern.test(id)) ? [...new Set(values)] : null;
  return {
    userId: user.id, tunnelId, tunnelCreatorId: matches[0].creator,
    platformOrganizationId: organizationId, platformOrganizationRole: memberships[0].role, permissions: access,
    // These are access scopes, not the tunnel's owning organization or a plan/capability decision.
    workspaceIds: scope(matches[0].workspace_ids, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i),
    organizationIds: scope(matches[0].organization_ids, /^org-[A-Za-z0-9_-]{1,120}$/),
  };
}

/**
 * Where a navigation the setup did not expect went: host and path only, with the query, fragment
 * and any unusual character dropped, so a failure can name the page without carrying its data.
 * "The browser navigation changed" alone left a Connect that failed every time on 2026-11-09
 * with nothing to say which page moved.
 */
function navigationPlace(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!["https:", "http:"].includes(url.protocol)) return url.protocol === "about:" || url.protocol === "data:" ? url.protocol.slice(0, -1) : null;
  if (!/^[a-z0-9.-]{1,253}$/i.test(url.hostname)) return null;
  return `${url.hostname}${url.pathname.replace(/[^A-Za-z0-9/_.-]/g, "").slice(0, 80)}`;
}

// The page's Personal plugins waits that leave their page state for the log (pageFailureState).
const PAGE_STATE_FAILURES = new Set([
  "ChatGPT did not expose one Personal plugins tab.",
  "The Personal plugins tab did not finish loading.",
  "The Personal plugins list did not finish loading, so the connector was not created.",
]);

/**
 * The page state a failed Personal plugins wait left, reduced to what a log record may keep:
 * counts, flags, two document states, timings and the path without its query or unusual characters.
 * Nothing else the page returns is copied, so a tab label or an account name cannot reach the log.
 */
function connectorPageState(value) {
  if (!value || typeof value !== "object") return null;
  const count = item => Number.isInteger(item) && item >= 0 && item <= 100_000 ? item : null;
  const ms = item => Number.isFinite(item) && item >= 0 ? Math.min(Math.round(item), 3_600_000) : null;
  const flag = item => typeof item === "boolean" ? item : null;
  const oneOf = (item, values) => values.includes(item) ? item : null;
  return {
    tabs: count(value.tabs), visibleTabs: count(value.visibleTabs), personalTabs: count(value.personalTabs),
    directoryLoading: flag(value.directoryLoading), personalPluginsLoaded: flag(value.personalPluginsLoaded),
    sawEmpty: flag(value.sawEmpty),
    path: typeof value.path === "string" && /^\/[A-Za-z0-9/_.~-]{0,200}$/.test(value.path) ? value.path.slice(0, 80) : null,
    view: flag(value.view),
    visibilityState: oneOf(value.visibilityState, ["visible", "hidden", "prerender"]),
    readyState: oneOf(value.readyState, ["loading", "interactive", "complete"]),
    waitedMs: ms(value.waitedMs), frameMs: ms(value.frameMs),
  };
}

/**
 * Rethrows a page failure, with the state a failed Personal plugins wait left attached as
 * `pageState` for the log. The error crosses executeJavaScript as its fixed text alone, so the
 * state is read back separately; its message (what the user sees) is unchanged.
 */
async function withPageState(popup, error) {
  if (error instanceof Error && PAGE_STATE_FAILURES.has(error.message) && !popup.isDestroyed()) {
    const state = await popup.webContents.executeJavaScript(
      "globalThis.__codingToolsConnectorHelpers?.pageFailureState?.() ?? null", true).catch(() => null);
    const pageState = connectorPageState(state);
    if (pageState) error.pageState = pageState;
  }
  throw error;
}

// Observe only the new setup window's normal requests. This never sends an API request or keeps
// authentication headers/raw bodies; callers must still verify fresh context before mutations.
async function observeMcpSetupContext(contents, tunnelId) {
  const client = contents?.debugger;
  const unavailable = () => new Error("MCP metadata inspection is unavailable in this browser window.");
  if (!client || client.isAttached() || (tunnelId !== null && !/^tunnel_[a-f0-9]{32}$/.test(tunnelId))) throw unavailable();
  const limit = 1024 * 1024;
  const requests = new Map(), organizations = new Map(), latest = new Map();
  let attached = false, disposed = false, user = null, organizationId = null, activeAccountId = null;
  let selectionVersion = 0, platformSelectionVersion = 0, platformIdentityVersion = 0, metadataVersion = 0, sequence = 0, error = null;
  let navigationRequest = null, navigationAccountId = null, navigationVersion = 0;
  const header = (headers, wanted) => {
    const key = Object.keys(headers || {}).find(name => name.toLowerCase() === wanted);
    return key && typeof headers[key] === "string" ? headers[key] : null;
  };
  const scope = (values, pattern) => Array.isArray(values) && values.length <= 1024
    && values.every(id => typeof id === "string" && pattern.test(id)) ? [...new Set(values)] : null;
  const failed = (fact, status = null) => {
    if (disposed) return;
    error = status === null ? "MCP ownership metadata is unavailable or exceeded its bound."
      : `MCP ownership metadata request was denied or unavailable (HTTP ${status}).`;
    metadataVersion++;
    if (fact.kind === "chatgpt") { activeAccountId = null; selectionVersion++; }
    else if (fact.kind === "login") user = null;
    else if (fact.org) organizations.delete(fact.org);
    else { if (organizationId !== null) platformSelectionVersion++; organizationId = null; }
  };
  const onDetach = () => { if (!disposed) {
    attached = false; user = null; organizations.clear(); platformIdentityVersion++; metadataVersion++;
    if (organizationId !== null) platformSelectionVersion++;
    organizationId = null; error = "MCP metadata inspection disconnected.";
  } };
  const onMessage = (_event, method, params) => {
    if (disposed || !params || typeof params.requestId !== "string") return;
    const id = params.requestId;
    if (method === "Network.requestWillBeSent") {
      requests.delete(id); // A redirect cannot carry a previous origin's metadata identity.
      if (navigationRequest?.id === id) { navigationRequest = null; navigationAccountId = null; }
      const request = params.request;
      let url;
      try { url = new URL(request?.url); } catch { return; }
      let kind = null;
      if (url.origin === "https://chatgpt.com" && request.method === "GET"
        && ["/backend-api/models", "/backend-api/conversations"].includes(url.pathname)) {
        const account = header(request.headers, "chatgpt-account-id");
        if (typeof account === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(account)) {
          navigationRequest = { id, account, path: url.pathname }; navigationAccountId = null;
        }
        return;
      }
      // The plugins page's own list request names the workspace it shows. ChatGPT replaced the
      // POST list_accessible with GET ps/plugins/list (seen live 2026-11-09); with only the old
      // one known, no workspace was ever confirmed and every Connect failed.
      if (url.origin === "https://chatgpt.com" && ((request.method === "POST"
        && url.pathname === "/backend-api/aip/connectors/mcp/list_accessible")
        || (request.method === "GET" && url.pathname === "/backend-api/ps/plugins/list"))) kind = "chatgpt";
      if (url.origin === "https://api.openai.com") {
        if (request.method === "POST" && url.pathname === "/v1/dashboard/onboarding/login") kind = "login";
        else if (request.method === "GET" && url.pathname === "/v1/dashboard/organization/permissions") kind = "permissions";
        else if (request.method === "GET" && url.pathname === "/v1/tunnels") kind = "tunnels";
      }
      if (!kind) return;
      if (tunnelId === null && kind !== "chatgpt") return;
      const org = header(request.headers, "openai-organization"), account = header(request.headers, "chatgpt-account-id");
      const fact = { kind, origin: url.origin, path: url.pathname,
        org: typeof org === "string" && /^org-[A-Za-z0-9_-]{1,120}$/.test(org) ? org : null,
        account: typeof account === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(account) ? account : null };
      fact.key = kind === "chatgpt" || kind === "login" ? kind : `${kind}:${fact.org}`;
      if (kind === "login") {
        // Permissions/tunnel records belong to the identity that fetched them, even within one org.
        platformIdentityVersion++; user = null; organizations.clear(); metadataVersion++;
        if (organizationId !== null) platformSelectionVersion++;
        organizationId = null;
        for (const [key, pending] of requests) if (pending.kind !== "chatgpt") requests.delete(key);
        for (const key of latest.keys()) if (key !== "chatgpt") latest.delete(key);
      }
      fact.identityVersion = platformIdentityVersion;
      if (requests.size >= 128 || (fact.org && organizations.size >= 16 && !organizations.has(fact.org))
        || (latest.size >= 64 && !latest.has(fact.key))) { failed(fact); return; }
      fact.sequence = ++sequence;
      latest.set(fact.key, fact.sequence);
      // Invalidate captured proof as soon as a different context is requested, before its response.
      if (kind === "chatgpt" && activeAccountId !== fact.account) { activeAccountId = null; selectionVersion++; }
      else if (kind !== "chatgpt" && kind !== "login") {
        if (!fact.org) { if (organizationId !== null) platformSelectionVersion++; organizationId = null; }
        else {
          const data = organizations.get(fact.org) || { permissions: null, tunnels: null };
          data[kind] = null;
          organizations.set(fact.org, data);
          if (kind === "tunnels" && organizationId !== fact.org) { organizationId = fact.org; platformSelectionVersion++; }
        }
        metadataVersion++;
      }
      requests.set(id, fact);
      return;
    }
    if (navigationRequest?.id === id && ["Network.responseReceived", "Network.loadingFailed"].includes(method)) {
      const pending = navigationRequest; navigationRequest = null;
      try {
        const url = new URL(params.response?.url);
        if (url.origin === "https://chatgpt.com" && url.pathname === pending.path && params.response.status >= 200
          && params.response.status < 300 && String(params.response.mimeType || "").includes("application/json")) {
          navigationAccountId = pending.account; navigationVersion++;
        }
      } catch {}
      return;
    }
    const fact = requests.get(id);
    if (!fact) return;
    if (latest.get(fact.key) !== fact.sequence || (fact.kind !== "chatgpt" && fact.identityVersion !== platformIdentityVersion)) { requests.delete(id); return; }
    if (method === "Network.loadingFailed") {
      requests.delete(id);
      // The page dropped its own request (a tab switch, a re-render, Platform's sign-in redirect):
      // no answer either way, so nothing is confirmed and nothing failed. Sending it already cleared
      // any different context it asked for, so only a later answered request can confirm that.
      if (params.canceled === true) return;
      failed(fact); return;
    }
    if (method === "Network.responseReceived") {
      let url;
      try { url = new URL(params.response?.url); } catch { requests.delete(id); failed(fact); return; }
      const status = params.response.status;
      if (url.origin !== fact.origin || url.pathname !== fact.path || !Number.isInteger(status)
        || !String(params.response.mimeType || "").toLowerCase().includes("application/json")) {
        requests.delete(id); failed(fact); return;
      }
      if (status < 200 || status >= 300) { requests.delete(id); failed(fact, status); return; }
      if (fact.kind === "chatgpt") {
        requests.delete(id);
        if (!fact.account) { failed(fact); return; }
        if (activeAccountId !== fact.account) { activeAccountId = fact.account; selectionVersion++; }
      } else fact.responseOk = true;
      return;
    }
    if (method !== "Network.loadingFinished") return;
    requests.delete(id);
    if (!fact.responseOk || (typeof params.encodedDataLength === "number" && params.encodedDataLength > limit)
      || (fact.kind !== "login" && !fact.org)) { failed(fact); return; }
    void client.sendCommand("Network.getResponseBody", { requestId: id }).then(result => {
      if (disposed || latest.get(fact.key) !== fact.sequence || fact.identityVersion !== platformIdentityVersion) return;
      if (typeof result?.body !== "string" || result.body.length > (result.base64Encoded ? Math.ceil(limit / 3) * 4 : limit)) throw unavailable();
      const text = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
      if (Buffer.byteLength(text) > limit) throw unavailable();
      const json = JSON.parse(text);
      if (fact.kind === "login") {
        if (typeof json?.user?.id !== "string" || !/^user-[A-Za-z0-9_-]{1,120}$/.test(json.user.id)
          || !Array.isArray(json.user.orgs?.data) || json.user.orgs.data.length > 1024) throw unavailable();
        user = { id: json.user.id, orgs: { data: json.user.orgs.data.filter(org => typeof org?.id === "string"
          && /^org-[A-Za-z0-9_-]{1,120}$/.test(org.id) && typeof org.role === "string" && /^[a-z][a-z_-]{0,63}$/.test(org.role))
          .map(org => ({ id: org.id, role: org.role })) } };
      } else {
        const data = organizations.get(fact.org) || { permissions: null, tunnels: null };
        if (fact.kind === "permissions") {
          if (!Array.isArray(json?.data) || json.data.length > 1024) throw unavailable();
          data.permissions = { data: json.data.filter(value => ["api.organization.tunnel.read", "api.organization.tunnel.use", "api.organization.tunnel.write"].includes(value)) };
        } else {
          if (!Array.isArray(json?.tunnels) || json.tunnels.length > 1024) throw unavailable();
          data.tunnels = { tunnels: json.tunnels.filter(tunnel => tunnel?.id === tunnelId).map(tunnel => ({ id: tunnelId,
            creator: typeof tunnel.creator === "string" && /^user-[A-Za-z0-9_-]{1,120}$/.test(tunnel.creator) ? tunnel.creator : null,
            workspace_ids: scope(tunnel.workspace_ids, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i),
            organization_ids: scope(tunnel.organization_ids, /^org-[A-Za-z0-9_-]{1,120}$/),
          })) };
        }
        organizations.set(fact.org, data);
      }
      metadataVersion++;
    }).catch(() => { if (latest.get(fact.key) === fact.sequence && fact.identityVersion === platformIdentityVersion) failed(fact); });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    client.off("message", onMessage);
    client.off("detach", onDetach);
    if (attached) { try { client.detach(); } catch {} }
    attached = false;
    requests.clear(); organizations.clear(); latest.clear(); user = null;
    navigationRequest = null; navigationAccountId = null;
  };
  try {
    client.attach("1.3"); attached = true;
    client.on("message", onMessage); client.on("detach", onDetach);
    await client.sendCommand("Network.enable", { maxTotalBufferSize: limit * 4, maxResourceBufferSize: limit });
  } catch { dispose(); throw unavailable(); }
  return {
    snapshot: () => structuredClone({ activeAccountId, selectionVersion, navigationAccountId, navigationVersion,
      platformSelectionVersion, platformIdentityVersion, metadataVersion, error,
      platform: { user, organizationId, permissions: organizations.get(organizationId)?.permissions ?? null,
        tunnels: organizations.get(organizationId)?.tunnels ?? null } }),
    dispose,
  };
}

function requireAutomaticConnectorSetup(runtimeHost, browserHost) {
  const snapshot = runtimeHost.runtimeConfigSnapshot(), config = snapshot.config;
  if (config?.browserInteractionMode === "manual" || browserHost?.interactionModeOverride === "manual"
    || browserHost?.getBrowserInteractionMode?.() === "manual") {
    throw Object.assign(new Error("MCP connector setup is disabled in Zero Risk mode."), { code: "manual_browser_inspection_disabled" });
  }
  if (!snapshot.configured || snapshot.owner !== "launcher" || config?.mode !== "full") {
    throw new Error("Connect the saved automatic MCP harness before creating its ChatGPT connector.");
  }
}

/**
 * Whether the automatic tunnel's runtime key is saved, read off the main thread once for a whole
 * connector operation; undefined when the host can only check it synchronously.
 */
async function connectorCredentials(runtimeHost) {
  if (typeof runtimeHost.mcpCredentialsConfiguredAsync !== "function") return undefined;
  return runtimeHost.mcpCredentialsConfiguredAsync(runtimeHost.runtimeConfigSnapshot().config, "automatic");
}

/**
 * The main tunnel's connector name and tunnel ID. `credentials` is connectorCredentials()'s answer
 * for an operation that checks again and again (every 50 ms while ChatGPT confirms a workspace):
 * the key file was then looked up on the main thread each time, and on the busy hard disk one
 * lookup held every window for up to 17.9 s (seen live 2026-11-09). Its config is cached.
 */
function currentConnectorSettings(runtimeHost, { credentials } = {}) {
  const snapshot = runtimeHost.runtimeConfigSnapshot();
  const config = snapshot.config;
  if (!snapshot.configured || snapshot.owner !== "launcher" || config?.mode !== "full"
    || config.browserInteractionMode === "manual" || !(credentials ?? runtimeHost.mcpCredentialsConfigured("automatic"))) {
    throw new Error("Connect the saved automatic MCP harness before creating its ChatGPT connector.");
  }
  const tunnel = config.automaticTunnel || (!config.manualTunnel ? config.tunnel : null);
  if (!tunnel || typeof tunnel.tunnelId !== "string" || !tunnel.tunnelId.trim()) {
    throw new Error("The active MCP configuration has no tunnel ID.");
  }
  // Deliberately select only public setup values; the runtime key and its file path stay local.
  return {
    name: validateConnectorName(runtimeHost.mcpConnectorName()),
    tunnelId: tunnel.tunnelId.trim(),
    transport: "tunnel",
    authentication: "none",
  };
}

// An extra tunnel's connector: the same connector name, in the ChatGPT account that owns the tunnel.
function extraConnectorSettings(runtimeHost, tunnelId) {
  if (typeof tunnelId !== "string" || !/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) {
    throw new Error("The tunnel has no valid tunnel ID.");
  }
  return {
    name: validateConnectorName(runtimeHost.mcpConnectorName()),
    tunnelId,
    transport: "tunnel",
    authentication: "none",
  };
}

async function readAccountConnectorBindings(app) {
  let handle;
  try {
    handle = await fs.promises.open(path.join(app.getPath("userData"), "mcp-account-connector-bindings.json"), "r");
    if (!(await handle.stat()).isFile()) throw new Error();
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 64 * 1024) throw new Error();
    const saved = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (saved?.version !== 1 || !saved.bindings || typeof saved.bindings !== "object" || Array.isArray(saved.bindings)) throw new Error();
    if (saved.scopedBindings !== undefined && (!saved.scopedBindings || typeof saved.scopedBindings !== "object" || Array.isArray(saved.scopedBindings))) throw new Error();
    const bindings = Object.create(null), scopedBindings = Object.create(null);
    const partition = value => typeof value === "string" && /^persist:[A-Za-z0-9_-]{1,160}$/.test(value);
    const clean = value => {
      try {
        if (!/^tunnel_[a-f0-9]{32}$/.test(value?.tunnelId) || typeof value.href !== "string" || value.href.length > 512) return null;
        const url = new URL(value.href, "https://chatgpt.com");
        if (url.origin !== "https://chatgpt.com" || url.username || url.password || !url.pathname.startsWith("/plugins/")) return null;
        const hint = { name: validateConnectorName(value.name), tunnelId: value.tunnelId, href: url.pathname };
        for (const key of ["userId", "publisherUserId"]) if (typeof value[key] === "string" && /^user-[A-Za-z0-9_-]{1,120}$/.test(value[key])) hint[key] = value[key];
        if (typeof value.workspaceId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.workspaceId)) hint.workspaceId = value.workspaceId;
        if (partition(value.publisherPartition)) hint.publisherPartition = value.publisherPartition;
        return hint;
      } catch { return null; }
    };
    for (const [key, value] of Object.entries(saved.bindings)) {
      const hint = clean(value); if (partition(key) && hint) bindings[key] = hint;
    }
    for (const [key, value] of Object.entries(saved.scopedBindings || {})) {
      const hint = clean(value);
      try {
        const scope = JSON.parse(key);
        if (hint && Array.isArray(scope) && scope.length === 4 && partition(scope[0])
          && scope[1] === hint.workspaceId && scope[2] === hint.tunnelId && scope[3] === hint.name) scopedBindings[key] = hint;
      } catch { /* Invalid cached fields never become provenance or get copied forward. */ }
    }
    return { version: 1, bindings, scopedBindings };
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("Saved account connector bindings could not be read; they were kept for recovery.");
    return { version: 1, bindings: Object.create(null), scopedBindings: Object.create(null) };
  } finally { await handle?.close(); }
}

function accountConnectorBinding(saved, partition, { workspaceId, tunnelId, name }) {
  if (typeof partition !== "string") return undefined;
  const scoped = saved.scopedBindings?.[JSON.stringify([partition, workspaceId, tunnelId, name])];
  const legacy = saved.bindings[partition];
  return [scoped, legacy].find(value => value && value.workspaceId === workspaceId && value.tunnelId === tunnelId
    && (value.name === undefined || value.name === name));
}

// The pinned extension's content script ships with the app and does not change while it runs, so it
// is read once, off the main thread as this module loads. Read on every setup step, it held every
// window 668 ms during an MCP connector setup on the busy hard disk (0.8.104, 2026-11-09). A call
// before that read lands reads it here, once.
const EXTENSION_CONTENT_SCRIPT = path.join(__dirname, "extensions", "fast-access", "content.js");
let extensionContentScript = null;
fs.promises.readFile(EXTENSION_CONTENT_SCRIPT, "utf8")
  .then((text) => { extensionContentScript ??= text; }, () => { /* read on first use, which reports a missing file */ });

function extensionHelpersSource({ testLegacy = false } = {}) {
  const source = extensionContentScript ??= fs.readFileSync(EXTENSION_CONTENT_SCRIPT, "utf8");
  const boundary = source.indexOf("  // Test seam.");
  if (boundary < 0) throw new Error("The pinned MCP extension helper boundary is missing.");
  // Reuse the extension's detection/form logic without registering its Chrome worker or Sync flow.
  return source.slice(0, boundary).replace(
    "const canonicalAppIdentity = (value) => normalize(value).replace(/[^\\p{L}\\p{N}]+/gu, '');",
    "const canonicalAppIdentity = (value) => normalize(value);",
  ) + `
  // The directory is still painting: its loader line or one of its skeletons is on screen.
  function directoryLoading() {
    const loading = [...document.querySelectorAll('main *')].some(element =>
      ['loading plugins', 'loading plugins…', 'loading plugins...'].includes(normalize(element.innerText ?? element.textContent))
      && visible(element));
    return loading || Boolean(document.querySelector('main [data-testid="plugin-source-tabs-placeholder"],main [data-testid="directory-section-heading-skeleton"],main [data-testid="plugin-row-skeleton-icon-frame"]'));
  }
  function personalPluginsLoaded() {
    const selected = [...document.querySelectorAll('main [role="tab"][aria-selected="true"]')]
      .some(tab => textMatches(tab, PERSONAL_VIEW_LABELS, true));
    return selected && !directoryLoading();
  }
  // ChatGPT shows no Personal tab while an account's personal list is empty, and drops
  // ?view=personal on the way (the extension's ensurePersonalView relies on the same). Until
  // 2026-11-09 the setup read that as a page that failed: "ChatGPT did not expose one Personal
  // plugins tab" on every account that had never created a plugin.
  //
  // Wrongly saying "empty" while a Personal tab is merely late would let Create add a second
  // connector beside an existing one, so this must prove emptiness, not guess it.
  //
  // Every sign is required: ChatGPT's own empty-list redirect (the bare plugins path, view dropped),
  // a tab bar that has finished painting, and no personal tab in it. If ChatGPT stops redirecting,
  // this reads "not empty" and the setup fails as it did before, never the other way round.
  // (No backslashes here: this text is a template literal.)
  function personalListEmpty() {
    let url;
    try { url = new URL(location.href); } catch { return false; }
    if (!['/plugins', '/plugins/'].includes(url.pathname) || url.searchParams.has('view')) return false;
    if (directoryLoading()) return false;
    const tabs = [...document.querySelectorAll('main [role="tab"]')].filter(tab => visible(tab));
    return tabs.length > 0 && !tabs.some(tab => textMatches(tab, PERSONAL_VIEW_LABELS, true));
  }
  // Empty, and still empty a moment later: a tab bar that is still filling in does not count.
  async function personalListSettledEmpty() {
    if (!personalListEmpty()) return false;
    await sleep(1500);
    return personalListEmpty();
  }
  // What the page showed when a Personal plugins wait gave up, kept for the setup's log only (read
  // back by the main process; a thrown error crosses executeJavaScript as its message alone).
  // "ChatGPT did not expose one Personal plugins tab." logged nothing else on 2026-11-12, so a slow
  // tab bar, a hidden one and a missing one read the same. Counts, flags and the path only: no tab
  // label, title, account or workspace name.
  let pageFailureState = null;
  async function personalPageFailure(message, started, sawEmpty = false) {
    const tabs = [...document.querySelectorAll('main [role="tab"]')];
    const shown = tabs.filter(tab => visible(tab));
    let url = null;
    try { url = new URL(location.href); } catch {}
    const state = {
      tabs: tabs.length, visibleTabs: shown.length,
      personalTabs: shown.filter(tab => textMatches(tab, PERSONAL_VIEW_LABELS, true)).length,
      directoryLoading: directoryLoading(), personalPluginsLoaded: personalPluginsLoaded(), sawEmpty,
      path: url ? url.pathname : null, view: Boolean(url && url.searchParams.has('view')),
      visibilityState: document.visibilityState, readyState: document.readyState, waitedMs: Date.now() - started,
    };
    // How long the next animation frame takes: a renderer that is not drawing shows as null.
    state.frameMs = await new Promise(resolve => {
      const begun = performance.now();
      const timer = setTimeout(() => resolve(null), 1000);
      requestAnimationFrame(() => { clearTimeout(timer); resolve(Math.round(performance.now() - begun)); });
    });
    pageFailureState = state;
    return new Error(message);
  }
  function findManagedAppCard(name) {
    if (!personalPluginsLoaded()) return null;
    const wanted = canonicalAppIdentity(name);
    const openLabel = canonicalAppIdentity('open ' + name);
    const matches = pluginCardLinks().filter(link => {
      if (canonicalAppIdentity(link.getAttribute('aria-label')) === openLabel) return true;
      // Current cards use an empty overlay link labelled by a sibling title.
      const labelledTitle = (link.getAttribute('aria-labelledby') || '').trim().split(/\\s+/)
        .map(id => document.getElementById(id)?.textContent || '').join(' ');
      if (canonicalAppIdentity(labelledTitle) === wanted) return true;
      const card = link.closest('article,[role="article"]') || link;
      const heading = card.querySelector('h1,h2,h3,h4');
      return heading && canonicalAppIdentity(heading.innerText || heading.textContent) === wanted;
    });
    const identities = new Map(matches.map(link => [new URL(link.href, location.href).pathname, link]));
    if (identities.size > 1) throw new Error('More than one connector has the configured name.');
    return identities.values().next().value || null;
  }
  async function selectWorkspace(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('ChatGPT did not expose the target workspace name.');
    const profiles = allClickable(document).filter(element => visible(element)
      && normalize(element.getAttribute('aria-label')) === 'open profile menu');
    if (profiles.length !== 1) throw new Error('ChatGPT did not expose one workspace menu.');
    await pointerActivateMenu(profiles[0]);
    const choice = await waitFor(() => {
      const menus = [...document.querySelectorAll('[role="menu"],[role="dialog"]')].filter(visible);
      const candidates = menus.flatMap(menu => allClickable(menu).filter(element => visible(element)
        && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
        && normalize(element.innerText || element.textContent) === normalize(name)));
      return candidates.length === 1 ? candidates[0] : null;
    }, 5000);
    if (!choice) throw new Error('ChatGPT did not expose one matching workspace. Select it in that account and retry.');
    await pointerActivateMenu(choice);
    return { selected: true };
  }
  async function inspectTunnelConnectorIdentity(settings) {
    const unverified = () => new Error('Existing connector exact tunnel identity is unverified. Creation and connection were not attempted.');
    if (location.origin !== 'https://chatgpt.com' || !isPluginDetailUrl(location.href)) throw unverified();
    const pluginPath = location.pathname, main = document.querySelector('main');
    if (!main || !exactNameIn(main, settings.name)) throw unverified();
    const read = () => {
      if (location.pathname !== pluginPath) throw unverified();
      const root = activeSurface();
      if (root === document) return null;
      // Use the connector configuration component, never tool argument inputs or a page-wide URL.
      const fields = inputs(root).filter(element => element.id === 'custom-connector-tunnel-id' && element.getAttribute('type') !== 'password');
      const names = inputs(root).filter(element => element.id === 'custom-connector-name');
      const saves = allClickable(root).filter(element => !element.disabled && element.getAttribute('aria-disabled') !== 'true'
        && textMatches(element, ['Save', 'Save changes'], true));
      if (fields.length > 1 || names.length > 1 || saves.length > 1) throw unverified();
      if (fields.length !== 1 || names.length !== 1 || saves.length !== 1) return null;
      if (canonicalAppIdentity(names[0].value) !== canonicalAppIdentity(settings.name)) throw unverified();
      // A generic /mcp endpoint cannot establish an opaque tunnel ID. Read the saved Tunnel ID itself.
      if (fields[0].value !== settings.tunnelId) throw unverified();
      return { verified: true, href: pluginPath, name: settings.name, tunnelId: fields[0].value };
    };
    let identity = read();
    if (!identity) {
      const controls = allClickable(main).filter(element => !element.disabled && element.getAttribute('aria-disabled') !== 'true'
        && textMatches(element, [...STRINGS.manage, 'Edit'], true));
      if (controls.length !== 1) throw unverified();
      await pointerActivateMenu(controls[0]);
      identity = await waitFor(read, 5000);
    }
    if (!identity) throw unverified();
    if (visibleDialogs().length && !await closeOpenDialog()) throw unverified();
    return identity;
  }
  async function createTunnelConnector(settings, phase = 'legacy') {
    if (/just a moment|verify you are human|checking your browser/i.test(document.title + ' ' + (document.body?.innerText || '').slice(0, 300))) {
      throw new Error('Complete Cloudflare verification in Coding Tools Browser, then try again.');
    }
    if (location.origin !== 'https://chatgpt.com' || !isPersonalPluginsPage()
      || !settings || typeof settings.name !== 'string' || !settings.name.trim()
      || !/^tunnel_[a-f0-9]{32}$/.test(settings.tunnelId)
      || settings.authentication !== 'none') {
      throw new Error('The current ChatGPT connector settings are invalid.');
    }
    const started = Date.now();
    pageFailureState = null;
    let personal = null, sawEmpty = false;
    for (let tries = 0; tries < 2 && !personal; tries++) {
      const found = await waitFor(() => {
        const tabs = [...document.querySelectorAll('main [role="tab"]')]
          .filter(tab => visible(tab) && textMatches(tab, PERSONAL_VIEW_LABELS, true));
        if (tabs.length === 1) return tabs[0];
        return tabs.length === 0 && personalListEmpty() ? 'empty' : null;
      }, 10_000);
      if (!found) break;
      // An empty list must still read empty a moment later; a Personal tab that was only late wins.
      personal = found !== 'empty' || await personalListSettledEmpty() ? found : null;
      if (!personal) sawEmpty = true;
    }
    if (!personal) throw await personalPageFailure('ChatGPT did not expose one Personal plugins tab.', started, sawEmpty);
    const empty = personal === 'empty';
    if (!empty) {
      // The URL can say view=personal while the rendered directory still selects Public.
      if (personal.getAttribute('aria-selected') !== 'true') personal.click();
      if (!await waitFor(() => personalPluginsLoaded(), 10_000)) {
        throw await personalPageFailure('The Personal plugins tab did not finish loading.', started);
      }
    }
    await clearPluginSearch();
    const listed = await waitFor(() => {
      // Nothing personal to find: the connector is absent, and Create starts from the Add action.
      if (empty) return personalListEmpty() ? { absent: true } : null;
      if (!personalPluginsLoaded()) return null;
      const card = findManagedAppCard(settings.name);
      if (card) return { card };
      const directoryCard = pluginCardLinks().some(link => link.closest('article,[role="article"]')
        || link.getAttribute('aria-labelledby') || link.querySelector('h1,h2,h3,h4')
        || normalize(link.getAttribute('aria-label')).startsWith('open '));
      if (directoryCard || pluginsPageRenderState(settings.name) === 'empty') return { absent: true };
      const main = document.querySelector('main');
      if (/no plugins found/i.test(main?.innerText || '')
        && allClickable(main).some(el => textMatches(el, ['Add'], true))) return { absent: true };
      return null;
    }, 40_000);
    if (!listed) throw await personalPageFailure('The Personal plugins list did not finish loading, so the connector was not created.', started);
    if (listed.card) {
      if (phase === 'prepare' || phase === 'existing') {
        const href = new URL(listed.card.getAttribute('href'), location.origin);
        if (href.origin !== location.origin || href.username || href.password || !isPluginDetailUrl(href.href)) {
          throw new Error('Existing connector exact tunnel identity is unverified. Creation and connection were not attempted.');
        }
        // This is a navigation candidate only; the host verifies fresh saved tunnel fields before Connect.
        return { prepared: true, existing: true, href: href.pathname + href.search };
      }
      return { created: false, href: listed.card.getAttribute('href') };
    }
    if (phase === 'existing') throw new Error('Existing connector exact tunnel identity is unverified. Creation and connection were not attempted.');
    const add = allClickable(document.querySelector('main')).filter(el =>
      !el.closest('[role="dialog"],form') && textMatches(el, ['Add'], true)
      && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if (add.length > 1) throw new Error('ChatGPT exposed more than one Add action.');
    if (add.length === 1) {
      await pointerActivateMenu(add[0]);
      const opened = await waitFor(() => {
        if (createFormPresent()) return { form: true };
        const entries = allClickable(document).filter(el => textMatches(el,
          ['Add MCP server', 'Add custom MCP server', 'Add a custom MCP server'], true));
        return entries.length === 1 ? { entry: entries[0] } : null;
      }, 5000);
      if (opened?.entry) await pointerActivateMenu(opened.entry);
      if (!opened || !await waitFor(() => createFormPresent(), 7000)) {
        throw new Error('ChatGPT did not open its custom MCP server form.');
      }
    } else if (!await openCreateFormStrict()) throw new Error('ChatGPT did not open its connector form.');
    let form = activeSurface();
    if (form === document) throw new Error('The connector form is not visible.');
    const tunnelModes = allClickable(form).filter(el => textMatches(el, ['Tunnel', 'Secure MCP Tunnel'], true)
      && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if (tunnelModes.length !== 1) throw new Error('ChatGPT did not expose one Tunnel option.');
    pointerActivate(tunnelModes[0]);
    const useId = await waitFor(() => {
      const controls = allClickable(activeSurface()).filter(el => textMatches(el, ['Use tunnel ID instead'], true));
      return controls.length === 1 ? controls[0] : null;
    }, 4000);
    if (useId) pointerActivate(useId);
    const tunnelField = await waitFor(() => inputs(activeSurface()).find(el =>
      /tunnel.*id|^tunnel_[a-f0-9]/i.test([el.id, el.name, el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' '))), 4000);
    form = activeSurface();
    const nameField = findInput('name', form);
    if (!nameField || !tunnelField) throw new Error('ChatGPT did not expose the name and Tunnel ID fields.');
    setInputValue(nameField, settings.name);
    setInputValue(tunnelField, settings.tunnelId);
    await chooseAuth(settings.authentication);
    await acknowledgeCustomServerTrust();
    form = activeSurface();
    const auth = [...form.querySelectorAll('select')].find(select =>
      [...select.options].some(option => textMatches(option, STRINGS.noAuth, true)));
    const selectedAuth = auth?.selectedOptions?.[0];
    const trust = form.querySelector('#trust-checkbox,[role="checkbox"]');
    if (nameField.value !== settings.name || tunnelField.value !== settings.tunnelId
      || !selectedAuth || !textMatches(selectedAuth, STRINGS.noAuth, true)
      || (trust && !(trust.checked || trust.getAttribute('aria-checked') === 'true'))) {
      throw new Error('ChatGPT did not retain the configured connector values.');
    }
    const create = await waitFor(() => {
      const buttons = allClickable(activeSurface()).filter(el => textMatches(el, ['Create', 'Create as a plugin'], true)
        && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
      if (buttons.length > 1) throw new Error('ChatGPT exposed more than one Create action.');
      return buttons[0] || null;
    }, 15_000);
    if (!create) throw new Error('ChatGPT did not expose one enabled Create action.');
    if (phase === 'prepare') return { prepared: true };
    return submitPreparedTunnelConnector(settings);
  }
  async function submitPreparedTunnelConnector(settings) {
    if (location.origin !== 'https://chatgpt.com' || !isPersonalPluginsPage()) throw new Error('The prepared connector page changed.');
    const form = activeSurface();
    const nameField = findInput('name', form);
    const tunnelField = inputs(form).find(el => /tunnel.*id|^tunnel_[a-f0-9]/i.test(
      [el.id, el.name, el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' ')));
    const auth = [...form.querySelectorAll('select')].find(select => [...select.options].some(option => textMatches(option, STRINGS.noAuth, true)));
    const trust = form.querySelector('#trust-checkbox,[role="checkbox"]');
    const buttons = allClickable(form).filter(el => textMatches(el, ['Create', 'Create as a plugin'], true)
      && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if (form === document || nameField?.value !== settings.name || tunnelField?.value !== settings.tunnelId
      || !auth?.selectedOptions?.[0] || !textMatches(auth.selectedOptions[0], STRINGS.noAuth, true)
      || (trust && !(trust.checked || trust.getAttribute('aria-checked') === 'true')) || buttons.length !== 1) {
      throw new Error('The prepared connector controls changed. Creation was not attempted.');
    }
    const create = buttons[0];
    const previousErrors = new Set([...form.querySelectorAll('[role="alert"],[data-slot="form-message"]')]
      .map(el => normalize(el.innerText || el.textContent)));
    const previousPluginPaths = new Set([...document.querySelectorAll('a[href]')]
      .filter(link => link.origin === location.origin).map(link => link.pathname));
    create.click();
    const created = await waitFor(() => {
      const surface = activeSurface();
      if (surface !== document && createFormPresent()) {
        if (/the mcp server denied access/i.test(surface.innerText || '')) {
          throw new Error('The MCP server denied access. Check your authentication settings and, if using a tunnel, its workspace access.');
        }
        const error = [...surface.querySelectorAll('[role="alert"],[data-slot="form-message"]')]
          .find(el => visible(el) && normalize(el.innerText || el.textContent)
            && !previousErrors.has(normalize(el.innerText || el.textContent)));
        if (error) throw new Error('ChatGPT connector creation failed: ' + (error.innerText || error.textContent).trim().slice(0, 600));
      }
      const card = findManagedAppCard(settings.name);
      let href = card?.getAttribute('href');
      if (!href && location.pathname.startsWith('/plugins/')) {
        const heading = [...document.querySelectorAll('main h1,main h2,main h3')].find(el =>
          canonicalAppIdentity(el.innerText || el.textContent) === canonicalAppIdentity(settings.name));
        if (heading) href = location.pathname + location.search;
      }
      if (!href) return null;
      if (previousPluginPaths.has(new URL(href, location.href).pathname)) {
        throw new Error('ChatGPT showed an existing connector after Create; creation was not confirmed.');
      }
      return { created: true, href };
    }, 15000);
    if (!created) throw new Error('ChatGPT did not confirm connector creation.');
    return created;
  }
  function tunnelConnectorConnected(name) {
    if (location.origin !== 'https://chatgpt.com' || !isPluginDetailUrl(location.href)) {
      throw new Error('Open the exact ChatGPT plugin before connecting it.');
    }
    const wanted = canonicalAppIdentity(name);
    const main = document.querySelector('main');
    if (!main || visibleDialogs().length || connectControlIn(main)
      || allClickable(main).some(el => textMatches(el, ['Connect'], true))) return false;
    const rows = [...main.querySelectorAll('[role="button"][tabindex]')].filter(row => visible(row)
      && [...row.querySelectorAll('[id]')].some(title => canonicalAppIdentity(title.textContent) === wanted));
    if (rows.length > 1) throw new Error('ChatGPT exposed more than one matching app row.');
    return observeAppConnection(name).connectionObserved || rows.length === 1;
  }
  function tunnelConnectorConnectControl(name) {
    const main = document.querySelector('main');
    if (!main || !exactNameIn(main, name)) return null;
    const controls = allClickable(main).filter(el => textMatches(el, ['Connect'], true)
      && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if (controls.length > 1) throw new Error('ChatGPT exposed more than one Connect action.');
    return controls.length === 1 && controls[0] === connectControlIn(main) ? controls[0] : null;
  }
  function tunnelConnectorConsent(name) {
    if (location.origin !== 'https://chatgpt.com' || !isPluginDetailUrl(location.href)) throw new Error('The plugin consent page changed.');
    const dialog = visibleDialogs().at(-1);
    if (!dialog || ![...dialog.querySelectorAll('h1,h2,h3,[role="heading"]')]
      .some(heading => textMatches(heading, ['Connect ' + name], true))) return null;
    const controls = allClickable(dialog).filter(el => textMatches(el, ['Connect ' + name], true)
      && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    return controls.length === 1 ? controls[0] : null;
  }
  async function prepareTunnelConnectorConnection(name) {
    const ready = await waitFor(() => {
      if (tunnelConnectorConnected(name)) return { connected: true };
      return tunnelConnectorConnectControl(name) ? { connected: false } : null;
    }, 15000);
    if (!ready) throw new Error('ChatGPT did not finish loading this plugin connection.');
    return ready;
  }
  async function openTunnelConnectorConsent(name) {
    if (tunnelConnectorConnected(name)) return { connected: true };
    const connect = tunnelConnectorConnectControl(name);
    if (!connect) throw new Error('The prepared Connect control changed. Connection was not attempted.');
    await pointerActivateMenu(connect);
    const consent = await waitFor(() => tunnelConnectorConsent(name), 9000);
    if (!consent) throw new Error('ChatGPT did not expose this plugin connection confirmation.');
    return { consentReady: true };
  }
  async function confirmTunnelConnectorConsent(name) {
    const consent = tunnelConnectorConsent(name);
    if (!consent) throw new Error('The prepared plugin consent changed. Connection was not attempted.');
    await pointerActivateMenu(consent);
    if (!await waitFor(() => tunnelConnectorConnected(name), 15000)) throw new Error('ChatGPT did not confirm this plugin connection.');
    return { connected: true };
  }
  async function ensureTunnelConnectorConnected(name) {
    if ((await prepareTunnelConnectorConnection(name)).connected) return;
    if ((await openTunnelConnectorConsent(name)).connected) return;
    await confirmTunnelConnectorConsent(name);
  }
  createFormPresent = () => {
    const surface = activeSurface();
    return Boolean(findInput('name', surface) && (findInput('url', surface)
      || [...surface.querySelectorAll('select,[role="combobox"],[role="radio"],button,[role="button"]')].some(element =>
        /tunnel/i.test([element.id, element.name, element.getAttribute('data-testid'), element.textContent].join(' ')))));
  };
  globalThis.__codingToolsConnectorHelpers = Object.freeze({
    activeSurface, acknowledgeCustomServerTrust, allClickable, canonicalAppIdentity,
    cardDetailUrl, clearPluginSearch, connectControlIn, elementLabels, ensurePersonalView, findClickable, findExactAppNode,
    prepareTunnelConnector: (settings, existingOnly = false) => createTunnelConnector(settings, existingOnly ? 'existing' : 'prepare'), submitPreparedTunnelConnector, inspectTunnelConnectorIdentity,
    prepareTunnelConnectorConnection, openTunnelConnectorConsent, confirmTunnelConnectorConsent,
    ${testLegacy ? "createTunnelConnector, ensureTunnelConnectorConnected," : ""}
    pageFailureState: () => pageFailureState,
    findGridArticle, findInput, findManagedAppCard, isPersonalPluginsPage, observeAppConnection, personalPluginsLoaded,
    personalListEmpty, personalListSettledEmpty, openCreateFormStrict, pluginCardLinks, pointerActivate, setInputValue,
    textMatches, visible, waitFor, waitForPersonalPluginsPage, waitForPluginsPageReady, selectWorkspace
  });
})();`;
}

/**
 * Creates the ChatGPT connector for the main tunnel, or with `target` ({ tunnelId, partition }) for
 * an extra tunnel in its account's browser partition; the caller records an extra tunnel's connector.
 */
async function createConfiguredConnector({ app, BrowserWindow, browserHost, runtimeHost, target, assertCurrent,
  operationHeld = false, expectedContext, selectWorkspace = false, shared, onContext, preserveSurface = false, existingOnly = false }) {
  requireAutomaticConnectorSetup(runtimeHost, browserHost);
  if (operationHeld && browserHost.currentOperation?.() !== "MCP connector creation") throw new Error("MCP connector setup is busy");
  const extra = target?.tunnelId !== undefined;
  // Read once here; checkHost runs on every step of the setup.
  const credentials = extra ? undefined : await connectorCredentials(runtimeHost);
  const settings = extra
    ? extraConnectorSettings(runtimeHost, target.tunnelId)
    : currentConnectorSettings(runtimeHost, { credentials });
  const partition = target?.partition ?? browserHost.partition;
  const sharedProof = shared && freshConnectorResults.get(shared.creationResult);
  if (shared) {
    if (!operationHeld || !sharedProof || sharedProof.browserHost !== browserHost || sharedProof.runtimeHost !== runtimeHost
      || Date.now() - sharedProof.at > 180_000 || sharedProof.partition !== shared.publisherPartition
      || sharedProof.userId !== shared.userId || sharedProof.workspaceId !== shared.workspaceId
      || sharedProof.workspaceRole !== "account-owner" || sharedProof.workspaceStructure !== "workspace"
      || sharedProof.tunnelId !== settings.tunnelId || shared.tunnelId !== settings.tunnelId
      || sharedProof.name !== settings.name || sharedProof.href !== shared.href) throw new Error(UNVERIFIED_CONNECTOR);
    sharedProof.assertCurrent?.();
    freshConnectorResults.delete(shared.creationResult);
  }
  const activePartition = browserHost.partition;
  const checkHost = () => {
    requireAutomaticConnectorSetup(runtimeHost, browserHost);
    if (operationHeld && browserHost.currentOperation?.() !== "MCP connector creation") throw new Error("MCP connector setup is busy");
    if (browserHost.partition !== activePartition) throw new Error("The browser account changed during MCP setup.");
    assertCurrent?.();
    if (shared) sharedProof.assertCurrent?.();
    const current = extra ? extraConnectorSettings(runtimeHost, settings.tunnelId) : currentConnectorSettings(runtimeHost, { credentials });
    if (current.name !== settings.name || current.tunnelId !== settings.tunnelId) throw new Error("The MCP configuration changed during setup.");
  };
  const run = async () => {
    checkHost();
    // Another account's sign-in is checked by the page itself: the Plugins page will not load.
    if (partition === browserHost.partition && !(await browserHost.probeAuthentication()).authenticated) {
      throw new Error("Complete ChatGPT verification in Coding Tools Browser before creating its connector.");
    }
    checkHost();
    const popup = new BrowserWindow({
      show: false,
      width: 960,
      height: 720,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        offscreen: true,
      },
    });
    let timedOut = false, observer = null, navigating = false, submitting = false, navigationChanged = false, navigationVersion = 0, mutationStarted = false;
    let navigatedTo = null;
    const changedTo = value => { navigationChanged = true; navigatedTo ??= navigationPlace(value); };
    let expectedPath = null, platformPhase = false, platformSignIn = null, recheckExistingFailure = null, timer;
    // A Cloudflare check restarts the clock with its own wait added (loadPastCloudflareCheck).
    const budget = target ? 120_000 : 75_000;
    const arm = ms => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        if (!popup.isDestroyed()) popup.destroy();
      }, ms);
      timer.unref?.();
    };
    arm(budget);
    const navigation = (_event, value, inPlace, mainFrame) => {
      if (mainFrame === false) return;
      navigationVersion++;
      if (navigating) return;
      let url;
      try { url = new URL(value); } catch { changedTo(value); return; }
      // Platform's page signs in by itself once it has loaded: on 2026-11-09 it went from the
      // tunnels page to /login, and the setup stopped there on every Connect. That round trip
      // through OpenAI's sign-in belongs to the Platform step; the user it signs in is still
      // checked against the ChatGPT user (platformMcpOwnerContext) before anything is created.
      if (platformPhase && url.protocol === "https:" && !url.username && !url.password && !url.port
        && PLATFORM_SIGN_IN_HOSTS.includes(url.hostname)) {
        if (url.hostname !== "platform.openai.com" || url.pathname.startsWith("/login")) platformSignIn = navigationPlace(value);
        return;
      }
      if (!inPlace || (!submitting && url.pathname !== expectedPath)) changedTo(value);
    };
    try {
      popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      matchBrowserUserAgent(popup);
      // Initialize the hidden renderer before awaiting CDP Network.enable.
      await popup.loadURL("about:blank");
      checkHost();
      const guardNavigation = (event, value, _inPlace, mainFrame) => {
        if ((event.isMainFrame ?? mainFrame) === false) return;
        try {
          const url = new URL(event.url ?? value);
          if (url.protocol === "https:" && !url.username && !url.password && !url.port
            && (url.hostname === "chatgpt.com" || (platformPhase && PLATFORM_SIGN_IN_HOSTS.includes(url.hostname)))) return;
        } catch {}
        changedTo(value);
        event.preventDefault();
      };
      popup.webContents.on("will-navigate", guardNavigation);
      popup.webContents.on("will-redirect", guardNavigation);
      popup.webContents.on("did-start-navigation", navigation);
      observer = await observeMcpSetupContext(popup.webContents, settings.tunnelId);
      const navigate = async value => {
        checkHost(); expectedPath = new URL(value).pathname; navigating = true;
        try { await loadPastCloudflareCheck(popup, value, { onCheck: () => arm(SETUP_CHECK_WAIT_MS + budget) }); } finally { navigating = false; }
        checkHost();
      };
      const evidence = async ready => {
        while (!popup.isDestroyed()) {
          checkHost();
          if (navigationChanged) {
            throw Object.assign(new Error("The browser navigation changed during MCP context inspection."), { navigatedTo });
          }
          const snapshot = observer.snapshot();
          if (snapshot.error) throw new Error(snapshot.error);
          if (ready(snapshot)) return snapshot;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("MCP context inspection did not finish.");
      };
      await navigate("https://chatgpt.com/plugins?view=personal");
      let initial = await evidence(snapshot => snapshot.activeAccountId);
      let context = await popup.webContents.executeJavaScript(chatGptMcpContextScript(initial.activeAccountId), true);
      if (selectWorkspace && expectedContext && context.workspaceId !== expectedContext.workspaceId) {
        const membership = await popup.webContents.executeJavaScript(chatGptMcpContextScript(expectedContext.workspaceId), true);
        checkHost();
        if (context.userId !== expectedContext.userId || membership.userId !== expectedContext.userId
          || membership.workspaceRole !== expectedContext.workspaceRole || membership.workspaceStructure !== "workspace"
          || membership.workspaceRole !== "account-owner") {
          throw new Error("The MCP account or workspace context changed. Retry in the intended workspace.");
        }
        await popup.webContents.executeJavaScript(extensionHelpersSource(), true);
        const beforeNavigation = observer.snapshot();
        navigating = true;
        try {
          await popup.webContents.executeJavaScript(`globalThis.__codingToolsConnectorHelpers.selectWorkspace(${JSON.stringify(membership.workspaceName)})`, true);
          await evidence(snapshot => snapshot.activeAccountId === expectedContext.workspaceId
            || (snapshot.navigationVersion > beforeNavigation.navigationVersion && snapshot.navigationAccountId === expectedContext.workspaceId));
        } finally { navigating = false; }
        await navigate("https://chatgpt.com/plugins?view=personal");
        initial = await evidence(snapshot => snapshot.activeAccountId === expectedContext.workspaceId);
        context = await popup.webContents.executeJavaScript(chatGptMcpContextScript(initial.activeAccountId), true);
      }
      if (expectedContext && (context.userId !== expectedContext.userId || context.workspaceId !== expectedContext.workspaceId
        || context.workspaceRole !== expectedContext.workspaceRole || context.workspaceStructure !== expectedContext.workspaceStructure)) {
        throw new Error("The MCP account or workspace context changed. Retry in the intended workspace.");
      }
      if (existingOnly && (context.workspaceStructure !== "workspace"
        || !["account-owner", "account-admin", "standard-user"].includes(context.workspaceRole))) throw new Error(WORKSPACE_OWNER_REQUIRED);
      // Existing-only use verifies the app's saved identity without borrowing Platform authority.
      // Returning from Platform establishes a new observation baseline; freshContext still checks
      // the original user/workspace/role before any creation or consent mutation.
      if (!shared && !existingOnly) {
        requireMcpWorkspaceOwner(context);
        platformPhase = true;
        await navigate("https://platform.openai.com/settings/organization/tunnels");
        await evidence(snapshot => snapshot.platform.user && snapshot.platform.organizationId && snapshot.platform.permissions && snapshot.platform.tunnels);
        platformPhase = false;
        await navigate("https://chatgpt.com/plugins?view=personal");
        initial = await evidence(snapshot => snapshot.activeAccountId);
        if (initial.activeAccountId !== context.workspaceId) throw new Error("The MCP account or workspace context changed. Retry in the intended workspace.");
      }
      const freshContext = async () => {
        checkHost();
        const before = observer.snapshot(), version = navigationVersion;
        const matches = snapshot => !snapshot.error && snapshot.activeAccountId === context.workspaceId
          && snapshot.selectionVersion === initial.selectionVersion
          && snapshot.platformSelectionVersion === initial.platformSelectionVersion
          && snapshot.platformIdentityVersion === initial.platformIdentityVersion && snapshot.metadataVersion === initial.metadataVersion;
        if (navigationChanged || !matches(before) || context.workspaceId !== initial.activeAccountId
          || new URL(popup.webContents.getURL()).pathname !== expectedPath) throw new Error("The MCP account or workspace context changed. Retry in the intended workspace.");
        const current = await popup.webContents.executeJavaScript(chatGptMcpContextScript(before.activeAccountId), true);
        checkHost();
        const after = observer.snapshot();
        if (navigationChanged || version !== navigationVersion || !matches(after)
          || current.userId !== context.userId || current.workspaceId !== context.workspaceId
          || current.workspaceRole !== context.workspaceRole || current.workspaceStructure !== context.workspaceStructure) {
          throw new Error("The MCP authentication or workspace context changed. Retry in the intended workspace.");
        }
        if (shared) {
          if (current.workspaceStructure !== "workspace" || shared.workspaceId !== current.workspaceId
            || shared.memberUserId !== current.userId || shared.tunnelId !== settings.tunnelId) {
            throw new Error("The MCP account or workspace context changed. Retry in the intended workspace.");
          }
        } else if (!existingOnly) {
          requireMcpWorkspaceOwner(current);
          platformMcpOwnerContext(after.platform, settings.tunnelId, current);
        }
        return current;
      };
      recheckExistingFailure = freshContext;
      await onContext?.(partition, await freshContext());
      const bindingPath = path.join(app.getPath("userData"), "mcp-account-connector-bindings.json");
      const saved = await readAccountConnectorBindings(app);
      await freshContext();
      await popup.webContents.executeJavaScript(extensionHelpersSource(), true);
      const prepared = shared ? { prepared: true, existing: true, href: sharedProof.href }
        : await popup.webContents.executeJavaScript(`globalThis.__codingToolsConnectorHelpers.prepareTunnelConnector(${JSON.stringify(settings)}, ${existingOnly})`, true)
          .catch(error => withPageState(popup, error));
      if (prepared?.prepared !== true) throw new Error("ChatGPT did not prepare the exact tunnel connector.");
      if (existingOnly && prepared.existing !== true) throw new Error(UNVERIFIED_CONNECTOR);
      await freshContext();
      let result;
      if (prepared.existing === true) result = { created: false, href: prepared.href };
      else {
        mutationStarted = true;
        submitting = true;
        try { result = await popup.webContents.executeJavaScript(`globalThis.__codingToolsConnectorHelpers.submitPreparedTunnelConnector(${JSON.stringify(settings)})`, true); }
        finally { submitting = false; }
      }
      const url = new URL(result?.href, "https://chatgpt.com");
      if (url.origin !== "https://chatgpt.com" || !url.pathname.startsWith("/plugins/")
        || url.username || url.password || (result.created !== true && prepared.existing !== true)) {
        throw new Error("ChatGPT returned an invalid connector identity.");
      }
      const href = url.pathname + url.search;
      await navigate(url.href);
      if (prepared.existing && !shared) {
        await freshContext();
        await popup.webContents.executeJavaScript(extensionHelpersSource(), true);
        const identity = await popup.webContents.executeJavaScript(`globalThis.__codingToolsConnectorHelpers.inspectTunnelConnectorIdentity(${JSON.stringify(settings)})`, true);
        await freshContext();
        if (identity?.verified !== true || identity.name !== settings.name || identity.tunnelId !== settings.tunnelId
          || identity.href !== url.pathname) throw new Error(UNVERIFIED_CONNECTOR);
      }
      const createdContext = await freshContext();
      // Retain verified creation for consent retries without replacing other accounts' provenance.
      const remember = async () => {
        const binding = { name: settings.name, tunnelId: settings.tunnelId, href,
          userId: createdContext.userId, workspaceId: createdContext.workspaceId,
          ...(shared ? { publisherUserId: shared.userId, publisherPartition: shared.publisherPartition } : {}) };
        const content = JSON.stringify({ version: 1,
          bindings: { ...saved.bindings, [partition]: binding }, scopedBindings: { ...saved.scopedBindings,
            [JSON.stringify([partition, binding.workspaceId, binding.tunnelId, binding.name])]: binding },
        });
        if (Buffer.byteLength(content) > 64 * 1024) throw new Error("Saved account connector bindings could not be read; they were kept for recovery.");
        await writePrivateFileAtomicAsync(bindingPath, content, { durable: true });
        await freshContext();
      };
      if (result.created) await remember();
      await popup.webContents.executeJavaScript(extensionHelpersSource(), true);
      const connection = await popup.webContents.executeJavaScript(`globalThis.__codingToolsConnectorHelpers.prepareTunnelConnectorConnection(${JSON.stringify(settings.name)})`, true);
      if (typeof connection?.connected !== "boolean") throw new Error("ChatGPT did not confirm the exact connector state.");
      if (shared || prepared.existing) await remember();
      if (!connection.connected) {
        await freshContext();
        mutationStarted = true;
        const consent = await popup.webContents.executeJavaScript(`globalThis.__codingToolsConnectorHelpers.openTunnelConnectorConsent(${JSON.stringify(settings.name)})`, true);
        if (consent?.connected !== true) {
          if (consent?.consentReady !== true) throw new Error("ChatGPT did not prepare the exact connector consent.");
          await freshContext();
          const confirmed = await popup.webContents.executeJavaScript(`globalThis.__codingToolsConnectorHelpers.confirmTunnelConnectorConsent(${JSON.stringify(settings.name)})`, true);
          if (confirmed?.connected !== true) throw new Error("ChatGPT did not confirm the exact connector consent.");
        }
      }
      const stable = await freshContext();
      const binding = { userId: stable.userId, workspaceId: stable.workspaceId, tunnelId: settings.tunnelId };
      if (result.created && !target) {
        await writePrivateFileAtomicAsync(path.join(app.getPath("userData"), "mcp-connector-binding.json"),
          JSON.stringify({ version: 1, name: settings.name, tunnelId: settings.tunnelId, href, ...binding }), { durable: true });
        await freshContext();
      }
      const connected = { created: result.created, name: settings.name, href, binding, connected: true };
      if (!shared && !existingOnly) freshConnectorResults.set(connected, { browserHost, runtimeHost, partition, assertCurrent,
        ...binding, workspaceRole: stable.workspaceRole, workspaceStructure: stable.workspaceStructure,
        name: settings.name, href, at: Date.now() });
      return connected;
    } catch (error) {
      if (timedOut && platformPhase && platformSignIn) {
        // Platform's sign-in stopped on a page that wants a person (a password or account choice).
        throw Object.assign(new Error(PLATFORM_SIGN_IN_UNFINISHED), { navigatedTo: platformSignIn });
      }
      if (timedOut) throw new Error("ChatGPT connector setup took too long. Retry from Configuration.");
      if (existingOnly && !mutationStarted && error?.message === UNVERIFIED_CONNECTOR) {
        // A rejected helper skips its normal post-read check. Context changes must stop setup,
        // not become a recoverable identity failure that permits owner mutations afterward.
        if (!recheckExistingFailure) throw new Error("The MCP account or workspace context changed. Retry in the intended workspace.");
        await recheckExistingFailure();
      }
      if (error instanceof Error) error.mcpMutationStarted = mutationStarted;
      throw error;
    } finally {
      clearTimeout(timer);
      observer?.dispose();
      if (!popup.isDestroyed()) {
        popup.webContents.removeListener("did-start-navigation", navigation);
        popup.destroy();
      }
    }
  };
  return operationHeld ? run() : browserHost.withManualOperation("MCP connector creation", run, { preserveSurface });
}

async function openConfiguredTunnelSettings({ BrowserWindow, browserHost, runtimeHost, partition = browserHost.partition }) {
  const settings = currentConnectorSettings(runtimeHost);
  // The owned chat page is refreshed by catalog verification; settings need their own surface.
  return browserHost.withManualOperation("MCP tunnel settings", async () => {
    // Offscreen composition keeps hidden Platform dialogs animating without a visible window.
    const popup = new BrowserWindow({
      show: false, width: 1100, height: 800,
      webPreferences: { partition, contextIsolation: true,
        nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true },
    });
    const closed = new Promise(resolve => popup.once("closed", resolve));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!popup.isDestroyed()) popup.destroy();
    }, 15 * 60_000);
    timer.unref?.();
    try {
      popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      matchBrowserUserAgent(popup);
      const guardNavigation = (event, value) => {
        try {
          const url = new URL(value);
          if (url.protocol === "https:" && !url.username && !url.password && !url.port
            && ["platform.openai.com", "auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(url.hostname)) return;
        } catch {}
        event.preventDefault();
      };
      popup.webContents.on("will-navigate", guardNavigation);
      popup.webContents.on("will-redirect", guardNavigation);
      await popup.loadURL("https://platform.openai.com/settings/organization/tunnels");
      await closed;
      if (timedOut) throw new Error("MCP tunnel settings timed out");
      return { opened: true, name: settings.name };
    } finally {
      clearTimeout(timer);
      if (!popup.isDestroyed()) popup.destroy();
    }
  });
}

module.exports = { UNVERIFIED_CONNECTOR, WORKSPACE_OWNER_REQUIRED, PLATFORM_SIGN_IN_UNFINISHED, requireMcpWorkspaceOwner, chatGptMcpContext, chatGptMcpContextScript, platformMcpOwnerContext, observeMcpSetupContext, navigationPlace, connectorPageState, createConfiguredConnector, currentConnectorSettings, connectorCredentials, extensionHelpersSource, extraConnectorSettings, readAccountConnectorBindings, accountConnectorBinding, requireAutomaticConnectorSetup, openConfiguredTunnelSettings };
