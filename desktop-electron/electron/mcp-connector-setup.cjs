"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateConnectorName } = require("./connector-identity.cjs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

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

// Observe only the new setup window's normal requests. This never sends an API request or keeps
// authentication headers/raw bodies; callers must still verify fresh context before mutations.
async function observeMcpSetupContext(contents, tunnelId) {
  const client = contents?.debugger;
  const unavailable = () => new Error("MCP metadata inspection is unavailable in this browser window.");
  if (!client || client.isAttached() || !/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) throw unavailable();
  const limit = 1024 * 1024;
  const requests = new Map(), organizations = new Map(), latest = new Map();
  let attached = false, disposed = false, user = null, organizationId = null, activeAccountId = null;
  let selectionVersion = 0, platformSelectionVersion = 0, platformIdentityVersion = 0, metadataVersion = 0, sequence = 0, error = null;
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
      const request = params.request;
      let url;
      try { url = new URL(request?.url); } catch { return; }
      let kind = null;
      if (url.origin === "https://chatgpt.com" && request.method === "POST"
        && url.pathname === "/backend-api/aip/connectors/mcp/list_accessible") kind = "chatgpt";
      if (url.origin === "https://api.openai.com") {
        if (request.method === "POST" && url.pathname === "/v1/dashboard/onboarding/login") kind = "login";
        else if (request.method === "GET" && url.pathname === "/v1/dashboard/organization/permissions") kind = "permissions";
        else if (request.method === "GET" && url.pathname === "/v1/tunnels") kind = "tunnels";
      }
      if (!kind) return;
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
    const fact = requests.get(id);
    if (!fact) return;
    if (latest.get(fact.key) !== fact.sequence || (fact.kind !== "chatgpt" && fact.identityVersion !== platformIdentityVersion)) { requests.delete(id); return; }
    if (method === "Network.loadingFailed") { requests.delete(id); failed(fact); return; }
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
  };
  try {
    client.attach("1.3"); attached = true;
    client.on("message", onMessage); client.on("detach", onDetach);
    await client.sendCommand("Network.enable", { maxTotalBufferSize: limit * 4, maxResourceBufferSize: limit });
  } catch { dispose(); throw unavailable(); }
  return {
    snapshot: () => structuredClone({ activeAccountId, selectionVersion, platformSelectionVersion, platformIdentityVersion, metadataVersion, error,
      platform: { user, organizationId, permissions: organizations.get(organizationId)?.permissions ?? null,
        tunnels: organizations.get(organizationId)?.tunnels ?? null } }),
    dispose,
  };
}

