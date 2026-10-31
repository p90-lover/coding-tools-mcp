const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { chatGptMcpContext, chatGptMcpContextScript, platformMcpOwnerContext, observeMcpSetupContext, createConfiguredConnector, currentConnectorSettings, extensionHelpersSource } = require("../electron/mcp-connector-setup.cjs");

function fakeMcpNetwork() {
  const debuggerClient = new EventEmitter(), bodies = new Map(), bodyWaits = new Map(), commands = [];
  let attached = false, requestId = 0;
  Object.assign(debuggerClient, {
    isAttached: () => attached,
    attach: () => { attached = true; },
    detach: () => { attached = false; debuggerClient.emit("detach", {}, "fixture"); },
    sendCommand: async (method, args) => { commands.push({ method, args }); await Promise.resolve();
      if (method !== "Network.getResponseBody") return {};
      if (bodyWaits.has(args.requestId)) await bodyWaits.get(args.requestId);
      return bodies.get(args.requestId);
    },
  });
  const observed = (method, url, headers, body, base64 = false) => {
    const id = String(++requestId), text = JSON.stringify(body);
    bodies.set(id, { body: base64 ? Buffer.from(text).toString("base64") : text, base64Encoded: base64 });
    debuggerClient.emit("message", {}, "Network.requestWillBeSent", { requestId: id, request: { method, url, headers } });
    debuggerClient.emit("message", {}, "Network.responseReceived", { requestId: id, response: { url, status: 200, mimeType: "application/json" } });
    debuggerClient.emit("message", {}, "Network.loadingFinished", { requestId: id, encodedDataLength: text.length });
    return id;
  };
  return { debuggerClient, bodies, bodyWaits, commands, observed };
}

test("MCP context uses the selected accessible workspace and keeps ownership roles separate", () => {
  const userId = "user-fixture";
  const businessId = "602b5d8d-e211-49b1-9762-206108d52954";
  const personalId = "6d4774fd-0e67-4b5b-a3b7-4c0e61357122";
  const entry = (accountId, structure, plan) => ({ can_access_with_session: true, account: {
    account_id: accountId, account_user_id: "workspace-member", account_owner_id: "workspace-owner",
    account_user_role: "account-owner", organization_id: "chatgpt-organization", structure,
    workspace_type: structure, plan_type: plan, is_deactivated: false,
    name: "Untrusted label", secret: "DO_NOT_RETURN_ACCOUNT_SECRET",
  } });
  const accounts = { [businessId]: entry(businessId, "workspace", "team"), [personalId]: entry(personalId, "personal", "free") };
  accounts.default = accounts[personalId];
  const context = { user: { id: userId, email: "DO_NOT_RETURN_EMAIL" }, activeAccountId: businessId,
    auth: { chatgpt_user_id: userId, chatgpt_account_id: businessId, chatgpt_plan_type: "team", token: "DO_NOT_RETURN_TOKEN" }, accounts };
  assert.deepEqual(chatGptMcpContext(context), {
    userId, workspaceId: businessId, workspaceRole: "account-owner", workspaceStructure: "workspace",
    workspaceType: "workspace", workspaceUserId: "workspace-member", workspaceOwnerId: "workspace-owner",
    chatGptOrganizationId: "chatgpt-organization", planType: "team",
  });
  assert.doesNotMatch(JSON.stringify(chatGptMcpContext(context)), /DO_NOT_RETURN|Untrusted label/);
  context.activeAccountId = personalId;
  assert.equal(chatGptMcpContext(context).planType, "free", "Personal/free remains valid; server capability decides availability");
  assert.equal(chatGptMcpContext(context).workspaceStructure, "personal");
  assert.equal(context.auth.chatgpt_account_id, businessId, "the observed request chooses the workspace even when the JWT claim is stale");
  delete context.activeAccountId;
  assert.throws(() => chatGptMcpContext(context), /workspace context.*unknown/i, "JWT alone cannot establish the selected workspace");
  context.activeAccountId = "default";
  assert.throws(() => chatGptMcpContext(context), /workspace context.*unknown/i, "the default alias cannot select a workspace");
  context.activeAccountId = businessId;
  context.auth.chatgpt_user_id = "user-other";
  assert.throws(() => chatGptMcpContext(context), /authentication.*changed/i);
  context.auth.chatgpt_user_id = userId;
  accounts[businessId].can_access_with_session = false;
  assert.throws(() => chatGptMcpContext(context), /workspace access.*denied/i);
  accounts[businessId].can_access_with_session = true;
  accounts[businessId].account.is_deactivated = true;
  assert.throws(() => chatGptMcpContext(context), /workspace access.*denied/i);
});

