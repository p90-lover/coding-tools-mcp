"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function fixture(createConnector = async () => ({ created: true, connected: true }), { threads = [] } = {}) {
  const accounts = ["main", "second", "third"].map(id => ({ id, label: id, email: `${id}@example.test`,
    proxyProfileId: null, maxTabs: 3, acceptsNewSessions: true,
    plan: { userId: `user-${id}`, workspaceId: `workspace-${id}`, workspaceRole: "account-owner", workspaceStructure: "workspace", planCheckedAt: Date.now() },
    connector: null, signedIn: true }));
  const status = { accounts, activeId: "main", switching: false, maxAccounts: 10, maxTabsPerAccount: 15,
    settings: { newSessions: "active", keepFinishedTabsMinutes: 5 } };
  const calls = { connector: [], switches: [], removed: [], browserOpened: 0, errors: [] };
  const api = { browserAccounts: async () => status, mcpTunnels: async () => [],
    createMcpConnector: async id => { calls.connector.push(id); return createConnector(id); },
    switchBrowserAccount: async id => { calls.switches.push(id); },
    removeBrowserAccounts: async ids => { calls.removed.push(ids); return { ...status, removed: ids, failed: [] }; } };
  const instances = new Map();
  let current;
  const react = {
    useState(initial) {
      const owner = current, index = owner.cursor++;
      if (!(index in owner.values)) owner.values[index] = typeof initial === "function" ? initial() : initial;
      return [owner.values[index], value => { owner.values[index] = typeof value === "function" ? value(owner.values[index]) : value; }];
    },
    useRef(value) { return react.useState({ current: value })[0]; },
    useCallback: fn => fn, useMemo: fn => fn(), useEffect() {},
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/features/ChatGptBrowserManagement.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, { exports, console, window: { setTimeout: () => 1, clearTimeout() {} },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name.endsWith(".css")) return {};
      throw new Error(`Unexpected UI import: ${name}`);
    },
  });
  function render(type, props, key) {
    if (!instances.has(key)) instances.set(key, { cursor: 0, values: key === "management" ? [status, null, threads] : [] });
    current = instances.get(key); current.cursor = 0;
    return type(props);
  }
  const props = { api, browser: { authenticated: true, status: "ready", tabs: [] },
    setup: { mcpReady: true, bridgeReady: true }, setError: error => calls.errors.push(error),
    onOpenBrowser: () => { calls.browserOpened++; } };
  const page = () => render(exports.ChatGptBrowserManagement, props, "management");
  const cardNode = id => nodes(page()).find(node => node.type?.name === "AccountCard" && node.props.account.id === id);
  const card = id => { const node = cardNode(id); assert(node); return render(node.type, node.props, id); };
  return { accounts, calls, api, props, status, page, cardNode, card, render, flush: () => new Promise(resolve => setImmediate(resolve)) };
}

function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  return [value, ...nodes(value.props?.children)];
}
function text(value) {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value == null || typeof value === "boolean") return "";
  return typeof value === "object" ? text(value.props?.children) : String(value);
}
function button(tree, label) {
  const found = nodes(tree).find(node => node.type === "button" && text(node) === label);
  assert(found, `Missing button: ${label}`);
  return found;
}

test("team role access separates existing connector validation from owner creation", async () => {
  for (const [role, label] of [["account-admin", "Admin"], ["standard-user", "Member"]]) {
    const ui = fixture();
    for (const account of ui.accounts) account.plan.workspaceRole = role;
    const card = ui.card("second");
    const connect = button(card, "Connect MCP");
    assert.equal(connect.props.disabled, false, "a fresh member may ask the backend to verify an existing workspace connector");
    assert.match(text(card), new RegExp(`Role${label}`));
    assert.match(text(card), /MCP accessUse existing only/);
    assert.match(connect.props.title, /existing.*owner/i);
    connect.props.onClick();
    await ui.flush();
    assert.deepEqual(ui.calls.connector, ["second"]);
  }
});