function currentConnectorSettings(runtimeHost) {
  const snapshot = runtimeHost.runtimeConfigSnapshot();
  const config = snapshot.config;
  if (!snapshot.configured || snapshot.owner !== "launcher" || config?.mode !== "full"
    || config.browserInteractionMode === "manual" || !runtimeHost.mcpCredentialsConfigured("automatic")) {
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

function extensionHelpersSource({ testLegacy = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, "extensions", "fast-access", "content.js"), "utf8");
  const boundary = source.indexOf("  // Test seam.");
  if (boundary < 0) throw new Error("The pinned MCP extension helper boundary is missing.");
  // Reuse the extension's detection/form logic without registering its Chrome worker or Sync flow.
  return source.slice(0, boundary).replace(
    "const canonicalAppIdentity = (value) => normalize(value).replace(/[^\\p{L}\\p{N}]+/gu, '');",
    "const canonicalAppIdentity = (value) => normalize(value);",
  ) + `
  function personalPluginsLoaded() {
    const selected = [...document.querySelectorAll('main [role="tab"][aria-selected="true"]')]
      .some(tab => textMatches(tab, PERSONAL_VIEW_LABELS, true));
    const loading = [...document.querySelectorAll('main *')].some(element =>
      ['loading plugins', 'loading plugins…', 'loading plugins...'].includes(normalize(element.innerText ?? element.textContent))
      && visible(element));
    return selected && !loading && !document.querySelector('main [data-testid="plugin-source-tabs-placeholder"],main [data-testid="directory-section-heading-skeleton"],main [data-testid="plugin-row-skeleton-icon-frame"]');
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
    const personal = await waitFor(() => {
      const tabs = [...document.querySelectorAll('main [role="tab"]')]
        .filter(tab => visible(tab) && textMatches(tab, PERSONAL_VIEW_LABELS, true));
      return tabs.length === 1 ? tabs[0] : null;
    }, 10_000);
    if (!personal) throw new Error('ChatGPT did not expose one Personal plugins tab.');
    // The URL can say view=personal while the rendered directory still selects Public.
    if (personal.getAttribute('aria-selected') !== 'true') personal.click();
    if (!await waitFor(() => personalPluginsLoaded(), 10_000)) {
      throw new Error('The Personal plugins tab did not finish loading.');
    }
    await clearPluginSearch();
    const listed = await waitFor(() => {
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
    if (!listed) throw new Error('The Personal plugins list did not finish loading, so the connector was not created.');
    if (listed.card) {
      if (phase === 'prepare') throw new Error('Existing connector exact tunnel identity is unverified. Creation and connection were not attempted.');
      return { created: false, href: listed.card.getAttribute('href') };
    }
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
    prepareTunnelConnector: settings => createTunnelConnector(settings, 'prepare'), submitPreparedTunnelConnector,
    prepareTunnelConnectorConnection, openTunnelConnectorConsent, confirmTunnelConnectorConsent,
    ${testLegacy ? "createTunnelConnector, ensureTunnelConnectorConnected," : ""}
    findGridArticle, findInput, findManagedAppCard, isPersonalPluginsPage, observeAppConnection, personalPluginsLoaded,
    openCreateFormStrict, pluginCardLinks, pointerActivate, setInputValue,
    textMatches, visible, waitFor, waitForPersonalPluginsPage, waitForPluginsPageReady
  });
})();`;
}

/**
 * Creates the ChatGPT connector for the main tunnel, or with `target` ({ tunnelId, partition }) for
 * an extra tunnel in its account's browser partition; the caller records an extra tunnel's connector.
 */
async function createConfiguredConnector({ app, BrowserWindow, browserHost, runtimeHost, target, assertCurrent }) {
  const settings = target
    ? extraConnectorSettings(runtimeHost, target.tunnelId)
    : currentConnectorSettings(runtimeHost);
  const partition = target?.partition ?? browserHost.partition;
  const activePartition = browserHost.partition;
  const checkHost = () => {
    if (browserHost.partition !== activePartition) throw new Error("The browser account changed during MCP setup.");
    assertCurrent?.();
    const current = target ? extraConnectorSettings(runtimeHost, settings.tunnelId) : currentConnectorSettings(runtimeHost);
    if (current.name !== settings.name || current.tunnelId !== settings.tunnelId) throw new Error("The MCP configuration changed during setup.");
  };
  return browserHost.withManualOperation("MCP connector creation", async () => {
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
    let timedOut = false, observer = null, navigating = false, submitting = false, navigationChanged = false, navigationVersion = 0;
    let expectedPath = null, platformPhase = true;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!popup.isDestroyed()) popup.destroy();
    }, 75_000);
    timer.unref?.();
    const navigation = (_event, value, inPlace, mainFrame) => {
      if (mainFrame === false) return;
      navigationVersion++;
      if (navigating) return;
      let url;
      try { url = new URL(value); } catch { navigationChanged = true; return; }
      if (!inPlace || (!submitting && url.pathname !== expectedPath)) navigationChanged = true;
    };
    try {
      popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const guardNavigation = (event, value) => {
        try {
          const url = new URL(value);
          if (url.protocol === "https:" && !url.username && !url.password && !url.port
            && (url.hostname === "chatgpt.com" || (platformPhase
              && ["platform.openai.com", "auth.openai.com", "auth0.openai.com"].includes(url.hostname)))) return;
        } catch {}
        navigationChanged = true;
        event.preventDefault();
      };
      popup.webContents.on("will-navigate", guardNavigation);
      popup.webContents.on("will-redirect", guardNavigation);
      popup.webContents.on("did-start-navigation", navigation);
      observer = await observeMcpSetupContext(popup.webContents, settings.tunnelId);
      const navigate = async value => {
        checkHost(); expectedPath = new URL(value).pathname; navigating = true;
        try { await popup.loadURL(value); } finally { navigating = false; }
        checkHost();
      };
      const evidence = async ready => {
        while (!popup.isDestroyed()) {
          checkHost();
          if (navigationChanged) throw new Error("The browser navigation changed during MCP context inspection.");
          const snapshot = observer.snapshot();
          if (snapshot.error) throw new Error(snapshot.error);
          if (ready(snapshot)) return snapshot;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("MCP context inspection did not finish.");
      };
      await navigate("https://platform.openai.com/settings/organization/tunnels");
      await evidence(snapshot => snapshot.platform.user && snapshot.platform.organizationId && snapshot.platform.permissions && snapshot.platform.tunnels);
      platformPhase = false;
      await navigate("https://chatgpt.com/plugins?view=personal");
      const initial = await evidence(snapshot => snapshot.activeAccountId);
      const context = await popup.webContents.executeJavaScript(chatGptMcpContextScript(initial.activeAccountId), true);
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
          || current.userId !== context.userId || current.workspaceId !== context.workspaceId) {
          throw new Error("The MCP authentication or workspace context changed. Retry in the intended workspace.");
        }
        platformMcpOwnerContext(after.platform, settings.tunnelId, current);
        return current;
      };
      await freshContext();
      await popup.webContents.executeJavaScript(extensionHelpersSource(), true);
      const prepared = await popup.webContents.executeJavaScript(`globalThis.__codingToolsConnectorHelpers.prepareTunnelConnector(${JSON.stringify(settings)})`, true);
      if (prepared?.prepared !== true) throw new Error("ChatGPT did not prepare the exact tunnel connector.");
      await freshContext();
      let result;
      submitting = true;
      try { result = await popup.webContents.executeJavaScript(`globalThis.__codingToolsConnectorHelpers.submitPreparedTunnelConnector(${JSON.stringify(settings)})`, true); }
      finally { submitting = false; }
      const url = new URL(result?.href, "https://chatgpt.com");
      if (url.origin !== "https://chatgpt.com" || !url.pathname.startsWith("/plugins/")
        || url.username || url.password || result.created !== true) {
        throw new Error("ChatGPT returned an invalid connector identity.");
      }
      const href = url.pathname + url.search;
      await navigate(url.href);
      await popup.webContents.executeJavaScript(extensionHelpersSource(), true);
      const connection = await popup.webContents.executeJavaScript(`globalThis.__codingToolsConnectorHelpers.prepareTunnelConnectorConnection(${JSON.stringify(settings.name)})`, true);
      if (typeof connection?.connected !== "boolean") throw new Error("ChatGPT did not confirm the exact connector state.");
      if (!connection.connected) {
        await freshContext();
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
        writePrivateFileAtomic(path.join(app.getPath("userData"), "mcp-connector-binding.json"),
          JSON.stringify({ version: 1, name: settings.name, tunnelId: settings.tunnelId, href, ...binding }));
      }
      return { created: true, name: settings.name, href, binding };
    } catch (error) {
      if (timedOut) throw new Error("ChatGPT connector setup took too long. Retry from Configuration.");
      throw error;
    } finally {
      clearTimeout(timer);
      observer?.dispose();
      popup.webContents.removeListener("did-start-navigation", navigation);
      if (!popup.isDestroyed()) popup.destroy();
    }
  });
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

module.exports = { chatGptMcpContext, chatGptMcpContextScript, platformMcpOwnerContext, observeMcpSetupContext, createConfiguredConnector, currentConnectorSettings, extensionHelpersSource, extraConnectorSettings, openConfiguredTunnelSettings };