test("MCP context inspection keeps tokens in the page and validates the observed workspace", async () => {
  const userId = "user-fixture";
  const workspaceId = "6d4774fd-0e67-4b5b-a3b7-4c0e61357122";
  const claims = { "https://api.openai.com/auth": { chatgpt_user_id: userId,
    chatgpt_account_id: "602b5d8d-e211-49b1-9762-206108d52954", chatgpt_plan_type: "team" } };
  let token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture-secret`;
  const calls = [];
  const context = { location: { origin: "https://chatgpt.com" }, AbortController, TextDecoder, setTimeout, clearTimeout, atob,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url === "/api/auth/session") return Response.json({ user: { id: userId }, accessToken: token });
      assert.equal(url, "/backend-api/accounts/check/v4-2023-04-27");
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      assert.equal(options.headers["chatgpt-account-id"], workspaceId);
      return Response.json({ accounts: { [workspaceId]: { can_access_with_session: true, account: {
        account_id: workspaceId, account_user_role: "account-owner", structure: "personal", plan_type: "free", is_deactivated: false,
      } } } });
    } };
  const script = chatGptMcpContextScript(workspaceId);
  const result = await vm.runInNewContext(script, context);
  assert.equal(result.workspaceId, workspaceId);
  assert.equal(result.planType, "free");
  assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|Bearer|accessToken|team/);
  token = "malformed-private-token";
  await assert.rejects(vm.runInNewContext(script, context), /workspace context.*unknown/i);
  assert.equal(calls.length, 3, "an unusable token cannot issue an accounts request");
});

test("MCP owner proof requires exact linked identities and org permissions rather than workspace roles or labels", () => {
  const userId = "user-fixture", organizationId = "org-fixture", tunnelId = `tunnel_${"a".repeat(32)}`;
  const businessId = "602b5d8d-e211-49b1-9762-206108d52954";
  const personal = { userId, workspaceId: "6d4774fd-0e67-4b5b-a3b7-4c0e61357122", workspaceRole: "standard-user", planType: "free" };
  const input = { organizationId, user: { id: userId, orgs: { object: "list", data: [{ id: organizationId, role: "owner" }] }, session: "DO_NOT_RETURN_SESSION" },
    permissions: { data: ["api.organization.tunnel.read", "api.organization.tunnel.use", "api.organization.tunnel.write"] },
    tunnels: { tunnels: [{ id: tunnelId, creator: userId, creator_name: "Wrong label", creator_email: "DO_NOT_RETURN_EMAIL",
      workspace_ids: [businessId], organization_ids: [], tenant_ids: [], config: { secret: "DO_NOT_RETURN_CONFIG" } }] } };
  assert.deepEqual(platformMcpOwnerContext(input, tunnelId, personal), {
    userId, tunnelId, tunnelCreatorId: userId, platformOrganizationId: organizationId, platformOrganizationRole: "owner",
    permissions: { read: true, use: true, write: true }, workspaceIds: [businessId], organizationIds: [],
  }, "Personal/free and a different workspace role do not override or invalidate exact Platform ownership");
  assert.doesNotMatch(JSON.stringify(platformMcpOwnerContext(input, tunnelId, personal)), /DO_NOT_RETURN|Wrong label|creator_email/);
  input.tunnels.tunnels[0].creator = "user-other";
  assert.throws(() => platformMcpOwnerContext(input, tunnelId, { ...personal, workspaceRole: "account-owner" }), /different Platform user/i);
  input.tunnels.tunnels[0].creator = { id: userId };
  assert.throws(() => platformMcpOwnerContext(input, tunnelId, personal), /ownership.*unknown/i, "unknown creator shapes cannot be guessed");
  input.tunnels.tunnels[0].creator = userId;
  input.user.id = "user-other";
  assert.throws(() => platformMcpOwnerContext(input, tunnelId, personal), /authentication.*different/i);
  input.user.id = userId;
  input.permissions.data = ["api.organization.tunnel.read"];
  assert.throws(() => platformMcpOwnerContext(input, tunnelId, personal), /read and use/i);
  input.permissions.data.push("api.organization.tunnel.use");
  input.organizationId = "org-other";
  assert.throws(() => platformMcpOwnerContext(input, tunnelId, personal), /ownership.*unknown/i, "the observed request org must match authenticated membership");
});

test("MCP observation uses normal list requests and bounded public Platform metadata only", async t => {
  const userId = "user-fixture", organizationId = "org-fixture", tunnelId = `tunnel_${"a".repeat(32)}`;
  const personalId = "6d4774fd-0e67-4b5b-a3b7-4c0e61357122";
  const businessId = "602b5d8d-e211-49b1-9762-206108d52954";
  const { debuggerClient, bodies, bodyWaits, commands, observed } = fakeMcpNetwork();
  const observer = await observeMcpSetupContext({ debugger: debuggerClient }, tunnelId);
  t.after(() => observer.dispose());
  observed("GET", "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27", { "chatgpt-account-id": businessId }, {});
  assert.equal(observer.snapshot().activeAccountId, null, "preflight cannot select its own workspace");
  observed("POST", "https://chatgpt.com/backend-api/aip/connectors/mcp/list_accessible", { "ChatGPT-Account-ID": personalId, Authorization: "PRIVATE_HEADER" }, {});
  observed("POST", "https://api.openai.com/v1/dashboard/onboarding/login", {}, {
    user: { id: userId, email: "PRIVATE_EMAIL", orgs: { data: [{ id: organizationId, role: "owner", name: "UNTRUSTED_NAME" }] }, session: "PRIVATE_SESSION" },
  });
  observed("GET", "https://api.openai.com/v1/dashboard/organization/permissions", { "OpenAI-Organization": organizationId }, {
    data: ["api.organization.tunnel.read", "api.organization.tunnel.use", "PRIVATE_PERMISSION"],
  });
  observed("GET", "https://api.openai.com/v1/tunnels", { "openai-organization": organizationId }, { tunnels: [
    { id: `tunnel_${"b".repeat(32)}`, creator: "user-other" },
    { id: tunnelId, creator: userId, creator_email: "PRIVATE_CREATOR_EMAIL", config: { runtimeKey: "PRIVATE_KEY" }, workspace_ids: [businessId], organization_ids: [] },
  ] }, true);
  await new Promise(resolve => setImmediate(resolve));
  const snapshot = observer.snapshot();
  assert.equal(snapshot.activeAccountId, personalId);
  assert.equal(platformMcpOwnerContext(snapshot.platform, tunnelId, { userId }).tunnelCreatorId, userId);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|UNTRUSTED|email|runtimeKey|Authorization/);
  const version = snapshot.selectionVersion;
  debuggerClient.emit("message", {}, "Network.requestWillBeSent", { requestId: "late-old-selection", request: {
    method: "POST", url: "https://chatgpt.com/backend-api/aip/connectors/mcp/list_accessible", headers: { "chatgpt-account-id": personalId },
  } });
  observed("POST", "https://chatgpt.com/backend-api/aip/connectors/mcp/list_accessible", { "chatgpt-account-id": businessId }, {});
  assert(observer.snapshot().selectionVersion > version, "a later workspace switch must invalidate a captured context");
  debuggerClient.emit("message", {}, "Network.responseReceived", { requestId: "late-old-selection", response: {
    url: "https://chatgpt.com/backend-api/aip/connectors/mcp/list_accessible", status: 200, mimeType: "application/json",
  } });
  assert.equal(observer.snapshot().activeAccountId, businessId, "a late response cannot restore the earlier workspace");
  let releaseOldOrg;
  const oldOrg = observed("GET", "https://api.openai.com/v1/tunnels", { "openai-organization": organizationId }, { tunnels: [{ id: tunnelId, creator: userId }] });
  bodyWaits.set(oldOrg, new Promise(resolve => { releaseOldOrg = resolve; }));
  const platformVersion = observer.snapshot().platformSelectionVersion;
  observed("GET", "https://api.openai.com/v1/tunnels", { "openai-organization": "org-new" }, { tunnels: [{ id: tunnelId, creator: "user-new" }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observer.snapshot().platform.organizationId, "org-new");
  releaseOldOrg();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observer.snapshot().platform.organizationId, "org-new", "a late org-A body cannot restore org A after selecting org B");
  assert.equal(observer.snapshot().platform.tunnels.tunnels[0].creator, "user-new");
  assert(observer.snapshot().platformSelectionVersion > platformVersion);
  const oversized = observed("GET", "https://api.openai.com/v1/tunnels", { "openai-organization": organizationId }, {});
  bodies.set(oversized, { body: "PRIVATE_OVERSIZED".padEnd(1024 * 1024 + 1, "x"), base64Encoded: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(observer.snapshot().error, /metadata.*unavailable/i);
  assert.equal(observer.snapshot().platform.tunnels, null, "a failed refresh cannot leave old tunnel proof usable");
  assert.doesNotMatch(JSON.stringify(observer.snapshot()), /PRIVATE_OVERSIZED/);
  observer.dispose();
  assert.equal(debuggerClient.isAttached(), false);
  assert.equal(debuggerClient.listenerCount("message"), 0);
  assert(commands.every(call => ["Network.enable", "Network.getResponseBody"].includes(call.method)), "observation must not issue API requests or app actions");
});

test("a new Platform login cannot combine its identity with the previous user's org proof", async t => {
  const network = fakeMcpNetwork(), tunnelId = `tunnel_${"a".repeat(32)}`, org = "org-fixture";
  const observer = await observeMcpSetupContext({ debugger: network.debuggerClient }, tunnelId);
  t.after(() => observer.dispose());
  const login = id => network.observed("POST", "https://api.openai.com/v1/dashboard/onboarding/login", {}, {
    user: { id, orgs: { data: [{ id: org, role: "owner" }] } },
  });
  const tunnels = () => network.observed("GET", "https://api.openai.com/v1/tunnels", { "openai-organization": org }, {
    tunnels: [{ id: tunnelId, creator: "user-target", workspace_ids: [], organization_ids: [] }],
  });
  login("user-admin");
  network.observed("GET", "https://api.openai.com/v1/dashboard/organization/permissions", { "openai-organization": org }, {
    data: ["api.organization.tunnel.read", "api.organization.tunnel.use"],
  });
  tunnels();
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => platformMcpOwnerContext(observer.snapshot().platform, tunnelId, { userId: "user-admin" }), /different Platform user/);
  let releaseOld;
  const old = tunnels();
  network.bodyWaits.set(old, new Promise(resolve => { releaseOld = resolve; }));
  const version = observer.snapshot().platformIdentityVersion;
  login("user-target");
  await new Promise(resolve => setImmediate(resolve));
  releaseOld();
  await new Promise(resolve => setImmediate(resolve));
  const snapshot = observer.snapshot();
  assert.equal(snapshot.platform.user.id, "user-target");
  assert.equal(snapshot.platform.permissions, null);
  assert.equal(snapshot.platform.tunnels, null, "a body fetched before the new login cannot become its tunnel proof");
  assert(snapshot.platformIdentityVersion > version);
  assert.throws(() => platformMcpOwnerContext(snapshot.platform, tunnelId, { userId: "user-target" }), /ownership.*unknown/i);
});

test("the production connector action verifies fresh owner and workspace proof before each mutation", async t => {
  const personalId = "6d4774fd-0e67-4b5b-a3b7-4c0e61357122", businessId = "602b5d8d-e211-49b1-9762-206108d52954";
  const tunnelId = `tunnel_${"a".repeat(32)}`, initialUser = "user-fixture", org = "org-fixture";
  for (const scenario of [
    { name: "Personal free succeeds with its actual observed workspace" },
    { name: "Business succeeds with its distinct binding", business: true },
    { name: "another Platform creator cannot be reused", nonOwner: true, error: /different Platform user/ },
    { name: "unknown creator shape cannot be guessed", unknownOwner: true, error: /ownership.*unknown/ },
    { name: "incompatible workspace evidence cannot submit", mismatch: true, error: /workspace context.*unknown/ },
    { name: "workspace switch after preparing cannot submit", change: "workspace", error: /context|workspace.*changed/i },
    { name: "subject switch after preparing cannot submit", change: "user", error: /context|authentication.*changed/i },
    { name: "partition switch after preparing cannot submit", change: "partition", error: /account|partition|context/i },
    { name: "unexpected document navigation after preparing cannot submit", change: "navigation", error: /navigation|context/i },
    { name: "a busy caller after preparing cannot submit", change: "busy", error: /busy/i },
    { name: "unverified existing same-name connector stays frozen", existing: true, error: /existing connector.*tunnel.*unverified/i },
    { name: "consent is not confirmed after a later workspace switch", change: "consent", error: /context|workspace.*changed/i, submitted: true },
  ]) await t.test(scenario.name, async () => {
    const network = fakeMcpNetwork(), counts = { create: 0, open: 0, confirm: 0 };
    let accountId = scenario.business ? businessId : personalId, userId = initialUser, destroyed = false, busy = false, url = "about:blank", windowCount = 0;
    const host = { partition: "persist:fixture", probeAuthentication: async () => ({ authenticated: true }), withManualOperation: async (_name, work) => work() };
    const select = id => network.observed("POST", "https://chatgpt.com/backend-api/aip/connectors/mcp/list_accessible", { "chatgpt-account-id": id }, {});
    const contents = new EventEmitter();
    Object.assign(contents, { debugger: network.debuggerClient, setWindowOpenHandler() {}, getURL: () => url,
      isDestroyed: () => destroyed,
      executeJavaScript: async script => {
        if (script.includes('fetch("/api/auth/session"')) {
          const entry = id => ({ can_access_with_session: true, account: { account_id: id, account_user_role: "account-owner",
            structure: id === personalId ? "personal" : "workspace", plan_type: id === personalId ? "free" : "team", is_deactivated: false } });
          return chatGptMcpContext({ user: { id: userId }, auth: { chatgpt_user_id: userId }, activeAccountId: accountId,
            accounts: scenario.mismatch ? {} : { [personalId]: entry(personalId), [businessId]: entry(businessId) } });
        }
        if (script.includes("globalThis.__codingToolsConnectorHelpers =")) return;
        const phase = script.match(/__codingToolsConnectorHelpers\.(\w+)\(/)?.[1];
        if (phase === "prepareTunnelConnector") {
          if (scenario.existing) throw new Error("Existing connector exact tunnel identity is unverified.");
          if (scenario.change === "workspace") { accountId = businessId; select(accountId); }
          if (scenario.change === "user") userId = "user-other";
          if (scenario.change === "partition") host.partition = "persist:other";
          if (scenario.change === "navigation") { url = "https://chatgpt.com/"; contents.emit("did-start-navigation", {}, url, false, true); }
          if (scenario.change === "busy") busy = true;
          return { prepared: true };
        }
        if (phase === "submitPreparedTunnelConnector" || phase === "createTunnelConnector") { counts.create++; return { created: true, href: "/plugins/plugin_fixture" }; }
        if (phase === "prepareTunnelConnectorConnection") return { connected: false };
        if (phase === "openTunnelConnectorConsent") {
          counts.open++;
          if (scenario.change === "consent") { accountId = businessId; select(accountId); }
          return { consentReady: true };
        }
        if (phase === "confirmTunnelConnectorConsent") { counts.confirm++; return { connected: true }; }
        if (phase === "ensureTunnelConnectorConnected") { counts.open++; counts.confirm++; return; }
        throw new Error(`Unexpected fixture phase ${phase}`);
      },
    });
    function Window(options) {
      windowCount++;
      assert.equal(options.show, false); assert.equal(options.webPreferences.offscreen, true);
      assert.equal(options.webPreferences.partition, "persist:fixture");
      return { webContents: contents, isDestroyed: () => destroyed, destroy: () => { destroyed = true; },
        loadURL: async next => {
          contents.emit("did-start-navigation", {}, next, false, true); url = next;
          if (next.startsWith("https://platform.openai.com/")) {
            assert(network.debuggerClient.isAttached(), "observation must precede Platform navigation");
            network.observed("POST", "https://api.openai.com/v1/dashboard/onboarding/login", {}, { user: { id: initialUser, orgs: { data: [{ id: org, role: "owner" }] } } });
            network.observed("GET", "https://api.openai.com/v1/dashboard/organization/permissions", { "openai-organization": org }, { data: ["api.organization.tunnel.read", "api.organization.tunnel.use"] });
            network.observed("GET", "https://api.openai.com/v1/tunnels", { "openai-organization": org }, { tunnels: [{ id: tunnelId,
              creator: scenario.unknownOwner ? { id: initialUser } : scenario.nonOwner ? "user-other" : initialUser, workspace_ids: [businessId], organization_ids: [] }] });
          } else if (next.startsWith("https://chatgpt.com/plugins")) select(accountId);
        } };
    }
    const action = () => createConfiguredConnector({ app: {}, BrowserWindow: Window, browserHost: host, runtimeHost: runtime(),
      target: { tunnelId, partition: "persist:fixture" }, assertCurrent: () => { if (busy) throw new Error("Caller is busy"); } });
    if (scenario.error) {
      await assert.rejects(action(), scenario.error);
      assert.deepEqual(counts, scenario.submitted ? { create: 1, open: 1, confirm: 0 } : { create: 0, open: 0, confirm: 0 });
    } else {
      const result = await action();
      assert.deepEqual(result.binding, { userId: initialUser, workspaceId: accountId, tunnelId });
      assert.deepEqual(counts, { create: 1, open: 1, confirm: 1 });
    }
    assert.equal(windowCount, 1); assert.equal(destroyed, true);
    assert.equal(network.debuggerClient.isAttached(), false);
    assert.equal(network.debuggerClient.listenerCount("message"), 0);
  });
});

function runtime() {
  const config = {
    mode: "full", browserHost: "launcher", browserInteractionMode: "automatic",
    automaticAppName: "Team Harness A",
    automaticTunnel: { tunnelId: "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", runtimeKeyFile: "private-key-file", runtimeKey: "DO_NOT_EXPORT" },
    manualTunnel: { tunnelId: "tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  };
  return {
    config,
    runtimeConfigSnapshot: () => ({ configured: true, owner: "launcher", config }),
    mcpCredentialsConfigured: mode => mode === "automatic",
    mcpConnectorName: () => config.automaticAppName,
  };
}

test("connector setup reads current names and tunnel keys on every action without exporting secrets", () => {
  const host = runtime();
  assert.deepEqual(currentConnectorSettings(host), {
    name: "Team Harness A", tunnelId: host.config.automaticTunnel.tunnelId, transport: "tunnel", authentication: "none",
  });
  host.config.automaticAppName = "Renamed workspace / tools";
  host.config.automaticTunnel.tunnelId = "tunnel_cccccccccccccccccccccccccccccccc";
  const renewed = currentConnectorSettings(host);
  assert.equal(renewed.name, host.config.automaticAppName);
  assert.equal(renewed.tunnelId, host.config.automaticTunnel.tunnelId);
  assert.deepEqual(Object.keys(renewed).sort(), ["authentication", "name", "transport", "tunnelId"]);
  assert.doesNotMatch(JSON.stringify(renewed), /private-key-file|DO_NOT_EXPORT/);
});

test("automatic setup cannot borrow a manual profile or an external runtime", () => {
  const host = runtime();
  host.config.browserInteractionMode = "manual";
  assert.throws(() => currentConnectorSettings(host), /automatic MCP harness/);
  host.config.browserInteractionMode = "automatic";
  host.config.automaticTunnel = undefined;
  assert.throws(() => currentConnectorSettings(host), /no tunnel ID/);
  host.runtimeConfigSnapshot = () => ({ configured: true, owner: "external", config: host.config });
  assert.throws(() => currentConnectorSettings(host), /automatic MCP harness/);
});

test("the adapted extension exposes form helpers without the destructive Sync or Chrome listener", () => {
  const context = {};
  const script = extensionHelpersSource();
  vm.runInNewContext(script, context);
  const helpers = context.__codingToolsConnectorHelpers;
  assert.equal(typeof helpers.openCreateFormStrict, "function");
  assert.equal(typeof helpers.findInput, "function");
  assert.equal(typeof helpers.acknowledgeCustomServerTrust, "function");
  assert.equal(typeof helpers.prepareTunnelConnector, "function");
  assert.equal(typeof helpers.submitPreparedTunnelConnector, "function");
  assert.equal(helpers.createTunnelConnector, undefined, "production cannot invoke the legacy unguarded sequence");
  assert.equal(helpers.ensureTunnelConnectorConnected, undefined);
  assert.equal(context.__codingToolsMcpInternals, undefined);
  assert(!Object.keys(helpers).some(key => /delete|remove|sync|oauth/i.test(key)));
  assert(!script.includes("chrome.runtime.onMessage.addListener"));
  assert.notEqual(helpers.canonicalAppIdentity("MCP-2"), helpers.canonicalAppIdentity("MCP 2"));
  assert.equal(helpers.canonicalAppIdentity("🔧 Shared tools"), "🔧 shared tools");
});

test("guarded renderer phases reject changed controls and unverified existing cards before clicking", async () => {
  const source = extensionHelpersSource({ testLegacy: true });
  const phase = (name, next, context) => {
    const start = source.indexOf(`  async function ${name}(`), end = source.indexOf(`  ${next}`, start);
    assert(start >= 0 && end > start);
    return vm.runInNewContext(`(${source.slice(start, end).trim()})`, context);
  };
  const settings = { name: "Fixture MCP", tunnelId: `tunnel_${"a".repeat(32)}`, authentication: "none" };
  const matches = (element, labels) => labels.includes(element?.textContent);
  for (const changed of [null, "tunnel", "name", "trust", "auth", "duplicate"]) {
    let clicks = 0;
    const name = { value: changed === "name" ? "Different app" : settings.name };
    const tunnel = { value: changed === "tunnel" ? `tunnel_${"b".repeat(32)}` : settings.tunnelId,
      id: "tunnel-id", getAttribute: () => null };
    const option = { textContent: changed === "auth" ? "OAuth" : "No authentication" };
    const auth = { options: [{ textContent: "No authentication" }], selectedOptions: [option] };
    const trust = { checked: changed !== "trust", getAttribute: () => null };
    const create = { textContent: "Create", disabled: false, getAttribute: () => null, click: () => { clicks++; } };
    const form = { querySelectorAll: selector => selector === "select" ? [auth] : [], querySelector: () => trust };
    const document = { querySelectorAll: () => [] };
    const submit = phase("submitPreparedTunnelConnector", "function tunnelConnectorConnected", {
      location: { origin: "https://chatgpt.com", href: "https://chatgpt.com/plugins?view=personal", pathname: "/plugins" },
      URL, document, isPersonalPluginsPage: () => true, activeSurface: () => form,
      findInput: () => name, inputs: () => [tunnel], textMatches: matches, STRINGS: { noAuth: ["No authentication"] },
      allClickable: () => changed === "duplicate" ? [create, create] : [create], normalize: value => value,
      createFormPresent: () => false, waitFor: async read => read(),
      findManagedAppCard: () => clicks ? { getAttribute: () => "/plugins/new-fixture" } : null,
    });
    if (changed) await assert.rejects(submit(settings), /controls changed/);
    else assert.equal((await submit(settings)).created, true);
    assert.equal(clicks, changed ? 0 : 1, `${changed || "valid"}: validate the current form before Create`);
  }
  const document = { title: "Plugins", body: { innerText: "Plugins" }, querySelectorAll: () => [{ textContent: "Personal", getAttribute: () => "true" }] };
  const prepare = phase("createTunnelConnector", "async function submitPreparedTunnelConnector", {
    location: { origin: "https://chatgpt.com" }, document, isPersonalPluginsPage: () => true,
    visible: () => true, textMatches: matches, PERSONAL_VIEW_LABELS: ["Personal"],
    waitFor: async read => read(), personalPluginsLoaded: () => true, clearPluginSearch: async () => {},
    findManagedAppCard: () => ({ getAttribute: () => "/plugins/existing" }),
    allClickable: () => { throw new Error("Existing connector must not open Create"); },
  });
  await assert.rejects(prepare(settings, "prepare"), /existing connector.*tunnel.*unverified/i);
  const stale = { tunnelConnectorConnected: () => false, tunnelConnectorConnectControl: () => null,
    tunnelConnectorConsent: () => null, pointerActivateMenu: () => { throw new Error("Stale control was clicked"); } };
  await assert.rejects(phase("openTunnelConnectorConsent", "async function confirmTunnelConnectorConsent", stale)(settings.name), /Connect control changed/);
  await assert.rejects(phase("confirmTunnelConnectorConsent", "async function ensureTunnelConnectorConnected", stale)(settings.name), /consent changed/);
});

test("Personal plugin readiness waits for its visible loader even when Installed links are present", () => {
  let loading = true, skeleton = false;
  const loader = { innerText: "Loading plugins…", textContent: "Loading plugins…", get offsetWidth() { return loading ? 100 : 0; }, getClientRects: () => loading ? [{}] : [] };
  const personal = { innerText: "Personal", getAttribute: () => null };
  const installed = { innerText: "Coding Tools Native2", getAttribute: name => name === "href" ? "/plugins/plugin_asdk_app_existing" : null };
  const context = { document: {
    querySelectorAll: selector => selector === 'main [role="tab"][aria-selected="true"]' ? [personal]
      : selector === "main *" ? [installed, loader] : selector === "a[href]" ? [installed] : [],
    querySelector: () => skeleton ? {} : null,
  } };
  vm.runInNewContext(extensionHelpersSource(), context);
  const loaded = context.__codingToolsConnectorHelpers.personalPluginsLoaded;
  assert.equal(loaded(), false, "Installed links cannot establish directory completion while the loader is visible");
  loader.innerText = "Loading plugins...";
  assert.equal(loaded(), false);
  loading = false;
  assert.equal(loaded(), true, "a hidden loader must not block a completed directory");
  skeleton = true;
  assert.equal(loaded(), false, "existing skeleton guards remain active");
});

test("managed connector matching ignores an unrelated plugin card mentioning its name", async () => {
  const { chromium } = require(require.resolve("playwright-core", { paths: [path.join(__dirname, "../../runtime-web")] }));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--no-proxy-server"],
  });
  try {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/plugins?view=personal", route => route.fulfill({
      contentType: "text/html",
      body: `<main><div role="tablist"><button role="tab" aria-selected="true">Personal</button></div><article style="width:320px;height:140px"><a aria-label="Open Build Web Apps" href="/plugins/plugins~Plugin_build">
        <h2>Build Web Apps</h2><span>Coding Tools Native2</span></a></article></main>`,
    }));
    await page.goto("https://chatgpt.com/plugins?view=personal");
    await page.evaluate(extensionHelpersSource());
    const first = await page.evaluate(() => {
      const helpers = globalThis.__codingToolsConnectorHelpers;
      return { available: typeof helpers.findManagedAppCard, href: helpers.findManagedAppCard?.("Coding Tools Native2")?.getAttribute("href") ?? null };
    });
    assert.equal(first.available, "function");
    assert.equal(first.href, null);
    await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('beforeend', '<div data-testid="plugin-source-tabs-placeholder"></div>'));
    assert.equal(await page.evaluate(() => globalThis.__codingToolsConnectorHelpers.personalPluginsLoaded?.()), false);
    await page.evaluate(() => document.querySelector('[data-testid="plugin-source-tabs-placeholder"]').remove());
    await page.evaluate(() => document.querySelector("main").insertAdjacentHTML("beforeend",
      '<section><h2>Installed</h2><a aria-label="Open Coding Tools Native2" href="/plugins/plugins~Plugin_managed"><span>Coding Tools Native2</span></a></section><section><h2>Created by me</h2><a aria-label="Open Coding Tools Native2" href="/plugins/plugins~Plugin_managed"><span>Coding Tools Native2</span></a></section>'));
    assert.equal(await page.evaluate(() => globalThis.__codingToolsConnectorHelpers.findManagedAppCard("Coding Tools Native2")?.getAttribute("href")),
      "/plugins/plugins~Plugin_managed");
  } finally {
    await browser.close();
  }
});

test("a loading Personal directory reuses its existing connector without opening Create", async () => {
  const { chromium } = require(require.resolve("playwright-core", { paths: [path.join(__dirname, "../../runtime-web")] }));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--no-proxy-server"],
  });
  try {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/plugins?view=personal", route => route.fulfill({
      contentType: "text/html",
      body: `<meta charset="utf-8"><main><div role="tablist"><button role="tab" aria-selected="true">Personal</button></div>
        <section><h2>Installed</h2><a aria-label="Coding Tools Native2" href="/plugins/plugin_asdk_app_existing?directoryTab=personal"><span>Coding Tools Native2</span></a></section>
        <section id="grid"></section><button id="add">Add</button></main>
        <script>window.createAttempts = 0; document.querySelector('#add').onclick = () => { createAttempts++; };
        setTimeout(() => { document.querySelector('#grid').innerHTML = '<div>Loading plugins…</div>'; }, 200);
        setTimeout(() => { document.querySelector('#grid').innerHTML = '<h2>Created by you</h2><div style="position:relative;width:320px;height:140px"><a style="position:absolute;inset:0" aria-labelledby="personal-title" href="/plugins/plugin_asdk_app_existing?directoryTab=personal"></a><div id="personal-title"><span>Coding Tools Native2</span></div></div>'; }, 2500);</script>`,
    }));
    await page.goto("https://chatgpt.com/plugins?view=personal");
    await page.evaluate(extensionHelpersSource({ testLegacy: true }));
    assert.equal(await page.evaluate(() => document.characterSet), "UTF-8");
    const result = await page.evaluate(async () => ({
      ...(await globalThis.__codingToolsConnectorHelpers.createTunnelConnector({
        name: "Coding Tools Native2", tunnelId: "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", authentication: "none",
      })),
      createAttempts: globalThis.createAttempts,
    }));
    assert.deepEqual(result, { created: false, href: "/plugins/plugin_asdk_app_existing?directoryTab=personal", createAttempts: 0 });
  } finally {
    await browser.close();
  }
});

for (const previouslySeen of [false, true]) test(`observed Tunnel form ${previouslySeen ? "rejects a previously visible confirmation identity" : "confirms a newly created connector"}`, async () => {
  const { chromium } = require(require.resolve("playwright-core", { paths: [path.join(__dirname, "../../runtime-web")] }));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--no-proxy-server"],
  });
  try {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/plugins?view=personal", route => route.fulfill({
      contentType: "text/html",
      body: '<main><div role="tablist"><button role="tab" aria-selected="true">Personal</button></div><section><h2>Created by me</h2><article style="width:320px;height:140px"><a href="/plugins/plugins~Plugin_other"><h2>Other App</h2></a></article></section><button id="open">Create app</button></main>',
    }));
    await page.goto("https://chatgpt.com/plugins?view=personal");
    await page.evaluate(() => {
      document.querySelector("#open").onclick = () => {
        document.body.insertAdjacentHTML("beforeend", `<div role="dialog" style="width:420px;height:400px">
          <input id="custom-connector-name" aria-label="Name" type="text">
          <button role="radio" aria-label="Server URL">Server URL</button>
          <button role="radio" aria-label="Tunnel">Tunnel</button>
          <select id="custom-connector-tunnel-select"><option>Loading tunnels...</option></select>
          <button id="use-id">Use tunnel ID instead</button>
          <select id="custom-connector-auth"><option value="OAUTH">OAuth</option><option value="NONE">No Auth</option></select>
          <label>I understand <input id="trust-checkbox" type="checkbox"></label>
          <button id="save">Create</button></div>`);
        const dialog = document.querySelector('[role="dialog"]');
        dialog.querySelector('[aria-label="Tunnel"]').onclick = event => event.currentTarget.setAttribute("aria-checked", "true");
        dialog.querySelector("#use-id").onclick = () => {
          dialog.querySelector("#custom-connector-tunnel-select").outerHTML = '<input id="custom-connector-tunnel-id" type="text" placeholder="tunnel_0123456789abcdef0123456789abcdef">';
          dialog.querySelector("#use-id").remove();
        };
        dialog.querySelector("#save").onclick = () => {
          globalThis.submittedConnector = {
            name: dialog.querySelector("#custom-connector-name").value,
            tunnelId: dialog.querySelector("#custom-connector-tunnel-id").value,
            authentication: dialog.querySelector("#custom-connector-auth").value,
            trusted: dialog.querySelector("#trust-checkbox").checked,
          };
          dialog.remove();
          document.querySelector("main section").insertAdjacentHTML("beforeend", `<article style="width:320px;height:140px"><a aria-label="Open ${globalThis.submittedConnector.name}" href="/plugins/plugins~Plugin_created"><h2>${globalThis.submittedConnector.name}</h2></a></article>`);
        };
      };
    });
    await page.evaluate(extensionHelpersSource({ testLegacy: true }));
    if (previouslySeen) await page.evaluate(() => document.querySelector("main").insertAdjacentHTML("beforeend",
      '<section><h2>Installed</h2><a aria-label="Coding Tools Native2" href="/plugins/plugins~Plugin_created"><span>Coding Tools Native2</span></a></section>'));
    const settings = currentConnectorSettings(runtime());
    const pending = page.evaluate(async settings => {
      const helpers = globalThis.__codingToolsConnectorHelpers;
      const available = typeof helpers.createTunnelConnector;
      if (available !== "function") return { available };
      return { available, ...(await helpers.createTunnelConnector(settings)), submitted: globalThis.submittedConnector };
    }, settings);
    if (previouslySeen) {
      await assert.rejects(pending, /existing connector.*Create/i);
      return;
    }
    const result = await pending;
    assert.equal(result.available, "function");
    assert.equal(result.created, true);
    assert.equal(result.href, "/plugins/plugins~Plugin_created");
    assert.deepEqual(result.submitted, { name: settings.name, tunnelId: settings.tunnelId, authentication: "NONE", trusted: true });
  } finally {
    await browser.close();
  }
});