test("fresh active-page authentication is honored by both single and bulk MCP handlers", async () => {
  for (const signedIn of [null, false]) for (const bulk of [false, true]) {
    const ui = fixture();
    ui.accounts[0].signedIn = signedIn;
    assert.equal(button(ui.card("main"), "Connect MCP").props.disabled, false);
    button(bulk ? ui.page() : ui.card("main"), bulk ? "Connect all accounts" : "Connect MCP").props.onClick();
    await ui.flush();
    assert.equal(ui.calls.connector[0], "main", "the enabled active account must not be silently skipped");
  }
});

test("an account MCP button sends its exact ID and does not retain another sign-in's result", async () => {
  const ui = fixture();
  button(ui.card("second"), "Connect MCP").props.onClick();
  await ui.flush();
  assert.deepEqual(ui.calls.connector, ["second"]);
  assert.deepEqual(ui.calls.switches, [], "account setup must not switch the global browser");
  assert(button(ui.card("second"), "Check connection"));
  ui.accounts[1].connector = { okAt: null, error: "A newer connector check failed", errorAt: Date.now() + 1000 };
  assert(text(ui.card("second")).includes("A newer connector check failed"));
  assert(button(ui.card("second"), "Connect MCP"), "a newer observation supersedes the local success");
  ui.accounts[1].connector = null;
  ui.accounts[1].email = "different@example.test";
  assert(button(ui.card("second"), "Connect MCP"), "a different identity must be checked again");
  ui.accounts[1].signedIn = false;
  assert.equal(button(ui.card("second"), "Connect MCP").props.disabled, true);
});

test("bulk MCP setup is sequential, continues after failure, and requires connected true", async () => {
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const ui = fixture(async id => {
    if (id === "main") return first;
    if (id === "second") throw new Error("Setup denied");
    return { created: true };
  });
  const connectAll = button(ui.page(), "Connect all accounts");
  connectAll.props.onClick();
  connectAll.props.onClick(); // A queued second click cannot start a concurrent setup.
  await Promise.resolve();
  assert.deepEqual(ui.calls.connector, ["main"]);
  assert.equal(button(ui.page(), "Connecting accounts…").props.disabled, true);
  const card = ui.cardNode("second");
  assert.equal(card.props.removing, true, "deletion waits while connector setup owns the account session");
  assert.equal(card.props.switching, true, "switching waits during connector setup");
  assert.equal(nodes(ui.card("second")).find(node => node.props.role === "radio").props.disabled, false,
    "unrelated per-account controls keep their existing busy behavior");
  release({ created: true, connected: true });
  await ui.flush();
  assert.deepEqual(ui.calls.connector, ["main", "second", "third"]);
  assert(text(ui.page()).includes("1 of 3 accounts connected"));
  assert(text(ui.card("second")).includes("Setup denied"));
  assert(text(ui.card("third")).includes("ChatGPT did not confirm this account's connector connection."));
  assert(button(ui.card("third"), "Connect MCP"));
});

test("account setup preserves bulk removal, the tabs drawer, and opening the Browser tab", async () => {
  const ui = fixture();
  ui.cardNode("second").props.onSelect(true);
  let bulk = nodes(ui.page()).find(node => node.type?.name === "BulkRemoveBar");
  assert.deepEqual(Array.from(bulk.props.ticked), ["second"]);
  bulk.props.onRemove();
  await ui.flush();
  assert.deepEqual(ui.calls.removed.map(ids => Array.from(ids)), [["second"]]);
  bulk = nodes(ui.page()).find(node => node.type?.name === "BulkRemoveBar");
  assert.equal(bulk.props.ticked.length, 0);
  const toggle = nodes(ui.card("second")).find(node => node.props["aria-controls"] === "cbm-tabs-second");
  toggle.props.onClick();
  assert.equal(nodes(ui.card("second")).find(node => node.type?.name === "AccountTabs").props.open, true);
  button(ui.card("second"), "Use in Browser tab").props.onClick();
  await ui.flush();
  assert.deepEqual(ui.calls.switches, ["second"]);
  assert.equal(ui.calls.browserOpened, 1);
});

