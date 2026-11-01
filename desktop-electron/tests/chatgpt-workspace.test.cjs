"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const setup = require("../electron/mcp-connector-setup.cjs");
const { ADMIN_REQUIRED, PUBLISH_REQUIRED, isWorkspaceAdmin } = require("../electron/chatgpt-workspace.cjs");
const workspaceId = "602b5d8d-e211-49b1-9762-206108d52954";
const otherWorkspace = "6d4774fd-0e67-4b5b-a3b7-4c0e61357122";

function fixture(options = {}) {
  const profiles = {
    "persist:member": { userId: "user-member", activeId: workspaceId, memberships: { [workspaceId]: "standard-user" } },
    "persist:admin": { userId: "user-admin", activeId: workspaceId, memberships: { [workspaceId]: "account-admin" } },
    "persist:owner": { userId: "user-owner", activeId: workspaceId, memberships: { [workspaceId]: "account-owner" } },
  };
  const calls = [], windows = [], contexts = [];
  let removed = false;
  function Window(config) {
    const partition = config.webPreferences.partition, profile = profiles[partition];
    assert.equal(config.show, false);
    assert.equal(config.webPreferences.sandbox, true);
    const contents = new EventEmitter();
    const state = { activeId: profile.activeId, version: 1, destroyed: false, partition };
    Object.assign(contents, { state, setWindowOpenHandler() {}, executeJavaScript: async script => {
      if (script.includes('fetch("/api/auth/session"')) {
        const id = script.match(/activeAccountId: "([a-f0-9-]+)"/)?.[1];
        return setup.chatGptMcpContext({ user: { id: profile.userId }, auth: { chatgpt_user_id: profile.userId }, activeAccountId: id,
          accounts: Object.fromEntries(Object.entries(profile.memberships).map(([key, role]) => [key, {
            can_access_with_session: true, account: { account_id: key, account_user_role: role, structure: "workspace",
              is_deactivated: false, plan_type: "team", name: key === workspaceId ? "Target workspace" : "Other workspace" },
          }])) });
      }
      if (script.includes("globalThis.__codingToolsConnectorHelpers =")) return;
      if (script.includes(')("creation-access",')) return { allowed: options.memberCanCreate === true };
      if (script.includes(')("select",')) {
        calls.push(["select", partition]);
        state.activeId = workspaceId; state.version++;
        return { selected: true };
      }
      if (script.includes(')("prepare-publish",')) {
        calls.push(["prepare-publish", partition]);
        if (options.revokeAdmin) profile.memberships[workspaceId] = "standard-user";
        return { available: !options.noPublishControl, prepared: true };
      }
      if (script.includes(')("confirm-publish",')) { calls.push(["publish", partition]); return { submitted: true, published: true }; }
      throw new Error("Unexpected workspace script");
    } });
    const window = { webContents: contents, isDestroyed: () => state.destroyed,
      destroy: () => { state.destroyed = true; }, loadURL: async url => { contents.emit("did-start-navigation", {}, url, false, true); } };
    windows.push(window);
    return window;
  }
  const dependency = { ...setup,
    currentConnectorSettings: () => ({ name: "Coding Tools", tunnelId: `tunnel_${"a".repeat(32)}` }),
    requireAutomaticConnectorSetup() {},
    readAccountConnectorBindings: () => ({ version: 1, bindings: options.bindings || {}, scopedBindings: options.scopedBindings }),
    observeMcpSetupContext: async (contents, tunnelId) => {
      assert.equal(tunnelId, null, "plan/role inspection never requires Platform login");
      return { snapshot: () => ({ activeAccountId: contents.state.activeId, selectionVersion: contents.state.version }), dispose() {} };
    },
    createConfiguredConnector: async input => {
      assert.equal(input.operationHeld, true, "one outer operation owns both accounts");
      input.assertCurrent?.();
      const partition = input.target.partition, profile = profiles[partition];
      assert.equal(input.expectedContext.userId, profile.userId);
      assert.equal(input.expectedContext.workspaceId, workspaceId);
      if (partition === "persist:member" && !input.shared && !options.memberCanCreate) throw new Error("ChatGPT did not open its connector form.");
      if (partition === "persist:owner" && options.wrongTunnelOwner) {
        throw Object.assign(new Error("The selected tunnel belongs to a different Platform user. Choose a tunnel created by the signed-in account."), { mcpMutationStarted: false });
      }
      if (partition !== "persist:member" && options.serverDenied) throw new Error("The MCP server denied access.");
      calls.push([input.shared ? "connect-member" : "create", partition]);
      if (input.shared) {
        assert.equal(input.shared.workspaceId, workspaceId);
        assert.equal(input.shared.memberUserId, "user-member");
        assert.notEqual(input.shared.userId, "user-member");
        if (options.memberUnavailable) throw Object.assign(new Error("ChatGPT did not finish loading this plugin connection."), { mcpMutationStarted: false });
      }
      return { created: !input.shared, name: "Coding Tools", href: "/plugins/exact-fixture", connected: true,
        binding: { userId: profile.userId, workspaceId, tunnelId: `tunnel_${"a".repeat(32)}` } };
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../electron/chatgpt-workspace.cjs"), "utf8"), {
    module, require: name => { assert.equal(name, "./mcp-connector-setup.cjs"); return dependency; },
    URL, Date, setTimeout, clearTimeout,
  });
  const candidates = ["admin", ...(options.owner ? ["owner"] : [])].map(id => ({ id, partition: `persist:${id}`,
    prepare: async () => { calls.push(["route", id]); }, assertCurrent: () => { if (removed) throw new Error("Account removed"); } }));
  let busy = false, locks = 0;
  const input = { BrowserWindow: Window, browserHost: { withManualOperation: async (_name, action) => {
    assert.equal(busy, false); busy = true; locks++; try { return await action(); } finally { busy = false; }
  } }, target: { partition: "persist:member" }, assertCurrent() {},
  onContext: (partition, context) => contexts.push({ partition, context }), accountCandidates: async () => candidates };
  return { ...module.exports, input, profiles, calls, contexts, windows, locks: () => locks,
    remove: () => { removed = true; }, run: () => module.exports.createWorkspaceConnector(input) };
}

