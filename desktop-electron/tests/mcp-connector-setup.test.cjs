const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const path = require("node:path");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { chatGptMcpContext, chatGptMcpContextScript, platformMcpOwnerContext, observeMcpSetupContext, navigationPlace, createConfiguredConnector, currentConnectorSettings, connectorCredentials, extensionHelpersSource } = require("../electron/mcp-connector-setup.cjs");
const { mcpConnectorCommandFailure } = require("../electron/mcp-connector-command.cjs");

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
    chatGptOrganizationId: "chatgpt-organization", planType: "team", workspaceName: "Untrusted label",
  });
  assert.doesNotMatch(JSON.stringify(chatGptMcpContext(context)), /DO_NOT_RETURN/);
  assert.equal(chatGptMcpContext(context).workspaceRole, "account-owner", "a display name is only a navigation hint");
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
  observed("GET", "https://chatgpt.com/backend-api/models", { "chatgpt-account-id": businessId }, {});
  assert.equal(observer.snapshot().navigationAccountId, businessId, "ordinary navigation can signal when a workspace switch finishes");
  assert.equal(observer.snapshot().activeAccountId, null, "navigation hints cannot establish connector workspace authority");
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

test("the plugins page's current list request (GET ps/plugins/list) names the selected workspace", async t => {
  // Live on 2026-11-09 the page no longer sent POST list_accessible; this request carries the
  // selected workspace now, and without it no Connect could confirm a workspace.
  const businessId = "602b5d8d-e211-49b1-9762-206108d52954", otherId = "6d4774fd-0e67-4b5b-a3b7-4c0e61357122";
  const { debuggerClient, observed } = fakeMcpNetwork();
  const observer = await observeMcpSetupContext({ debugger: debuggerClient }, null);
  t.after(() => observer.dispose());
  for (const [method, url] of [["POST", "https://chatgpt.com/backend-api/ps/plugins/list"],
    ["GET", "https://chatgpt.com/backend-api/ps/plugins/installed"], ["GET", "https://evil.example/backend-api/ps/plugins/list"]]) {
    observed(method, url, { "chatgpt-account-id": otherId }, {});
    assert.equal(observer.snapshot().activeAccountId, null, `${method} ${url} is no workspace proof`);
  }
  observed("GET", "https://chatgpt.com/backend-api/ps/plugins/list?limit=50", { "ChatGPT-Account-ID": businessId }, {});
  const selected = observer.snapshot();
  assert.equal(selected.activeAccountId, businessId);
  observed("GET", "https://chatgpt.com/backend-api/ps/plugins/list", { "chatgpt-account-id": businessId }, {});
  assert.equal(observer.snapshot().selectionVersion, selected.selectionVersion, "the same workspace listed again is no switch");
  observed("POST", "https://chatgpt.com/backend-api/aip/connectors/mcp/list_accessible", { "chatgpt-account-id": otherId }, {});
  assert.equal(observer.snapshot().activeAccountId, otherId, "the older request still counts");
  assert(observer.snapshot().selectionVersion > selected.selectionVersion, "another workspace invalidates the captured context");
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

test("a setup window that moved is named by host and path only", () => {
  assert.equal(navigationPlace("https://platform.openai.com/login?next=%2Fsettings&token=SECRET#frag"), "platform.openai.com/login");
  assert.equal(navigationPlace("https://chatgpt.com/auth/<b>x"), "chatgpt.com/auth/3Cb3Ex");
  assert.equal(navigationPlace("https://cdn.platform.openai.com/" + "a".repeat(200)).length, "cdn.platform.openai.com".length + 80);
  assert.equal(navigationPlace("about:blank"), "about");
  assert.equal(navigationPlace("javascript:alert(1)"), null);
  assert.equal(navigationPlace("not a url"), null);
});

test("the production connector action verifies fresh owner and workspace proof before each mutation", async t => {
  const personalId = "6d4774fd-0e67-4b5b-a3b7-4c0e61357122", businessId = "602b5d8d-e211-49b1-9762-206108d52954";
  const tunnelId = `tunnel_${"a".repeat(32)}`, initialUser = "user-fixture", org = "org-fixture";
  for (const scenario of [
    { name: "Personal free succeeds with its actual observed workspace" },
    { name: "Business succeeds with its distinct binding", business: true },
    { name: "an iframe redirect cannot invalidate the account context", redirect: "iframe" },
    { name: "a details-event iframe redirect cannot invalidate the account context", redirect: "iframe", details: true },
    { name: "a main-frame redirect to another site stays blocked", redirect: "main", error: /navigation.*changed/i },
    { name: "a details-event main-frame redirect to another site stays blocked", redirect: "main", details: true, error: /navigation.*changed/i },
    { name: "a redirect without frame information stays blocked", redirect: "unknown", error: /navigation.*changed/i },
    { name: "a team admin cannot create even when the tunnel belongs to that user", business: true, creatorRole: "account-admin", error: /verified owner/ },
    { name: "a team member cannot create even when the tunnel belongs to that user", business: true, creatorRole: "standard-user", error: /verified owner/ },
    { name: "a team admin reuses exact fresh saved identity without Platform access", business: true, creatorRole: "account-admin", existingOnly: true, existing: true },
    { name: "a team member reuses exact fresh saved identity without Platform access", business: true, creatorRole: "standard-user", existingOnly: true, existing: true },
    { name: "existing-only cannot create when the renderer returns a new form", business: true, creatorRole: "standard-user", existingOnly: true, error: /unverified/i },
    { name: "a member cannot reuse unreadable saved identity", business: true, creatorRole: "standard-user", existingOnly: true, existing: true, identityMissing: true, error: /unverified/i },
    { name: "a member cannot reuse a different saved tunnel", business: true, creatorRole: "standard-user", existingOnly: true, existing: true, identityWrong: true, error: /unverified/i },
    { name: "a member's workspace change during saved identity inspection stops consent", business: true, creatorRole: "standard-user", existingOnly: true, existing: true, change: "reuse-workspace", error: /context|workspace.*changed/i },
    { name: "a rejected identity read cannot hide a simultaneous member workspace change", business: true, creatorRole: "standard-user", existingOnly: true, existing: true, change: "reuse-workspace-reject", error: /context|workspace.*changed/i },
    { name: "a rejected existing-app lookup cannot hide a simultaneous workspace change", business: true, creatorRole: "standard-user", existingOnly: true, existing: true, change: "reuse-prepare-workspace-reject", error: /context|workspace.*changed/i },
    { name: "an unknown workspace role cannot grant creation access", business: true, creatorRole: "future-role", error: /verified owner/ },
    { name: "owner authority revoked after prepare cannot submit", business: true, change: "owner-role", error: /context.*changed/i },
    { name: "another Platform creator cannot be reused", nonOwner: true, error: /different Platform user/ },
    { name: "unknown creator shape cannot be guessed", unknownOwner: true, error: /ownership.*unknown/ },
    { name: "incompatible workspace evidence cannot submit", mismatch: true, error: /workspace context.*unknown/ },
    { name: "workspace switch after preparing cannot submit", change: "workspace", error: /context|workspace.*changed/i },
    { name: "subject switch after preparing cannot submit", change: "user", error: /context|authentication.*changed/i },
    { name: "partition switch after preparing cannot submit", change: "partition", error: /account|partition|context/i },
    { name: "unexpected document navigation after preparing cannot submit", change: "navigation", error: /navigation|context/i },
    // Live 2026-11-09: Platform's page went from tunnels to /login once it had loaded, and every Connect stopped there.
    { name: "Platform signing itself in while its tunnels load is part of the Platform step", change: "platform-sign-in" },
    { name: "a Platform page that leaves OpenAI's sign-in for another site stops and names it", change: "platform-elsewhere",
      error: error => /navigation changed/.test(error.message) && error.navigatedTo === "accounts.example.com/o/oauth2/auth"
        && mcpConnectorCommandFailure(error).message.endsWith(" It moved to accounts.example.com/o/oauth2/auth.") },
    { name: "a busy caller after preparing cannot submit", change: "busy", error: /busy/i },
    // Live 2026-11-13: an automatic setup refused Log out and Remove account for its whole run.
    { name: "the person's own logout stops the setup and closes its window, which is not a failure", change: "stopped",
      error: error => error.mcpStopped === true && /stopped for ChatGPT logout/.test(error.message)
        && mcpConnectorCommandFailure(error).code === "stopped" },
    { name: "switching to manual mode after preparing cannot submit", change: "manual", error: /Zero Risk/i },
    { name: "unverified existing same-name connector stays frozen", existing: true, identityMissing: true, error: /existing connector.*tunnel.*unverified/i },
    { name: "consent is not confirmed after a later workspace switch", change: "consent", error: /context|workspace.*changed/i, submitted: true },
    { name: "a targeted primary account retains the same owner and workspace checks", primary: true },
    { name: "an exact account binding rechecks ownership and consent without creating again", existing: true, bound: true },
    { name: "a cached binding cannot replace missing fresh tunnel fields", existing: true, bound: true, identityMissing: true, error: /unverified/i },
    { name: "fresh tunnel fields cannot point to a different tunnel", existing: true, bound: true, identityWrong: true, error: /unverified/i },
    { name: "another workspace's saved binding cannot authorize reuse", existing: true, bound: true, wrongWorkspace: true, identityMissing: true, error: /unverified/i },
    { name: "another tunnel's saved binding cannot authorize reuse", existing: true, bound: true, wrongTunnel: true, identityMissing: true, error: /unverified/i },
    { name: "corrupt account provenance is preserved before any mutation", corrupt: true, error: /bindings could not be read/i },
    { name: "oversized account hints are preserved before any mutation", oversized: true, error: /bindings could not be read/i },
    { name: "a failed consent keeps creation provenance for a safe retry", consentError: true, error: /fixture consent failed/, submitted: true },
    { name: "a member connects using the original freshly verified publisher result", business: true, shared: true, transient: true },
    { name: "a member cannot borrow another workspace's creation provenance", business: true, shared: true, badPublisher: "workspace", error: /unverified/i },
    { name: "a member cannot borrow another tunnel's creation provenance", business: true, shared: true, badPublisher: "tunnel", error: /unverified/i },
    { name: "a member role change before consent invalidates the inspected context", business: true, shared: true, transient: true, change: "role", error: /context.*changed/i, submitted: true },
    { name: "a publisher's scoped cache alone cannot authorize a member", business: true, shared: true, publisherMoved: true, error: /unverified/i },
    { name: "an unavailable shared plugin does not seed a member binding", business: true, shared: true, transient: true, sharedUnavailable: true, error: /plugin connection/ },
    { name: "a transient publisher result cannot be replayed", business: true, shared: true, transient: true, replay: true },
    { name: "an owner creator explicitly selects its intended workspace in a fresh popup", business: true, selectAdmin: true },
    // Live 2026-11-13: the shown account's card read "ChatGPT verification is required in Coding Tools
    // Browser" while it was signed in: the Browser's own page (no ChatGPT tab open, a failed load)
    // answered "signed out" without asking. The setup's page proves the session for every account.
    { name: "the shown account connects though the Browser's own page cannot vouch for its sign-in", shownPageSignedOut: true },
  ]) await t.test(scenario.name, async () => {
    const work = path.resolve(__dirname, "../../aiTemp/account-mcp-bindings");
    fs.mkdirSync(work, { recursive: true });
    const userData = fs.mkdtempSync(path.join(work, "production-"));
    t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
    const bindingPath = path.join(userData, "mcp-account-connector-bindings.json");
    const other = { name: "Another account", tunnelId: `tunnel_${"b".repeat(32)}`, href: "/plugins/keep",
      userId: "user-keep", workspaceId: personalId };
    const oldWorkspaceHint = { ...other, name: currentConnectorSettings(runtime()).name, userId: initialUser,
      workspaceId: businessId, href: "/plugins/previous-workspace" };
    const oldScope = JSON.stringify(["persist:fixture", businessId, oldWorkspaceHint.tunnelId, oldWorkspaceHint.name]);
    const saved = { version: 1, bindings: { "persist:keep": { ...other, runtimeKey: "DO_NOT_COPY_HINT_KEY" } },
      scopedBindings: { [oldScope]: oldWorkspaceHint } };
    if (scenario.shared) saved.bindings["persist:admin"] = { name: currentConnectorSettings(runtime()).name,
      tunnelId: scenario.badPublisher === "tunnel" ? `tunnel_${"b".repeat(32)}` : tunnelId,
      userId: "user-admin", workspaceId: scenario.badPublisher === "workspace" ? personalId : businessId, href: "/plugins/plugin_fixture" };
    if (scenario.publisherMoved) {
      saved.scopedBindings = { [JSON.stringify(["persist:admin", businessId, tunnelId, currentConnectorSettings(runtime()).name])]: { ...saved.bindings["persist:admin"] } };
      saved.bindings["persist:admin"] = { ...saved.bindings["persist:admin"], workspaceId: personalId, href: "/plugins/different-workspace" };
    }
    if (scenario.bound) saved.bindings["persist:fixture"] = { name: currentConnectorSettings(runtime()).name,
      tunnelId: scenario.wrongTunnel ? `tunnel_${"b".repeat(32)}` : tunnelId,
      userId: initialUser, workspaceId: scenario.wrongWorkspace ? businessId : personalId, href: "/plugins/plugin_fixture" };
    const original = scenario.corrupt ? "invalid JSON retained" : JSON.stringify({ ...saved,
      ...(scenario.oversized ? { padding: "x".repeat(64 * 1024) } : {}) });
    fs.writeFileSync(bindingPath, original);
    const network = fakeMcpNetwork(), counts = { create: 0, open: 0, confirm: 0 };
    let platformVisits = 0, blockedRedirects = 0;
    let accountId = scenario.business && !scenario.selectAdmin ? businessId : personalId, userId = initialUser, destroyed = false, busy = false, url = "about:blank", windowCount = 0;
    let workspaceRole = scenario.shared ? "standard-user" : scenario.creatorRole ?? "account-owner", publishing = false, held = false, publisherResult;
    const runtimeHost = runtime();
    // What the browser's stopOperationFor aborts for the person's own sign-in, logout or removal.
    const stop = new AbortController();
    const host = { partition: "persist:fixture", probeAuthentication: async () => ({ authenticated: !scenario.shownPageSignedOut }),
      operationSignal: () => stop.signal,
      currentOperation: () => held ? "MCP connector creation" : null,
      withManualOperation: async (_name, work) => { const previous = held; held = true; try { return await work(); } finally { held = previous; } } };
    const select = id => network.observed("POST", "https://chatgpt.com/backend-api/aip/connectors/mcp/list_accessible", { "chatgpt-account-id": id }, {});
    const contents = new EventEmitter();
    Object.assign(contents, { debugger: network.debuggerClient, setWindowOpenHandler() {}, getURL: () => url,
      isDestroyed: () => destroyed,
      executeJavaScript: async script => {
        if (script.includes('fetch("/api/auth/session"')) {
          const entry = id => ({ can_access_with_session: true, account: { account_id: id, account_user_role: workspaceRole,
            structure: id === personalId ? "personal" : "workspace", plan_type: id === personalId ? "free" : "team", name: "Fixture workspace", is_deactivated: false } });
          const requested = script.match(/activeAccountId: "([a-f0-9-]+)"/)?.[1] || accountId;
          return chatGptMcpContext({ user: { id: userId }, auth: { chatgpt_user_id: userId }, activeAccountId: requested,
            accounts: scenario.mismatch ? {} : { [personalId]: entry(personalId), [businessId]: entry(businessId) } });
        }
        if (script.includes("globalThis.__codingToolsConnectorHelpers =")) return;
        const phase = script.match(/__codingToolsConnectorHelpers\.(\w+)\(/)?.[1];
        if (phase === "selectWorkspace") { accountId = businessId; select(accountId); return { selected: true }; }
        if (phase === "prepareTunnelConnector") {
          if (scenario.change === "reuse-prepare-workspace-reject") {
            accountId = personalId; select(accountId);
            throw new Error("Existing connector exact tunnel identity is unverified. Creation and connection were not attempted.");
          }
          if (scenario.existing) {
            return { prepared: true, existing: true, href: "/plugins/plugin_fixture" };
          }
          if (scenario.change === "workspace") { accountId = businessId; select(accountId); }
          if (scenario.change === "owner-role") workspaceRole = "account-admin";
          if (scenario.change === "user") userId = "user-other";
          if (scenario.change === "partition") host.partition = "persist:other";
          if (scenario.change === "navigation") { url = "https://chatgpt.com/"; contents.emit("did-start-navigation", {}, url, false, true); }
          if (scenario.change === "busy") busy = true;
          if (scenario.change === "manual") host.interactionModeOverride = "manual";
          if (scenario.change === "stopped") {
            stop.abort(Object.assign(new Error("MCP connector creation stopped for ChatGPT logout"), { forAction: "ChatGPT logout" }));
            assert.equal(destroyed, true, "the setup window closes as soon as it is stopped, not at its next step");
          }
          return { prepared: true };
        }
        if (phase === "submitPreparedTunnelConnector" || phase === "createTunnelConnector") { counts.create++; return { created: true, href: "/plugins/plugin_fixture" }; }
        if (phase === "inspectTunnelConnectorIdentity") {
          if (scenario.change === "reuse-workspace-reject") {
            accountId = personalId; select(accountId);
            throw new Error("Existing connector exact tunnel identity is unverified. Creation and connection were not attempted.");
          }
          if (scenario.identityMissing) throw new Error("Existing connector exact tunnel identity is unverified. Creation and connection were not attempted.");
          if (scenario.change === "reuse-workspace") { accountId = personalId; select(accountId); }
          return { verified: true, name: currentConnectorSettings(runtime()).name, href: "/plugins/plugin_fixture",
            tunnelId: scenario.identityWrong ? `tunnel_${"b".repeat(32)}` : tunnelId };
        }
        if (phase === "prepareTunnelConnectorConnection") {
          if (scenario.sharedUnavailable && !publishing) throw new Error("ChatGPT did not finish loading this plugin connection.");
          return { connected: false };
        }
        if (phase === "openTunnelConnectorConsent") {
          counts.open++;
          if (scenario.change === "role" && !publishing) workspaceRole = "account-admin";
          if (scenario.change === "consent") { accountId = businessId; select(accountId); }
          return { consentReady: true };
        }
        if (phase === "confirmTunnelConnectorConsent") {
          if (scenario.consentError) throw new Error("fixture consent failed");
          counts.confirm++; return { connected: true };
        }
        if (phase === "ensureTunnelConnectorConnected") { counts.open++; counts.confirm++; return; }
        throw new Error(`Unexpected fixture phase ${phase}`);
      },
    });
    let rendererInitialized = false;
    const attach = network.debuggerClient.attach.bind(network.debuggerClient);
    network.debuggerClient.attach = (...args) => {
      assert.equal(rendererInitialized, true, "initialize a renderer before awaiting network monitoring");
      return attach(...args);
    };
    function Window(options) {
      windowCount++;
      destroyed = false;
      assert.equal(options.show, false); assert.equal(options.webPreferences.offscreen, true);
      assert.equal(options.webPreferences.partition, publishing ? "persist:admin" : "persist:fixture");
      return { webContents: contents, isDestroyed: () => destroyed, destroy: () => { destroyed = true; },
        loadURL: async next => {
          if (next === "about:blank") { rendererInitialized = true; url = next; return; }
          contents.emit("did-start-navigation", {}, next, false, true); url = next;
          if (next.startsWith("https://platform.openai.com/")) {
            platformVisits++;
            assert(!scenario.shared || publishing, "a member never borrows Platform authentication from its publisher");
            assert(network.debuggerClient.isAttached(), "observation must precede Platform navigation");
            const observePlatform = () => {
              network.observed("POST", "https://api.openai.com/v1/dashboard/onboarding/login", {}, { user: { id: userId, orgs: { data: [{ id: org, role: "owner" }] } } });
              network.observed("GET", "https://api.openai.com/v1/dashboard/organization/permissions", { "openai-organization": org }, { data: ["api.organization.tunnel.read", "api.organization.tunnel.use"] });
              network.observed("GET", "https://api.openai.com/v1/tunnels", { "openai-organization": org }, { tunnels: [{ id: tunnelId,
                creator: scenario.unknownOwner ? { id: userId } : scenario.nonOwner ? "user-other" : userId, workspace_ids: [businessId], organization_ids: [] }] });
            };
            if (scenario.change === "platform-sign-in" || scenario.change === "platform-elsewhere") {
              // The page has loaded; its own router then goes through sign-in. No query reaches a message.
              setImmediate(() => {
                contents.emit("did-start-navigation", {}, "https://platform.openai.com/login?next=%2Fsettings%2Forganization%2Ftunnels", true, true);
                if (scenario.change === "platform-elsewhere") {
                  contents.emit("did-start-navigation", {}, "https://accounts.example.com/o/oauth2/auth?client_id=platform&state=SECRET", false, true);
                  return;
                }
                contents.emit("did-start-navigation", {}, "https://auth.openai.com/authorize?client_id=platform&state=SECRET", false, true);
                contents.emit("did-start-navigation", {}, "https://platform.openai.com/auth/callback?code=SECRET", false, true);
                contents.emit("did-start-navigation", {}, "https://platform.openai.com/settings/organization/tunnels", false, true);
                observePlatform();
              });
            } else observePlatform();
          } else if (next.startsWith("https://chatgpt.com/plugins")) {
            select(accountId);
            if (scenario.redirect) {
              const destination = "https://frame.invalid/redirect", mainFrame = scenario.redirect === "unknown" ? undefined : scenario.redirect === "main";
              const event = { preventDefault() { blockedRedirects++; }, ...(scenario.details ? { url: destination, isMainFrame: mainFrame } : {}) };
              contents.emit("will-redirect", event, scenario.details ? undefined : destination, false, scenario.details ? undefined : mainFrame);
            }
          }
        } };
    }
    const action = () => createConfiguredConnector({ app: { getPath: () => userData }, BrowserWindow: Window, browserHost: host, runtimeHost,
      target: { ...(scenario.primary ? {} : { tunnelId }), partition: "persist:fixture", requireTunnelMatch: true },
      existingOnly: scenario.existingOnly === true,
      ...(scenario.shared ? { expectedContext: { userId: initialUser, workspaceId: businessId,
        workspaceRole: "standard-user", workspaceStructure: "workspace" },
      operationHeld: scenario.transient === true,
      shared: { href: "/plugins/plugin_fixture", userId: "user-admin", workspaceId: businessId, tunnelId, creationResult: publisherResult,
        publisherPartition: "persist:admin", memberUserId: initialUser } } : {}),
      ...(scenario.selectAdmin ? { selectWorkspace: true, expectedContext: { userId: initialUser, workspaceId: businessId,
        workspaceRole: "account-owner", workspaceStructure: "workspace" } } : {}),
      assertCurrent: () => { if (busy) throw new Error("Caller is busy"); } });
    if (scenario.transient) {
      publishing = true; held = true; userId = "user-admin"; workspaceRole = "account-owner";
      publisherResult = await createConfiguredConnector({ app: { getPath: () => userData }, BrowserWindow: Window,
        browserHost: host, runtimeHost, operationHeld: true, target: { tunnelId, partition: "persist:admin" } });
      publishing = false; userId = initialUser; workspaceRole = "standard-user";
      counts.create = 0; counts.open = 0; counts.confirm = 0;
    }
    if (scenario.error) {
      await assert.rejects(action(), scenario.error);
      assert.deepEqual(counts, scenario.submitted ? { create: scenario.shared ? 0 : 1, open: 1, confirm: 0 } : { create: 0, open: 0, confirm: 0 });
      if (scenario.corrupt || scenario.oversized) assert.equal(fs.readFileSync(bindingPath, "utf8"), original);
      if (scenario.sharedUnavailable) assert.equal(JSON.parse(fs.readFileSync(bindingPath, "utf8")).bindings["persist:fixture"], undefined,
        "an inaccessible app cannot become the member's shared reconnection proof");
      if (scenario.consentError) {
        assert.equal(JSON.parse(fs.readFileSync(bindingPath, "utf8")).bindings["persist:fixture"].userId, initialUser);
        scenario.consentError = false; scenario.existing = true;
        assert.equal((await action()).connected, true);
        assert.equal(counts.create, 1, "a retry never creates a second connector");
      }
    } else {
      const result = await action();
      assert.deepEqual(result.binding, { userId: initialUser, workspaceId: accountId, tunnelId });
      assert.deepEqual(counts, { create: scenario.existing || scenario.shared ? 0 : 1, open: 1, confirm: 1 });
      assert.equal(result.connected, true);
      const retained = JSON.parse(fs.readFileSync(bindingPath, "utf8"));
      assert.deepEqual(retained.bindings["persist:keep"], other);
      assert.deepEqual(retained.scopedBindings[oldScope], oldWorkspaceHint, "another verified scope remains a hint after the new save");
      assert.doesNotMatch(JSON.stringify(retained), /DO_NOT_COPY_HINT_KEY|runtimeKey/);
      if (scenario.replay) await assert.rejects(action(), /unverified/i);
    }
    if (scenario.creatorRole) assert.equal(platformVisits, 0, "nonowners stop before Platform or form setup");
    if (scenario.redirect) assert.equal(blockedRedirects, scenario.redirect === "iframe" ? 0 : 1);
    assert.equal(windowCount, scenario.transient ? 2 : scenario.shared ? 0 : scenario.name.startsWith("a failed consent") ? 2 : 1);
    if (windowCount) assert.equal(destroyed, true);
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

test("an operation's repeated checks read the saved key once, off the main thread, never per check", async () => {
  // Live 2026-11-09: assertCurrent ran every 50 ms while ChatGPT confirmed a workspace, each run an
  // existsSync of the key file on the main thread; on the busy hard disk one held every window 17.9 s.
  const host = runtime();
  let syncChecks = 0;
  const asked = [];
  host.mcpCredentialsConfigured = () => { syncChecks += 1; throw new Error("checked on the main thread"); };
  host.mcpCredentialsConfiguredAsync = async (config, mode) => { asked.push([config.automaticTunnel.tunnelId, mode]); return true; };
  const credentials = await connectorCredentials(host);
  assert.equal(credentials, true);
  assert.deepEqual(asked, [[host.config.automaticTunnel.tunnelId, "automatic"]]);
  for (let check = 0; check < 240; check += 1) assert.equal(currentConnectorSettings(host, { credentials }).name, "Team Harness A");
  assert.equal(syncChecks, 0, "no check looked the key up again");
  // A missing key still refuses, and a renamed connector is still seen (the config is read each time).
  assert.throws(() => currentConnectorSettings(host, { credentials: false }), /automatic MCP harness/);
  host.config.automaticAppName = "Renamed";
  assert.equal(currentConnectorSettings(host, { credentials }).name, "Renamed");
  // A host that can only check synchronously keeps doing so.
  assert.equal(await connectorCredentials(runtime()), undefined);
  assert.equal(currentConnectorSettings(runtime()).name, "Team Harness A");
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
  const prepareContext = {
    location: { origin: "https://chatgpt.com" }, URL, document, isPersonalPluginsPage: () => true, isPluginDetailUrl: () => true,
    visible: () => true, textMatches: matches, PERSONAL_VIEW_LABELS: ["Personal"],
    waitFor: async read => read(), personalPluginsLoaded: () => true, clearPluginSearch: async () => {},
    findManagedAppCard: () => ({ getAttribute: () => "/plugins/existing" }),
    allClickable: () => { throw new Error("Existing connector must not open Create"); },
  };
  const prepare = phase("createTunnelConnector", "async function submitPreparedTunnelConnector", prepareContext);
  assert.deepEqual({ ...await prepare(settings, "prepare") },
    { prepared: true, existing: true, href: "/plugins/existing" });
  assert.deepEqual({ ...await prepare(settings, "existing") },
    { prepared: true, existing: true, href: "/plugins/existing" });
  const absent = phase("createTunnelConnector", "async function submitPreparedTunnelConnector", {
    ...prepareContext, findManagedAppCard: () => null, pluginCardLinks: () => [], pluginsPageRenderState: () => "empty",
  });
  await assert.rejects(absent(settings, "existing"), /unverified/i, "a missing app must stop before Add or Create is inspected");
  for (const existingHref of ["/plugins/other", "https://elsewhere.invalid/plugins/existing"]) {
    assert.equal((await prepare({ ...settings, existingHref }, "prepare")).href, "/plugins/existing",
      "a cached pathname supplies no authority or alternate navigation target");
  }
  for (const kind of ["exact", "wrong-tunnel", "wrong-name", "url-only", "duplicate", "tool-field", "unsaved-create"]) {
    const field = { id: kind === "tool-field" ? "tool-tunnel-id" : "custom-connector-tunnel-id", name: "", value: kind === "wrong-tunnel" ? `tunnel_${"b".repeat(32)}` : settings.tunnelId,
      getAttribute: name => name === "type" ? "text" : null };
    const nameField = { id: "custom-connector-name", value: kind === "wrong-name" ? "Other" : settings.name };
    const fields = [nameField, ...(kind === "url-only" ? [{ id: "server-url", value: "https://example.test/mcp", getAttribute: () => null }]
      : kind === "duplicate" ? [field, field] : [field])];
    const root = {}, page = { querySelector: () => root };
    const inspect = phase("inspectTunnelConnectorIdentity", "async function createTunnelConnector", {
      location: { origin: "https://chatgpt.com", pathname: "/plugins/existing", href: "https://chatgpt.com/plugins/existing" },
      document: page, isPluginDetailUrl: () => true, exactNameIn: () => true,
      activeSurface: () => root,
      canonicalAppIdentity: value => value.toLowerCase(), inputs: () => fields,
      allClickable: () => [{ textContent: kind === "unsaved-create" ? "Create" : "Save", getAttribute: () => null }], STRINGS: { manage: [] },
      textMatches: matches, visibleDialogs: () => [root], closeOpenDialog: async () => true,
      pointerActivateMenu: () => { throw new Error("Identity inspection cannot click Create, Save or Connect"); },
    });
    if (kind === "exact") assert.equal((await inspect(settings)).verified, true);
    else await assert.rejects(inspect(settings), /unverified/i);
  }
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

test("account IPC preserves legacy arbitration and records only the requested, still-existing account", async () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const snippet = source.slice(source.indexOf('  const connectAccountMcp ='), source.indexOf('  let accountMcpConfig ='));
  let handler, failure = null, signedIn = true, removeDuringSetup = false, removeDuringSave = false;
  const accounts = new Set(["main", "other"]), calls = [], records = [];
  const tunnels = [{ id: "extra", accountId: "other", tunnelId: "tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", state: "stopped" }];
  const context = {
    Error, handle: (_name, action) => { handler = action; }, assertFocusedMainWindow() {}, async assertFocusedMainWindowSettled() {}, IS_DEV_PROFILE: false,
    // The handler's hold on the automatic sync and its wait for the browser (browser-account-mcp.test.cjs).
    automaticAccountMcp: null, waitForManualOperation: async () => {}, MANUAL_MCP_CONNECT_WAIT_MS: 60_000,
    quitting: false, shutdownInProgress: false, runtimeStartupInFlight: Promise.resolve(), browserAccountsStatus: () => ({ switching: false }),
    mcpConnectorCommand: { request: (...args) => { calls.push(args); return "legacy"; } },
    browserAccounts: { has: id => accounts.has(id), partitionOf(id) { if (!accounts.has(id)) throw new Error("Unknown account"); return `persist:${id}`; },
      async recordConnector(id, result) { await Promise.resolve(); if (!accounts.has(id)) return false; records.push({ id, ...result }); return true; } },
    session: { fromPartition: partition => ({ cookies: { get: async () => { calls.push(partition); return []; } } }) },
    signedInFromCookies: () => signedIn, routeIdleAccountPartition: async partition => calls.push(`route:${partition}`), logger: { warn() {} },
    runtimeSupervisor: { extraTunnels: { status: () => tunnels,
      reconnect: async id => { calls.push(`reconnect:${id}`); tunnels[0].state = "ready"; },
      setConnector: async (id, href, binding) => { await Promise.resolve(); assert.equal(binding.tunnelId, tunnels[0].tunnelId); if (removeDuringSave) accounts.delete("other"); calls.push(`connector:${id}`); } } },
    recordBrowserWorkspaceContext() {}, automaticSetupGaveWay: require("../electron/browser-account-mcp.cjs").automaticSetupGaveWay,
    createWorkspaceConnector: async options => {
      calls.push(JSON.parse(JSON.stringify(options))); options.assertCurrent();
      if (failure) throw new Error(failure);
      if (removeDuringSetup) accounts.delete("other");
      return { created: false, href: "/plugins/plugins~Plugin_managed", name: "Coding Tools", connected: true,
        binding: { userId: "user-fixture", workspaceId: "6d4774fd-0e67-4b5b-a3b7-4c0e61357122", tunnelId: tunnels[0].tunnelId } };
    }, app: {}, BrowserWindow: {}, browserHost: { partition: "persist:main", ready: async () => {}, currentOperation: () => null }, runtimeHost: { currentOperation: () => null, runtimeConfigSnapshot: () => ({ configured: false }) }, publishBrowserAccounts() { assert(records.length > 0, "account persistence resolves before its update is published"); }, publishOperation() {},
    currentConnectorSettings: require("../electron/mcp-connector-setup.cjs").currentConnectorSettings,
    connectorCredentials: require("../electron/mcp-connector-setup.cjs").connectorCredentials,
    mcpConnectorCommandFailure: error => ({ code: "fixture_failure", message: error.message }),
    mcpConnectorFailureCause: () => null,
  };
  vm.runInNewContext(snippet, context);
  assert.equal(await handler({}), "legacy");
  context.runtimeHost.currentOperation = () => "setupMcp";
  await assert.rejects(handler({}, "other"), /current runtime setup/);
  assert.equal(calls.some(entry => entry?.target), false);
  context.runtimeHost.currentOperation = () => null;
  calls.length = 0; records.length = 0;
  await handler({}, "other");
  assert.deepEqual(calls.find(entry => entry?.target)?.target, { partition: "persist:other", requireTunnelMatch: true, tunnelId: tunnels[0].tunnelId });
  assert(calls.includes("route:persist:other") && calls.includes("reconnect:extra"));
  assert.deepEqual(records, [{ id: "other", bound: true }]);
  failure = "ChatGPT refused this connector";
  await assert.rejects(handler({}, "other"), /refused/);
  assert.deepEqual(records[1], { id: "other", error: failure });
  await assert.rejects(handler({}, "main"), /saved automatic MCP harness/);
  failure = null; signedIn = false; calls.length = 0;
  await assert.rejects(handler({}, "other"), /Sign in to this account/);
  assert.equal(calls.some(entry => entry?.target), false);
  signedIn = true; removeDuringSetup = true; calls.length = 0;
  await assert.rejects(handler({}, "other"), /Unknown account/);
  assert.equal(calls.includes("connector:extra"), false, "removed accounts cannot acquire a connector binding");
  accounts.add("other"); removeDuringSetup = false; removeDuringSave = true;
  await assert.rejects(handler({}, "other"), /Unknown account/);
  assert.equal(records.filter(record => record.bound).length, 1, "a stale persistence completion cannot mark a removed account connected");

  // An automatic setup that gave way (an account switch, the app left) failed nothing: no connector
  // error is recorded and no failure reaches the screen. The same error while still admitted did fail.
  const connectAccountMcp = vm.runInNewContext("connectAccountMcp", context);
  const operations = [];
  context.publishOperation = value => operations.push(value);
  accounts.add("other"); removeDuringSave = false; records.length = 0;
  let admitted = true;
  const admission = () => { if (!admitted) throw new Error("Automatic MCP setup is waiting for the focused, idle app and current account."); };
  context.createWorkspaceConnector = async options => {
    options.assertCurrent();
    admitted = false;
    options.assertCurrent();
  };
  await assert.rejects(connectAccountMcp("other", admission), error => /waiting for the focused, idle app/.test(error.message) && error.gaveWay === true);
  assert.deepEqual(records, [], "a setup that gave way leaves the account's connector state as it was");
  assert.equal(operations.at(-1).status, "cancelled");
  admitted = true;
  context.createWorkspaceConnector = async options => { options.assertCurrent(); throw new Error("ChatGPT refused this connector"); };
  await assert.rejects(connectAccountMcp("other", admission), /refused/);
  assert.deepEqual(records, [{ id: "other", error: "ChatGPT refused this connector" }]);
  assert.equal(operations.at(-1).status, "failed");
});

test("a request the page cancels itself neither confirms nor fails the workspace", async t => {
  // The plugins page drops its own list request on a tab switch or re-render, and Platform's SPA
  // drops its in-flight requests when it routes to sign-in. Each of those read as "MCP ownership
  // metadata is unavailable or exceeded its bound." and stopped Connect (2026-11-09).
  const businessId = "602b5d8d-e211-49b1-9762-206108d52954", otherId = "6d4774fd-0e67-4b5b-a3b7-4c0e61357122";
  const tunnelId = `tunnel_${"a".repeat(32)}`;
  const { debuggerClient, observed } = fakeMcpNetwork();
  const observer = await observeMcpSetupContext({ debugger: debuggerClient }, tunnelId);
  t.after(() => observer.dispose());
  observed("GET", "https://chatgpt.com/backend-api/ps/plugins/list", { "chatgpt-account-id": businessId }, {});
  const confirmed = observer.snapshot();
  assert.equal(confirmed.activeAccountId, businessId);
  const send = (requestId, url, headers) => debuggerClient.emit("message", {}, "Network.requestWillBeSent", { requestId,
    request: { method: "GET", url, headers } });
  const cancel = requestId => debuggerClient.emit("message", {}, "Network.loadingFailed", { requestId, canceled: true, errorText: "net::ERR_ABORTED" });

  send("same-again", "https://chatgpt.com/backend-api/ps/plugins/list", { "chatgpt-account-id": businessId });
  cancel("same-again");
  assert.equal(observer.snapshot().error, null, "a cancelled list request is not a failure");
  assert.equal(observer.snapshot().activeAccountId, businessId, "the same workspace stays confirmed");
  assert.equal(observer.snapshot().selectionVersion, confirmed.selectionVersion);

  send("other-cancelled", "https://chatgpt.com/backend-api/ps/plugins/list", { "chatgpt-account-id": otherId });
  cancel("other-cancelled");
  assert.equal(observer.snapshot().error, null);
  assert.equal(observer.snapshot().activeAccountId, null, "a cancelled request for another workspace still withdraws the old proof");
  observed("GET", "https://chatgpt.com/backend-api/ps/plugins/list", { "chatgpt-account-id": otherId }, {});
  assert.equal(observer.snapshot().activeAccountId, otherId, "only an answered request confirms the new one");

  send("platform-cancelled", "https://api.openai.com/v1/tunnels", { "openai-organization": "org-fixture" });
  cancel("platform-cancelled");
  assert.equal(observer.snapshot().error, null, "Platform's own redirect cancelling a request is not a failure");
  assert.equal(observer.snapshot().platform.tunnels, null, "and it proves nothing");

  send("refused", "https://chatgpt.com/backend-api/ps/plugins/list", { "chatgpt-account-id": otherId });
  debuggerClient.emit("message", {}, "Network.loadingFailed", { requestId: "refused", errorText: "net::ERR_CONNECTION_RESET" });
  assert.match(observer.snapshot().error, /metadata.*unavailable/i, "a request that really failed still stops setup");
});

test("an account with no personal plugins has no Personal tab; Connect goes on to Add instead of failing", async () => {
  // Live 2026-11-09: "ChatGPT did not expose one Personal plugins tab." on accounts that never made a
  // plugin. ChatGPT drops the tab and ?view=personal while that list is empty.
  const { chromium } = require(require.resolve("playwright-core", { paths: [path.join(__dirname, "../../runtime-web")] }));
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--no-proxy-server"],
  });
  const settings = { name: "Coding Tools Native2", tunnelId: `tunnel_${"a".repeat(32)}`, authentication: "none" };
  const emptyPage = `<meta charset="utf-8"><main><div role="tablist"><button role="tab" aria-selected="true">Public</button>
    <button role="tab" aria-selected="false">leung workspace</button></div><input type="search" aria-label="Search plugins">
    <p>No plugins found</p><button id="add">Add</button></main>
    <script>window.addClicks = 0; document.querySelector('#add').onclick = () => { addClicks++; };</script>`;
  const open = async (body, script) => {
    const page = await browser.newPage();
    // ChatGPT's own redirect for an empty personal list lands on the bare path.
    await page.route("https://chatgpt.com/plugins", route => route.fulfill({ contentType: "text/html", body }));
    await page.goto("https://chatgpt.com/plugins");
    if (script) await page.evaluate(script);
    await page.evaluate(extensionHelpersSource({ testLegacy: true }));
    return page;
  };
  const outcome = (page, call) => page.evaluate(async ([call, settings]) => {
    const h = globalThis.__codingToolsConnectorHelpers;
    try {
      const value = call === "existing" ? await h.prepareTunnelConnector(settings, true) : await h.createTunnelConnector(settings);
      return { value, addClicks: globalThis.addClicks };
    } catch (error) { return { error: error.message, addClicks: globalThis.addClicks }; }
  }, [call, settings]);
  try {
    // What the helper itself reads.
    const page = await open(emptyPage);
    assert.equal(await page.evaluate(() => globalThis.__codingToolsConnectorHelpers.personalListEmpty()), true, "a settled tab bar with no Personal tab is an empty list");
    for (const [name, change] of [
      ["the tab bar is still a placeholder", () => document.querySelector("main").insertAdjacentHTML("beforeend", '<div data-testid="plugin-source-tabs-placeholder"></div>')],
      ["the directory still shows its loader", () => document.querySelector("main").insertAdjacentHTML("beforeend", '<div style="width:80px;height:20px">Loading plugins…</div>')],
      ["a Personal tab is there", () => document.querySelector('[role="tablist"]').insertAdjacentHTML("beforeend", '<button role="tab" aria-selected="false">Personal</button>')],
      ["no tab bar has painted yet", () => document.querySelector('[role="tablist"]').remove()],
    ]) {
      const probe = await open(emptyPage, change);
      assert.equal(Boolean(await probe.evaluate(() => globalThis.__codingToolsConnectorHelpers.personalListEmpty())), false, `not empty while ${name}`);
      await probe.close();
    }

    // A member's existing-only run: nothing personal, so the connector is absent (not a page failure).
    const existing = await outcome(page, "existing");
    assert.match(existing.error, /exact tunnel identity is unverified/, JSON.stringify(existing));
    assert.equal(existing.addClicks, 0, "an existing-only run never opens Add");
    // An owner's run goes on to the Add action (this fixture's Add opens nothing).
    const create = await outcome(page, "create");
    assert.equal(create.error, "ChatGPT did not open its custom MCP server form.", JSON.stringify(create));
    assert.equal(create.addClicks, 1);

    // A Personal tab that is only late wins: its existing connector is reused and Add is never clicked.
    const late = await open(emptyPage, () => setTimeout(() => {
      document.querySelector('[role="tablist"]').insertAdjacentHTML("beforeend", '<button role="tab" aria-selected="true">Personal</button>');
      document.querySelector('[role="tab"]').setAttribute("aria-selected", "false");
      document.querySelector("main p").outerHTML = '<section><h2>Created by you</h2><article style="width:320px;height:140px"><a aria-label="Open Coding Tools Native2" href="/plugins/plugins~Plugin_managed"><h2>Coding Tools Native2</h2></a></article></section>';
    }, 600));
    const reused = await outcome(late, "create");
    assert.deepEqual(reused, { value: { created: false, href: "/plugins/plugins~Plugin_managed" }, addClicks: 0 });
  } finally {
    await browser.close();
  }
});
