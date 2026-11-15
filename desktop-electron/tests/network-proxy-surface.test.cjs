"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.resolve(__dirname, "../src/features/NetworkProxySurface.tsx"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function surface() {
  const profile = { id: "office", name: "Office proxy", enabled: true, endpoint: { protocol: "http", host: "proxy.example.test", port: 8080 }, scopes: ["all"], bypass: ["localhost"], hasAuthentication: true };
  const snapshot = { proxyProfiles: [profile], accounts: [{ id: "account", providerId: "codex-oauth", label: "Work" }], routing: { globalEnabled: true, globalProfileId: profile.id, providers: [{ providerId: "cpa", profileId: profile.id }], accounts: [{ accountId: "account", profileId: profile.id }] } };
  const states = [snapshot, null, null, new Set(), "", false];
  const saved = [];
  let cursor = 0;
  const exports = {};
  const api = {
    async saveProxyProfile(input) { saved.push(input); return snapshot; },
    async externalServicesSnapshot() { return { services: [] }; },
    async testProxyProfile() { return { snapshot }; },
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  vm.runInNewContext(compiled, {
    exports,
    require(id) {
      if (id === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (id === "react") return {
        useState(initial) { const index = cursor++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial; return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
        useRef: value => ({ current: value }),
        useMemo: fn => fn(),
        useEffect() {},
      };
      if (id === "./execution-surface-utils") return { localText: (_language, en) => en, messageOf: String };
      if (id.endsWith(".css")) return {};
      throw new Error(`Unexpected import: ${id}`);
    },
    window: { codexWebLauncher: api },
  });
  const render = () => { cursor = 0; return exports.NetworkProxySurface({ language: "en", setError: error => { if (error) throw new Error(error); } }); };
  const find = predicate => {
    const walk = node => {
      if (!node || typeof node !== "object") return undefined;
      if (Array.isArray(node)) return node.map(walk).find(Boolean);
      return predicate(node) ? node : walk(node.props?.children);
    };
    const result = walk(render());
    assert.ok(result, "expected control exists");
    return result;
  };
  const field = label => find(node => node.type === "input" && node.props["aria-label"] === label);
  const change = (label, value) => field(label).props.onChange({ target: { value } });
  return { profile, saved, find, field, change, async submit() { await find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve)); } };
}

function edit(view) {
  view.find(node => node.type === "button" && node.props["aria-label"] === "Edit").props.onClick();
}

test("editing a proxy loads and preserves its custom name without resending saved credentials", async () => {
  const view = surface();
  edit(view);
  assert.equal(view.field("Proxy name").props.value, "Office proxy");
  await view.submit();
  assert.equal(view.saved[0].name, "Office proxy");
  assert.equal(view.saved[0].endpoint.host, "proxy.example.test");
  assert.equal(view.saved[0].endpoint.port, 8080);
  assert.ok(!("username" in view.saved[0]));
  assert.ok(!("password" in view.saved[0]));
});

test("a custom name is trimmed, editable and bounded to the backend's length limit", async () => {
  const view = surface();
  edit(view);
  assert.equal(view.field("Proxy name").props.maxLength, 160);
  view.change("Proxy name", "  Regional office  ");
  await view.submit();
  assert.equal(view.saved[0].name, "Regional office");
});

test("a blank optional name keeps the generated protocol and endpoint fallback", async () => {
  const view = surface();
  edit(view);
  view.change("Proxy name", "   ");
  await view.submit();
  assert.equal(view.saved[0].name, "HTTP proxy.example.test:8080");
});

test("a new proxy keeps its custom name when a complete proxy URL is pasted", async () => {
  const view = surface();
  view.find(node => node.type === "button" && node.props.className === "px-add").props.onClick();
  assert.equal(view.field("Proxy name").props.value, "");
  view.change("Proxy name", "Travel");
  view.change("Host", "socks5://user:password@travel.example.test:1080");
  await view.submit();
  assert.equal(view.saved[0].name, "Travel");
  assert.equal(view.saved[0].endpoint.protocol, "socks5");
  assert.equal(view.saved[0].username, "user");
  assert.equal(view.saved[0].password, "password");
});

test("cards and both route selectors identify profiles by name", () => {
  const view = surface();
  assert.equal(view.find(node => node.props.className === "px-name").props.children, "Office proxy");
  assert.equal(view.find(node => node.type === "option" && node.key === "office").props.children, "Office proxy · proxy.example.test:8080");
  const options = source.match(/<option key=\{profile\.id\} value=\{profile\.id\}>\{profileLabel\(profile\)\}<\/option>/g);
  assert.equal(options.length, 2);
});

test("a proxy that signs in shows its username on the card, in the route pickers and when edited", async () => {
  const view = surface();
  view.profile.username = "office-user";
  const card = view.find(node => node.props.className === "px-user");
  assert.equal(card.props.children[1].props.children, "office-user");
  assert.match(card.props.title, /office-user/);
  assert.equal(view.find(node => node.type === "option" && node.key === "office").props.children,
    "Office proxy · proxy.example.test:8080 · office-user");
  edit(view);
  assert.equal(view.field("Username").props.value, "office-user");
  assert.equal(view.field("Password").props.value, "", "the saved password is never shown");
  await view.submit();
  assert.equal(view.saved[0].username, "office-user");
  assert.ok(!("password" in view.saved[0]), "an untouched password is kept, not resent");
});

test("a proxy with no sign-in shows no username line", () => {
  const view = surface();
  view.profile.hasAuthentication = false;
  const walk = node => !node || typeof node !== "object" ? false
    : Array.isArray(node) ? node.some(walk) : node.props?.className === "px-user" || walk(node.props?.children);
  assert.equal(walk(view.find(node => node.props.className === "px-list")), false);
});