test("workspace authority requires an exact server role and a workspace structure", () => {
  assert.equal(isWorkspaceAdmin({ workspaceStructure: "workspace", workspaceRole: "account-owner" }), true);
  assert.equal(isWorkspaceAdmin({ workspaceStructure: "workspace", workspaceRole: "account-admin" }), true);
  for (const context of [{ workspaceStructure: "personal", workspaceRole: "account-owner" },
    { workspaceStructure: "workspace", workspaceRole: "standard-user", planType: "pro", workspaceName: "Owner" },
    { workspaceStructure: "workspace", workspaceRole: "owner" }]) assert.equal(isWorkspaceAdmin(context), false);
});

test("same-workspace owner is preferred, publishes there, and connects the original member", async () => {
  const f = fixture({ owner: true });
  const result = await f.run();
  assert.equal(result.setupAccountId, "owner");
  assert.equal(result.connected, true);
  assert.deepEqual(f.calls.filter(call => ["create", "publish", "connect-member"].includes(call[0])), [
    ["create", "persist:owner"], ["publish", "persist:owner"], ["connect-member", "persist:member"],
  ]);
  assert.equal(f.locks(), 1);
  assert(f.windows.every(window => window.isDestroyed()));
  assert(f.contexts.some(value => value.partition === "persist:member" && value.context.planType === "team"));
});

test("an owner/admin in another selected workspace is selected and verified by exact workspace id", async () => {
  const f = fixture();
  f.profiles["persist:admin"].activeId = otherWorkspace;
  f.profiles["persist:admin"].memberships[otherWorkspace] = "standard-user";
  assert.equal((await f.run()).setupAccountId, "admin");
  assert(f.calls.some(call => call[0] === "select"));
  assert(f.windows.every(window => window.isDestroyed()));
});

test("another workspace's admin and another partition of the same member cannot lend authority", async t => {
  for (const kind of ["unrelated", "same-user", "role-revoked"]) await t.test(kind, async () => {
    const f = fixture();
    if (kind === "unrelated") {
      f.profiles["persist:admin"].activeId = otherWorkspace;
      f.profiles["persist:admin"].memberships = { [otherWorkspace]: "account-owner" };
    } else if (kind === "same-user") f.profiles["persist:admin"].userId = "user-member";
    else f.profiles["persist:admin"].memberships[workspaceId] = "standard-user";
    await assert.rejects(f.run(), error => error.message === ADMIN_REQUIRED);
    assert.equal(f.calls.some(call => ["create", "publish", "connect-member"].includes(call[0])), false);
    assert(f.windows.every(window => window.isDestroyed()));
  });
});

