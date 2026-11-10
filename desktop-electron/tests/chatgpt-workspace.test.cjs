"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const setup = require("../electron/mcp-connector-setup.cjs");
const { mcpConnectorCommandFailure } = require("../electron/mcp-connector-command.cjs");
const { ADMIN_REQUIRED, PUBLISH_REQUIRED, isWorkspaceAdmin } = require("../electron/chatgpt-workspace.cjs");
const cloudflareCheck = require("../electron/chatgpt-cloudflare-check.cjs");
// The vm-loaded workspace module gets the real Cloudflare check helper and the test's setup stub.
const workspaceRequire = setupModule => name => {
  if (name === "./chatgpt-cloudflare-check.cjs") return cloudflareCheck;
  assert.equal(name, "./mcp-connector-setup.cjs");
  return setupModule;
};
const workspaceId = "602b5d8d-e211-49b1-9762-206108d52954";
const otherWorkspace = "6d4774fd-0e67-4b5b-a3b7-4c0e61357122";

test("an inspection timeout preserves its actionable error after the native window is destroyed", async () => {
  let expire, destroyed = false, disposed = 0;
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  class Window {
    get webContents() {
      if (destroyed) throw new TypeError("Object has been destroyed");
      return contents;
    }
    isDestroyed() { return destroyed; }
    destroy() { destroyed = true; }
    async loadURL(url) { if (url === "about:blank") return; expire(); throw new Error("Navigation cancelled"); }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../electron/chatgpt-workspace.cjs"), "utf8"), {
    module, URL, Date, clearTimeout() {},
    setTimeout(callback) { expire = callback; return { unref() {} }; },
    require: workspaceRequire({ observeMcpSetupContext: async () => ({ dispose() { disposed++; } }) }),
  });
  await assert.rejects(module.exports.inspectChatGptAccount({ BrowserWindow: Window, partition: "persist:member" }),
    /ChatGPT workspace inspection timed out\. Retry this account's action\./);
  assert.equal(disposed, 1);
});