test("management keeps partition sign-in evidence when the shown page has no authentication result", () => {
  const ui = fixture();
  ui.props.browser.authenticated = false;
  assert(text(ui.card("main")).includes("Signed in"));
  assert.equal(button(ui.card("main"), "Connect MCP").props.disabled, false);
  ui.accounts[0].signedIn = null;
  assert(text(ui.card("main")).includes("Checking…"), "unknown is not signed out");
});

test("an active owner's idle or loading page preserves signed-in account proof when connecting MCP", async () => {
  for (const authenticated of [false, null, undefined]) {
    const ui = fixture();
    ui.props.browser.authenticated = authenticated;
    const connect = button(ui.card("main"), "Connect MCP");
    assert.equal(connect.props.disabled, false);
    connect.props.onClick();
    await ui.flush();
    assert.deepEqual(ui.calls.connector, ["main"], "the enabled button must use the same partition proof as its handler");
    assert.deepEqual(ui.calls.switches, []);
    assert(button(ui.card("main"), "Check connection"));
  }
});

test("a member can connect through its signed-in active owner while that owner's page is idle", async () => {
  const ui = fixture();
  const [owner, member] = ui.accounts;
  ui.props.browser.authenticated = false;
  member.plan.workspaceId = owner.plan.workspaceId;
  member.plan.workspaceRole = "standard-user";
  const connect = button(ui.card(member.id), "Connect MCP");
  assert.equal(connect.props.disabled, false);
  connect.props.onClick();
  await ui.flush();
  assert.deepEqual(ui.calls.connector, [member.id], "owner eligibility cannot disappear when the handler maps the active account");
  assert.deepEqual(ui.calls.switches, []);
});

test("tabs without an explicit account use their native thread's owner, not the account shown", () => {
  const ui = fixture(undefined, { threads: [{ threadId: "native-thread", accountId: "second", running: true }] });
  ui.props.browser.tabs = [{ id: "turn-tab", threadId: "native-thread", title: "Task", status: "running", otherAccount: true },
    { id: "unknown-tab", title: "Unknown owner", status: "running", otherAccount: true }];
  assert.equal(ui.cardNode("main").props.tabs.length, 0, "other-account tabs cannot be assigned to main");
  assert.equal(ui.cardNode("second").props.tabs.length, 1, "the known thread determines the owner");
});

test("MCP setup waits only for that account's in-flight removal", async () => {
  let finishRemoval;
  const removing = new Promise(resolve => { finishRemoval = resolve; });
  const ui = fixture();
  ui.api.removeBrowserAccount = async id => { ui.calls.removed.push([id]); return removing; };
  button(ui.card("second"), "Remove").props.onClick();
  button(ui.card("second"), "Click again to remove").props.onClick();
  assert.deepEqual(ui.calls.removed.map(ids => Array.from(ids)), [["second"]]);
  assert.equal(button(ui.card("second"), "Connect MCP").props.disabled, true);
  assert.equal(button(ui.card("third"), "Connect MCP").props.disabled, false);
  assert.deepEqual(ui.calls.connector, []);
  finishRemoval();
  await ui.flush();
  assert.equal(button(ui.card("second"), "Connect MCP").props.disabled, false);
});

for (const role of ["owner", "constructor", "toString", "__proto__", undefined]) {
  test(`MCP setup is blocked without a verified workspace role: ${role}`, async () => {
    const ui = fixture();
    for (const account of ui.accounts) account.plan.workspaceRole = role;
    const connect = button(ui.card("second"), "Connect MCP");
    assert.equal(connect.props.disabled, true);
    assert.match(connect.props.title, /owner|verify/i);
    assert.match(text(ui.card("second")), /RoleNot verified/);
    assert.match(text(ui.card("second")), /Refresh required/);
    assert.equal(button(ui.page(), "Connect all accounts").props.disabled, true);
    // The handler also refuses a queued click whose permissions have since changed.
    connect.props.onClick();
    await ui.flush();
    assert.deepEqual(ui.calls.connector, []);
  });
}

