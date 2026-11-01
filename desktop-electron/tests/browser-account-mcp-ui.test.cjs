"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function fixture(createConnector = async () => ({ created: true, connected: true })) {
  const accounts = ["main", "second", "third"].map(id => ({ id, label: id, email: `${id}@example.test`,
    proxyProfileId: null, maxTabs: 3, acceptsNewSessions: true, plan: null, connector: null, signedIn: true }));
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
    if (!instances.has(key)) instances.set(key, { cursor: 0, values: key === "management" ? [status] : [] });
    current = instances.get(key); current.cursor = 0;
    return type(props);
  }
  const props = { api, browser: { authenticated: true, status: "ready", tabs: [] },
    setup: { mcpReady: true, bridgeReady: true }, setError: error => calls.errors.push(error),
    onOpenBrowser: () => { calls.browserOpened++; } };
  const page = () => render(exports.ChatGptBrowserManagement, props, "management");
  const cardNode = id => nodes(page()).find(node => node.type?.name === "AccountCard" && node.props.account.id === id);
  const card = id => { const node = cardNode(id); assert(node); return render(node.type, node.props, id); };
  return { accounts, calls, api, page, cardNode, card, render, flush: () => new Promise(resolve => setImmediate(resolve)) };
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