test("a delegated member can still create without an administrator account", async () => {
  const f = fixture({ memberCanCreate: true });
  f.profiles["persist:admin"].memberships[workspaceId] = "standard-user";
  assert.equal((await f.run()).connected, true);
  assert.deepEqual(f.calls.filter(call => call[0] === "create"), [["create", "persist:member"]]);
});

test("an available workspace owner cannot displace a delegated member's working tunnel identity", async () => {
  const f = fixture({ memberCanCreate: true, owner: true });
  assert.equal((await f.run()).connected, true);
  assert.deepEqual(f.calls.filter(call => call[0] === "create"), [["create", "persist:member"]]);
  assert.equal(f.calls.some(call => call[0] === "publish"), false);
});

test("a tunnel-ineligible owner does not hide an eligible workspace admin", async () => {
  const f = fixture({ owner: true, wrongTunnelOwner: true });
  assert.equal((await f.run()).setupAccountId, "admin");
  assert.deepEqual(f.calls.filter(call => call[0] === "create"), [["create", "persist:admin"]]);
});

test("verified shared provenance reconnects a member without a signed-in publisher", async () => {
  const publisher = { userId: "user-admin", workspaceId, name: "Coding Tools", tunnelId: `tunnel_${"a".repeat(32)}`, href: "/plugins/exact-fixture" };
  const f = fixture({ bindings: { "persist:admin": publisher,
    "persist:member": { ...publisher, userId: "user-member", publisherPartition: "persist:admin", publisherUserId: "user-admin" } } });
  f.input.accountCandidates = async () => { throw new Error("Publisher sign-in must not be required for an already shared connector"); };
  assert.equal((await f.run()).connected, true);
  assert.deepEqual(f.calls.filter(call => call[0] === "connect-member"), [["connect-member", "persist:member"]]);
});

test("cached publisher proofs stay scoped when its latest workspace changes", async () => {
  const publisher = { userId: "user-admin", workspaceId, name: "Coding Tools", tunnelId: `tunnel_${"a".repeat(32)}`, href: "/plugins/exact-fixture" };
  const f = fixture({ bindings: { "persist:admin": { ...publisher, workspaceId: otherWorkspace },
    "persist:member": { ...publisher, userId: "user-member", publisherPartition: "persist:admin", publisherUserId: "user-admin" } }, scopedBindings: {
    [JSON.stringify(["persist:admin", workspaceId, publisher.tunnelId, publisher.name])]: publisher,
  } });
  f.input.accountCandidates = async () => { throw new Error("Latest publisher workspace cannot erase exact earlier creation proof"); };
  assert.equal((await f.run()).connected, true);
});

test("an unavailable cached shared plugin reports the publishing action instead of a loading error", async () => {
  const publisher = { userId: "user-admin", workspaceId, name: "Coding Tools", tunnelId: `tunnel_${"a".repeat(32)}`, href: "/plugins/exact-fixture" };
  const f = fixture({ memberUnavailable: true, bindings: { "persist:admin": publisher,
    "persist:member": { ...publisher, userId: "user-member", publisherPartition: "persist:admin", publisherUserId: "user-admin" } } });
  await assert.rejects(f.run(), error => error.message === PUBLISH_REQUIRED);
});

test("manual mode rejects automatic workspace setup before opening a popup", async () => {
  const { createWorkspaceConnector } = require("../electron/chatgpt-workspace.cjs");
  let windows = 0;
  await assert.rejects(createWorkspaceConnector({ accountCandidates: async () => [], target: { partition: "persist:member" },
    BrowserWindow: () => { windows++; }, browserHost: {}, runtimeHost: { runtimeConfigSnapshot: () => ({ configured: true, owner: "launcher",
      config: { mode: "full", browserInteractionMode: "manual" } }) } }), /Zero Risk/);
  assert.equal(windows, 0);
  await assert.rejects(createWorkspaceConnector({ accountCandidates: async () => [], target: { partition: "persist:member", tunnelId: `tunnel_${"a".repeat(32)}` },
    BrowserWindow: () => { windows++; }, browserHost: { interactionModeOverride: "manual" }, runtimeHost: { runtimeConfigSnapshot: () => ({ configured: true, owner: "launcher",
      config: { mode: "full", browserInteractionMode: "automatic" } }) } }), /Zero Risk/);
  assert.equal(windows, 0, "an assigned extra tunnel cannot bypass manual mode");
});