test("unknown and stale workspace metadata cannot enable MCP creation", async () => {
  const ui = fixture();
  ui.accounts[0].plan = null;
  ui.accounts[1].plan.planCheckedAt = Date.now() - 300001;
  ui.accounts[2].plan.workspaceStructure = undefined;
  assert.equal(button(ui.page(), "Connect all accounts").props.disabled, true);
  for (const account of ui.accounts) assert.equal(button(ui.card(account.id), "Connect MCP").props.disabled, true);
  button(ui.page(), "Connect all accounts").props.onClick();
  await ui.flush();
  assert.deepEqual(ui.calls.connector, []);
  assert.match(text(ui.page()), /3 skipped/);
});

test("a known role is last-known after sign-out, stale inspection, or a future timestamp", () => {
  for (const state of ["signed-out", "stale", "future", "identity-missing"]) {
    const ui = fixture();
    const account = ui.accounts[1];
    if (state === "signed-out") account.signedIn = false;
    if (state === "stale") account.plan.planCheckedAt = Date.now() - 300001;
    if (state === "future") account.plan.planCheckedAt = Date.now() + 60000;
    if (state === "identity-missing") account.plan.userId = null;
    const card = ui.card(account.id);
    assert.match(text(card), /RoleLast known Owner/);
    assert.match(text(card), /MCP accessRefresh required/);
    assert.equal(button(card, "Connect MCP").props.disabled, true);
  }
});

test("only an exact-workspace fresh signed-in owner is offered for creation after member reuse", () => {
  const ui = fixture();
  const [, member, owner] = ui.accounts;
  member.plan.workspaceRole = "standard-user";
  assert.equal(button(ui.card(member.id), "Connect MCP").props.disabled, false, "existing connector validation needs no owner candidate");
  assert.doesNotMatch(button(ui.card(member.id), "Connect MCP").props.title, /signed-in owner/i);
  owner.plan.workspaceId = member.plan.workspaceId;
  assert.equal(button(ui.card(member.id), "Connect MCP").props.disabled, false);
  assert.match(button(ui.card(member.id), "Connect MCP").props.title, /owner.*create and publish/i);
  owner.signedIn = false;
  assert.doesNotMatch(button(ui.card(member.id), "Connect MCP").props.title, /signed-in owner/i);
  owner.signedIn = true;
  owner.plan.planCheckedAt = Date.now() - 300001;
  assert.doesNotMatch(button(ui.card(member.id), "Connect MCP").props.title, /signed-in owner/i);
});

test("losing creation authority does not relabel an already confirmed connection as failed", async () => {
  const ui = fixture();
  button(ui.card("second"), "Connect MCP").props.onClick();
  await ui.flush();
  ui.accounts[1].plan.workspaceRole = "standard-user";
  const card = ui.card("second");
  assert.match(text(card), /Connected/);
  assert.equal(button(card, "Check connection").props.disabled, false, "a member can validate the existing connector without creation authority");
  assert.match(text(card), /MCP accessUse existing only/);
});

test("a saved successful connection survives reopening the page without creation authority", () => {
  const ui = fixture();
  ui.accounts[1].connector = { okAt: Date.now() - 1000 };
  ui.accounts[1].plan.workspaceRole = "standard-user";
  const card = ui.card("second");
  assert.match(text(card), /Previously connected/);
  assert.doesNotMatch(text(card), /Owner required/);
  assert.equal(button(card, "Connect MCP").props.disabled, false, "the backend must freshly verify identity before reusing the connector");
  assert.deepEqual(ui.calls.connector, [], "the saved status requires no creation attempt");
});

test("bulk owner setup preserves a saved sign-in while the active page is idle", async () => {
  const ui = fixture();
  ui.props.browser.authenticated = false;
  ui.props.browser.status = "idle";
  button(ui.page(), "Connect all accounts").props.onClick();
  await ui.flush();
  assert.deepEqual(ui.calls.connector, ["main", "second", "third"], "the idle active page does not erase its partition's verified sign-in");
});

test("bulk setup includes fresh existing-connector checks and skips unverified accounts", async () => {
  const ui = fixture();
  ui.accounts[1].plan.workspaceRole = "account-admin";
  ui.accounts[2].plan = null;
  button(ui.page(), "Connect all accounts").props.onClick();
  await ui.flush();
  assert.deepEqual(ui.calls.connector, ["main", "second"]);
  assert.match(text(ui.page()), /1 skipped/);
});