test("a Refresh waits through Cloudflare's check: its reload is no context change, and its time is added", async () => {
  // Live 2026-11-09: /plugins answered 403 with Cloudflare's check; the inspection gave up first.
  const delays = [], agents = [];
  let pageLoaded = false;
  class Window {
    constructor(config) {
      assert.equal(config.show, false);
      const contents = this.webContents = new EventEmitter();
      contents.setWindowOpenHandler = () => {};
      contents.getUserAgent = () => "Mozilla/5.0 (Windows NT 10.0) Chrome/156.0 CodingTools/0.8.102 Electron/45.2.2 Safari/537.36";
      contents.setUserAgent = value => agents.push(value);
      contents.executeJavaScript = async script => {
        if (script.startsWith("(function isCloudflareCheckPage")) {
          // The check passes a moment later and reloads the page itself.
          setImmediate(() => {
            contents.emit("did-start-navigation", {}, "https://chatgpt.com/plugins?view=personal", false, true);
            contents.emit("did-navigate", {}, "https://chatgpt.com/plugins?view=personal", 200);
            pageLoaded = true;
            contents.emit("did-finish-load");
          });
          return true;
        }
        const id = script.match(/activeAccountId: "([a-f0-9-]+)"/)?.[1];
        assert.equal(id, workspaceId);
        return setup.chatGptMcpContext({ user: { id: "user-member" }, auth: { chatgpt_user_id: "user-member" }, activeAccountId: id,
          accounts: { [id]: { can_access_with_session: true, account: { account_id: id, account_user_role: "standard-user",
            structure: "workspace", is_deactivated: false, plan_type: "team", name: "Target workspace" } } } });
      };
      this.destroyed = false;
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    async loadURL(url) {
      if (url === "about:blank") return;
      this.webContents.emit("did-start-navigation", {}, url, false, true);
      this.webContents.emit("did-navigate", {}, url, 403);
      this.webContents.emit("did-finish-load");
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../electron/chatgpt-workspace.cjs"), "utf8"), {
    module, URL, Date, clearTimeout,
    setTimeout: (callback, ms) => { delays.push(ms); return setTimeout(callback, ms); },
    require: workspaceRequire({ ...setup, observeMcpSetupContext: async () => ({ dispose() {}, snapshot: () => ({
      activeAccountId: null, selectionVersion: 1, navigationVersion: pageLoaded ? 2 : 1,
      navigationAccountId: pageLoaded ? workspaceId : null, error: null }) }) }),
  });
  const context = await module.exports.inspectChatGptAccount({ BrowserWindow: Window, partition: "persist:member", metadataOnly: true });
  assert.equal(context.workspaceId, workspaceId);
  assert.deepEqual(delays.filter(ms => ms >= 30_000), [60_000, 120_000], "a 60 s Refresh gets the check's 60 s on top");
  assert.deepEqual(agents, ["Mozilla/5.0 (Windows NT 10.0) Chrome/156.0 Safari/537.36"], "the window speaks as the Browser tab does");
});

function fixture(options = {}) {
  const profiles = {
    "persist:member": { userId: "user-member", activeId: workspaceId, memberships: { [workspaceId]: "standard-user" } },
    "persist:admin": { userId: "user-admin", activeId: workspaceId, memberships: { [workspaceId]: "account-admin" } },
    "persist:owner": { userId: "user-owner", activeId: workspaceId, memberships: { [workspaceId]: "account-owner" } },
  };
  const calls = [], windows = [], contexts = [];
  let removed = false, freshPublisher = null;
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
      destroy: () => { state.destroyed = true; }, loadURL: async url => {
        if (url === "about:blank") { contents.rendererInitialized = true; return; }
        contents.emit("did-start-navigation", {}, url, false, true);
        if (options.redirect) {
          const destination = "https://frame.invalid/redirect", mainFrame = options.redirect === "unknown" ? undefined : options.redirect === "main";
          const event = { preventDefault() { calls.push(["blocked-redirect", partition]); }, ...(options.details ? { url: destination, isMainFrame: mainFrame } : {}) };
          contents.emit("will-redirect", event, options.details ? undefined : destination, false, options.details ? undefined : mainFrame);
        }
      } };
    windows.push(window);
    return window;
  }
  const dependency = { ...setup,
    currentConnectorSettings: () => ({ name: "Coding Tools", tunnelId: `tunnel_${"a".repeat(32)}` }),
    requireAutomaticConnectorSetup() {},
    readAccountConnectorBindings: () => ({ version: 1, bindings: options.bindings || {}, scopedBindings: options.scopedBindings }),
    observeMcpSetupContext: async (contents, tunnelId) => {
      assert.equal(contents.rendererInitialized, true, "initialize a renderer before awaiting network monitoring");
      assert.equal(tunnelId, null, "plan/role inspection never requires Platform login");
      return { snapshot: () => {
        if (options.filterNavigation && !contents.filterChanged) {
          contents.filterChanged = true;
          contents.emit("did-start-navigation", {}, "https://chatgpt.com/plugins?directoryTab=personal", true, true);
        }
        return { activeAccountId: options.navigationOnly ? null : contents.state.activeId, selectionVersion: contents.state.version,
          navigationAccountId: contents.state.activeId, navigationVersion: contents.state.version };
      }, dispose() {} };
    },
    createConfiguredConnector: async input => {
      assert.equal(input.operationHeld, true, "one outer operation owns both accounts");
      input.assertCurrent?.();
      const partition = input.target.partition, profile = profiles[partition];
      assert.equal(input.expectedContext.userId, profile.userId);
      assert.equal(input.expectedContext.workspaceId, workspaceId);
      if (input.existingOnly) {
        calls.push(["inspect-existing", partition]);
        if (options.reuseError) throw Object.assign(new Error(options.reuseError), { mcpMutationStarted: options.reuseMutation });
        if (!options.existingVerified) throw Object.assign(new Error(setup.UNVERIFIED_CONNECTOR), { mcpMutationStarted: false });
        return { created: false, name: "Coding Tools", href: "/plugins/exact-fixture", connected: true,
          binding: { userId: profile.userId, workspaceId, tunnelId: `tunnel_${"a".repeat(32)}` } };
      }
      if (partition === "persist:member" && !input.shared && !options.memberCanCreate) throw new Error("ChatGPT did not open its connector form.");
      if (partition === "persist:owner" && options.wrongTunnelOwner) {
        throw Object.assign(new Error("The selected tunnel belongs to a different Platform user. Choose a tunnel created by the signed-in account."), { mcpMutationStarted: false });
      }
      if (partition !== "persist:member" && options.serverDenied) throw new Error("The MCP server denied access.");
      calls.push([input.shared ? "connect-member" : "create", partition]);
      if (input.shared) {
        assert.equal(input.shared.creationResult, freshPublisher, "member setup receives the original fresh publisher result, not a cached binding");
        assert.equal(input.shared.workspaceId, workspaceId);
        assert.equal(input.shared.memberUserId, "user-member");
        assert.notEqual(input.shared.userId, "user-member");
        if (options.memberUnavailable) throw Object.assign(new Error("ChatGPT did not finish loading this plugin connection."), { mcpMutationStarted: false });
      }
      const result = { created: !input.shared, name: "Coding Tools", href: "/plugins/exact-fixture", connected: true,
        binding: { userId: profile.userId, workspaceId, tunnelId: `tunnel_${"a".repeat(32)}` } };
      if (!input.shared && partition !== "persist:member") freshPublisher = result;
      return result;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../electron/chatgpt-workspace.cjs"), "utf8"), {
    module, require: workspaceRequire(dependency),
    URL, Date, setTimeout, clearTimeout,
  });
  const candidates = ["admin", ...(options.owner ? ["owner"] : [])].map(id => ({ id, partition: `persist:${id}`,
    prepare: async () => { calls.push(["route", id]); }, assertCurrent: () => { if (removed) throw new Error("Account removed"); } }));
  let busy = false, locks = 0;
  const input = { BrowserWindow: Window, browserHost: { withManualOperation: async (_name, action) => {
    assert.equal(busy, false); busy = true; locks++; try { return await action(); } finally { busy = false; }
  }, currentOperation: () => busy ? "MCP connector creation" : null }, target: { partition: "persist:member" }, assertCurrent() {},
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

test("a member or admin uses fresh exact existing connector identity before looking for an owner", async () => {
  for (const role of ["standard-user", "account-admin"]) {
    const f = fixture({ existingVerified: true });
    f.profiles["persist:member"].memberships[workspaceId] = role;
    f.input.accountCandidates = async () => { throw new Error("An existing verified connector must not seek owner authority"); };
    const result = await f.run();
    assert.equal(result.connected, true);
    assert.equal(result.created, false);
    assert.deepEqual(f.calls, [["inspect-existing", "persist:member"]]);
    assert(f.windows.every(window => window.isDestroyed()));
  }
});

test("consent, uncertain mutation, and changed context failures cannot fall back to owner creation", async () => {
  for (const [message, mutation] of [[setup.UNVERIFIED_CONNECTOR, true], [setup.UNVERIFIED_CONNECTOR, undefined], ["Workspace context changed", false]]) {
    const f = fixture({ owner: true, reuseError: message, reuseMutation: mutation });
    await assert.rejects(f.run(), error => error.message === message);
    assert.deepEqual(f.calls, [["inspect-existing", "persist:member"]]);
  }
});

test("same-page directory filters keep the verified workspace inspection usable", async () => {
  const f = fixture({ owner: true, filterNavigation: true });
  const result = await f.run();
  assert.equal(result.connected, true);
});

test("workspace inspection ignores only explicitly identified iframe redirects", async t => {
  for (const details of [false, true]) for (const redirect of ["iframe", "main", "unknown"]) await t.test(`${details ? "details" : "legacy"} ${redirect}`, async () => {
    const f = fixture({ redirect, details });
    const action = () => f.inspectChatGptAccount({ ...f.input, partition: "persist:member", metadataOnly: true });
    if (redirect === "iframe") assert.equal((await action()).workspaceId, workspaceId);
    else await assert.rejects(action(), /context changed/i);
    assert.equal(f.calls.filter(call => call[0] === "blocked-redirect").length, redirect === "iframe" ? 0 : 1);
    assert(f.windows.every(window => window.isDestroyed()));
  });
});

test("subscription inspection can use normal account navigation without lending it MCP authority", async () => {
  const f = fixture({ navigationOnly: true });
  const input = { ...f.input, partition: "persist:member", metadataOnly: true };
  const context = await f.inspectChatGptAccount(input);
  assert.equal(context.workspaceId, workspaceId);
  assert.equal(context.planType, "team");
  await assert.rejects(f.inspectChatGptAccount(input, () => {}), /Subscription inspection cannot perform MCP actions/);
  assert.equal(f.calls.some(call => call[0] === "publish" || call[0] === "create"), false);
});

test("an owner in another selected workspace is selected and verified by exact workspace id", async () => {
  const f = fixture({ owner: true });
  f.profiles["persist:owner"].activeId = otherWorkspace;
  f.profiles["persist:owner"].memberships[otherWorkspace] = "standard-user";
  assert.equal((await f.run()).setupAccountId, "owner");
  assert(f.calls.some(call => call[0] === "select"));
  assert(f.windows.every(window => window.isDestroyed()));
});

test("another workspace's owner and another partition of the same member cannot lend authority", async t => {
  for (const kind of ["unrelated", "same-user", "role-revoked"]) await t.test(kind, async () => {
    const f = fixture({ owner: true });
    if (kind === "unrelated") {
      f.profiles["persist:owner"].activeId = otherWorkspace;
      f.profiles["persist:owner"].memberships = { [otherWorkspace]: "account-owner" };
    } else if (kind === "same-user") f.profiles["persist:owner"].userId = "user-member";
    else f.profiles["persist:owner"].memberships[workspaceId] = "standard-user";
    await assert.rejects(f.run(), error => error.message.endsWith(ADMIN_REQUIRED));
    assert.equal(f.calls.some(call => ["create", "publish", "connect-member"].includes(call[0])), false);
    assert(f.windows.every(window => window.isDestroyed()));
  });
});

test("a delegated member cannot create even when ChatGPT exposes an Add control", async () => {
  const f = fixture({ memberCanCreate: true });
  await assert.rejects(f.run(), error => error.message.endsWith(ADMIN_REQUIRED));
  assert.equal(f.calls.some(call => ["create", "publish", "connect-member"].includes(call[0])), false);
});

test("a delegated member uses the verified workspace owner instead of creating itself", async () => {
  const f = fixture({ memberCanCreate: true, owner: true });
  assert.equal((await f.run()).connected, true);
  assert.deepEqual(f.calls.filter(call => call[0] === "create"), [["create", "persist:owner"]]);
  assert.equal(f.calls.some(call => call[0] === "publish"), true);
});

test("a tunnel-ineligible owner cannot fall back to a workspace admin", async () => {
  const f = fixture({ owner: true, wrongTunnelOwner: true });
  await assert.rejects(f.run(), /different Platform user/);
  assert.deepEqual(f.calls.filter(call => call[0] === "create"), []);
});

test("cached shared provenance cannot reconnect without fresh publisher verification", async () => {
  const publisher = { userId: "user-admin", workspaceId, name: "Coding Tools", tunnelId: `tunnel_${"a".repeat(32)}`, href: "/plugins/exact-fixture" };
  const f = fixture({ bindings: { "persist:admin": publisher,
    "persist:member": { ...publisher, userId: "user-member", publisherPartition: "persist:admin", publisherUserId: "user-admin" } } });
  f.input.accountCandidates = async () => [];
  await assert.rejects(f.run(), error => {
    assert.equal(mcpConnectorCommandFailure(error).code, "workspace_owner_required",
      "the native caller must retain the actionable owner requirement");
    assert.equal(error.cause?.message, setup.UNVERIFIED_CONNECTOR);
    return error.message.endsWith(ADMIN_REQUIRED);
  });
  assert.deepEqual(f.calls.filter(call => call[0] === "connect-member"), []);
});

test("scoped cached hints still require a fresh publisher in the target workspace", async () => {
  const publisher = { userId: "user-admin", workspaceId, name: "Coding Tools", tunnelId: `tunnel_${"a".repeat(32)}`, href: "/plugins/exact-fixture" };
  const f = fixture({ owner: true, bindings: { "persist:admin": { ...publisher, workspaceId: otherWorkspace },
    "persist:member": { ...publisher, userId: "user-member", publisherPartition: "persist:admin", publisherUserId: "user-admin" } }, scopedBindings: {
    [JSON.stringify(["persist:admin", workspaceId, publisher.tunnelId, publisher.name])]: publisher,
  } });
  assert.equal((await f.run()).connected, true);
  assert(f.calls.some(call => call[0] === "create" && call[1] === "persist:owner"));
});

test("an unavailable cached shared plugin reports the publishing action instead of a loading error", async () => {
  const publisher = { userId: "user-admin", workspaceId, name: "Coding Tools", tunnelId: `tunnel_${"a".repeat(32)}`, href: "/plugins/exact-fixture" };
  const f = fixture({ owner: true, memberUnavailable: true, bindings: { "persist:admin": publisher,
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

test("revoked owner authority cannot publish or consent for the member", async () => {
  const f = fixture({ owner: true, revokeAdmin: true });
  await assert.rejects(f.run(), /context changed/i);
  assert.equal(f.calls.some(call => ["publish", "connect-member"].includes(call[0])), false);
  assert(f.windows.every(window => window.isDestroyed()));
});

test("creation or publishing is never mistaken for member connection", async () => {
  const f = fixture({ owner: true, noPublishControl: true, memberUnavailable: true });
  await assert.rejects(f.run(), error => error.message === PUBLISH_REQUIRED);
  assert(f.calls.some(call => call[0] === "create"));
  assert(f.windows.every(window => window.isDestroyed()));
  const denied = fixture({ owner: true, serverDenied: true });
  await assert.rejects(denied.run(), /MCP server denied access/);
  assert.equal(denied.calls.some(call => call[0] === "publish"), false);
});

test("plan labels use subscription metadata while model access remains a separate detail", () => {
  const ts = require("typescript");
  const source = fs.readFileSync(path.join(__dirname, "../src/features/ChatGptBrowserManagement.tsx"), "utf8");
  const code = source.slice(source.indexOf("const PLAN_LABELS"), source.indexOf("const TUNNEL_TONE"));
  const format = vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + ";planText;", { ago: () => "just now" });
  const metadata = { planCheckedAt: 123, workspaceRole: "account-admin", workspaceStructure: "workspace", workspaceName: "Team space" };
  for (const [type, label] of [["team", "Business"], ["pro", "Pro"], ["plus", "Plus"], ["free", "Free"], ["future-plan", null], ["toString", null]]) {
    const result = format({ ...metadata, planType: type, solAvailable: true, proAvailable: true, checkedAt: 123 });
    assert.equal(result.label, label, "an unknown plan shows no pill rather than a guess");
    assert.equal(result.workspace, "Team space · Admin · checked just now", "one line: workspace, role, when");
    assert.match(result.models, /Model access up to 6 Pro/, "model access stays out of the line, as the pill's tooltip");
  }
  assert.equal(format({ ...metadata, workspaceRole: "constructor", planType: "team" }).workspace, "Team space · checked just now");
  assert.equal(format({ ...metadata, workspaceStructure: "personal", planType: "plus" }).workspace, "Personal · Admin · checked just now");
  const unchecked = format({ solAvailable: true, proAvailable: true, checkedAt: 123 });
  assert.equal(unchecked.label, null);
  assert.equal(unchecked.workspace, "Not checked yet");
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