test("plan inspection IPC rejects Zero Risk and targets an inactive account without switching", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const snippet = source.slice(source.indexOf('  handle("launcher:browser-account-inspect"'), source.indexOf('  // Codex threads bound'));
  let handler, mode = "manual", inspected = 0;
  const seen = [];
  const context = { Error, handle: (_name, fn) => { handler = fn; }, assertFocusedMainWindow() {},
    browserHost: {}, stateStore: { read: () => ({ browserInteractionMode: mode }) }, quitting: false, shutdownInProgress: false,
    browserAccounts: { activeId: () => "main", partitionOf: id => `persist:${id}` },
    session: { fromPartition: () => ({ cookies: { get: async () => [] } }) }, signedInFromCookies: () => true,
    routeIdleAccountPartition: async partition => seen.push(partition), logger: {}, BrowserWindow: {},
    inspectChatGptAccount: async options => { inspected++; seen.push(options.partition); options.assertCurrent(); return { planType: "team" }; },
    recordBrowserWorkspaceContext: partition => seen.push(partition), browserAccountsStatus: () => ({ activeId: "main" }),
  };
  vm.runInNewContext(snippet, context);
  await assert.rejects(handler({}), /Zero Risk/);
  assert.equal(inspected, 0);
  mode = "automatic";
  assert.equal((await handler({}, "other")).activeId, "main");
  assert.deepEqual(seen, ["persist:other", "persist:other", "persist:other"]);
});

test("revoked admin authority cannot publish or consent for the member", async () => {
  const f = fixture({ revokeAdmin: true });
  await assert.rejects(f.run(), /context changed/i);
  assert.equal(f.calls.some(call => ["publish", "connect-member"].includes(call[0])), false);
  assert(f.windows.every(window => window.isDestroyed()));
});

test("creation or publishing is never mistaken for member connection", async () => {
  const f = fixture({ noPublishControl: true, memberUnavailable: true });
  await assert.rejects(f.run(), error => error.message === PUBLISH_REQUIRED);
  assert(f.calls.some(call => call[0] === "create"));
  assert(f.windows.every(window => window.isDestroyed()));
  const denied = fixture({ serverDenied: true });
  await assert.rejects(denied.run(), /MCP server denied access/);
  assert.equal(denied.calls.some(call => call[0] === "publish"), false);
});

test("plan labels use subscription metadata while model access remains a separate detail", () => {
  const ts = require("typescript");
  const source = fs.readFileSync(path.join(__dirname, "../src/features/ChatGptBrowserManagement.tsx"), "utf8");
  const code = source.slice(source.indexOf("function planText("), source.indexOf("const TUNNEL_TONE"));
  const format = vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + ";planText;", { ago: () => "just now" });
  const metadata = { planCheckedAt: 123, workspaceRole: "account-admin", workspaceStructure: "workspace", workspaceName: "Workspace" };
  for (const [type, label] of [["team", "Business (Team)"], ["pro", "Pro"], ["plus", "Plus"], ["free", "Free"], ["future-plan", "Unknown plan"]]) {
    const result = format({ ...metadata, planType: type, solAvailable: true, proAvailable: true, checkedAt: 123 }, true);
    assert.equal(result.label, label);
    assert.match(result.detail, /Admin/);
    assert.match(result.detail, /Model access/);
  }
  assert.equal(format({ solAvailable: true, proAvailable: true, checkedAt: 123 }, true).label, "Not verified");
  assert.equal(format({ ...metadata, planType: "team" }, false).label, "Last known Business (Team)");
});

test("connection scope rejects known identity changes without racing a delayed metadata event", () => {
  const ts = require("typescript");
  const source = fs.readFileSync(path.join(__dirname, "../src/features/ChatGptBrowserManagement.tsx"), "utf8");
  const code = source.slice(source.indexOf("function connectionMatchesAccount("), source.indexOf("export interface BridgeSetup"));
  const matches = vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + ";connectionMatchesAccount;");
  const connection = { email: "member@example.com", userId: "user-member", workspaceId };
  assert.equal(matches(connection, { email: connection.email, plan: null }), true, "a verified reply can precede its metadata event");
  assert.equal(matches(connection, { email: connection.email, plan: { userId: connection.userId, workspaceId } }), true);
  assert.equal(matches(connection, { email: connection.email, plan: { userId: "user-other", workspaceId } }), false);
  assert.equal(matches(connection, { email: connection.email, plan: { userId: connection.userId, workspaceId: otherWorkspace } }), false);
  assert.equal(matches(connection, { email: "other@example.com", plan: null }), false);
});
