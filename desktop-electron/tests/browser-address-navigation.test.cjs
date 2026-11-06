"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { navigateBrowser } = require("../electron/browser-state.cjs");

// Load the navigation method alone; no Electron process or installed browser is involved.
function hostFixture() {
  const source = fs.readFileSync(path.resolve(__dirname, "../electron/browser-host.cjs"), "utf8");
  const method = source.slice(source.indexOf("  navigate(action) {"), source.indexOf("\n  zoom(action) {"));
  const Host = vm.runInNewContext(`(class { ${method} })`, { navigateBrowser });
  const calls = [];
  const contents = { id: 42, isDestroyed: () => false, navigationHistory: {}, loadURL: async url => { calls.push(url); }, reload() { calls.push("reload"); } };
  const host = new Host();
  Object.assign(host, { activeTraceId: null, manualOperation: null, selectedUserTab: () => null,
    activeView: () => ({ webContents: contents }), snapshot: () => ({ navigationTargetId: contents.id, url: calls.at(-1) }) });
  return { host, calls, contents };
}

test("the screenshot browser address is an editable component wired to the existing IPC", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "../src/App.tsx"), "utf8");
  // The GPT Browser's toolbar opens a typed address in a tab of the person's own (openBrowserUrl),
  // never the home page or a Codex turn's tab; the bar resets when the shown tab changes.
  assert.match(app, /<BrowserAddressBar[\s\S]*?navigationTargetId[\s\S]*?openBrowserUrl\(input\.url\)/);
  const preload = fs.readFileSync(path.resolve(__dirname, "../electron/preload.cjs"), "utf8");
  assert.match(preload, /navigateBrowser:.*ipcRenderer.invoke\("launcher:browser-navigate", action\)/);
  assert.match(preload, /openBrowserUrl:.*ipcRenderer.invoke\("launcher:browser-open-url", url\)/);
});

test("address navigation opens HTTPS domains and explicit HTTP URLs in the selected view", async () => {
  const { host, calls } = hostFixture();
  const result = await host.navigate({ url: "example.com/docs?q=1#section", targetId: 42 });
  assert.equal(result.url, "https://example.com/docs?q=1#section");
  await host.navigate({ url: " http://localhost:5173/hello ", targetId: 42 });
  assert.deepEqual(calls, ["https://example.com/docs?q=1#section", "http://localhost:5173/hello"]);
});

test("address navigation rejects unsafe schemes and URL credentials before loading", async () => {
  for (const url of ["javascript:alert(1)", "data:text/html,hello", "file:///G:/secret", "about:blank", "ftp://example.com", "https://user:secret@example.com", "", "https://"]) {
    const { host, calls } = hostFixture();
    await assert.rejects(async () => host.navigate({ url, targetId: 42 }));
    assert.deepEqual(calls, [], url);
  }
});

test("stale address submissions cannot navigate a different tab or account view", async () => {
  for (const targetId of [undefined, null, "42", 41, 0]) {
    const { host, calls } = hostFixture();
    await assert.rejects(async () => host.navigate({ url: "https://example.com", targetId }), /changed|target|tab/i);
    assert.deepEqual(calls, []);
  }
});

test("address navigation retains automation locks but permits a separate user tab", async () => {
  const { host, calls } = hostFixture();
  host.activeTraceId = "owned-turn";
  assert.throws(() => host.navigate({ url: "example.com", targetId: 42 }), /locked/);
  host.selectedUserTab = () => ({ id: "user-tab" });
  await host.navigate({ url: "example.com", targetId: 42 });
  host.manualOperation = "connection test";
  assert.throws(() => host.navigate({ url: "another.example", targetId: 42 }), /locked/);
  assert.deepEqual(calls, ["https://example.com/"]);
});

test("navigation errors reach the renderer without silently falling back to another page", async () => {
  const { host, contents, calls } = hostFixture();
  contents.loadURL = async () => { throw new Error("offline fixture"); };
  await assert.rejects(async () => host.navigate({ url: "example.com", targetId: 42 }), /offline fixture/);
  assert.deepEqual(calls, []);
});

function mountAddress(overrides = {}) {
  const ts = require("typescript");
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/BrowserAddressBar.tsx"), "utf8");
  const states = [], effects = [], calls = [], errors = [];
  let cursor = 0, props = { url: "https://chatgpt.com/c/old?mode=test", displayAddress: "chatgpt.com/c/old",
    targetId: 42, disabled: false, navigate: async input => calls.push(input), setError: error => errors.push(error), ...overrides };
  const useState = initial => {
    const at = cursor++;
    if (!(at in states)) states[at] = initial;
    return [states[at], value => { states[at] = typeof value === "function" ? value(states[at]) : value; }];
  };
  const useRef = initial => { const at = cursor++; return states[at] ??= { current: initial }; };
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 } }).outputText, { exports,
    require: name => name === "react" ? { useState, useRef, useEffect: fn => { if (!effects.length) effects.push(fn()); } }
      : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : { Icon: "icon" } });
  const render = (next = {}) => { props = { ...props, ...next }; cursor = 0; return exports.BrowserAddressBar(props); };
  return { render, calls, errors, unmount: () => effects.forEach(cleanup => cleanup?.()) };
}

const addressInput = tree => tree.props.children.find(item => item.type === "input");
const tick = () => new Promise(resolve => setImmediate(resolve));

test("the address editor selects the full URL and keeps typing through page snapshots", () => {
  const mounted = mountAddress();
  let tree = mounted.render(), input = addressInput(tree), selected = false;
  assert.equal(input.props.value, "chatgpt.com/c/old");
  const element = { value: "", select() { selected = true; } };
  input.props.onFocus({ currentTarget: element });
  assert.equal(element.value, "https://chatgpt.com/c/old?mode=test");
  assert.equal(selected, true);
  addressInput(mounted.render()).props.onChange({ target: { value: "example.com/typed" } });
  input = addressInput(mounted.render({ url: "https://chatgpt.com/c/redirected", displayAddress: "chatgpt.com/c/redirected" }));
  assert.equal(input.props.value, "example.com/typed", "a background snapshot must not replace the draft");
  let blurred = false;
  input.props.onKeyDown({ key: "Escape", nativeEvent: {}, preventDefault() {}, currentTarget: { blur() { blurred = true; } } });
  assert.equal(blurred, true);
  assert.equal(addressInput(mounted.render()).props.value, "chatgpt.com/c/redirected");
});

test("a pending page does not lock the address bar and stale errors cannot erase a newer URL", async () => {
  const requests = [];
  const mounted = mountAddress({ navigate: input => new Promise((resolve, reject) => requests.push({ input, resolve, reject })) });
  addressInput(mounted.render()).props.onChange({ target: { value: "first.example" } });
  let tree = mounted.render();
  tree.props.onSubmit({ preventDefault() {} });
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(requests.length, 1, "same draft cannot submit twice");
  assert.equal(addressInput(mounted.render()).props.disabled, false, "slow loads do not prevent another address");
  addressInput(mounted.render()).props.onChange({ target: { value: "second.example" } });
  tree = mounted.render();
  tree.props.onSubmit({ preventDefault() {} });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].input.targetId, 42);
  requests[0].reject(new Error("aborted old navigation"));
  await tick();
  assert.equal(mounted.errors.filter(Boolean).length, 0);
  assert.equal(addressInput(mounted.render()).props.value, "second.example");
  addressInput(mounted.render()).props.onChange({ target: { value: "third.example" } });
  requests[1].resolve({});
  await tick();
  assert.equal(addressInput(mounted.render()).props.value, "third.example", "completion must preserve newer unsent typing");
});

test("failed address submissions keep the draft and tab replacement suppresses stale feedback", async () => {
  let reject;
  const mounted = mountAddress({ navigate: () => new Promise((_resolve, fail) => { reject = fail; }) });
  addressInput(mounted.render()).props.onChange({ target: { value: "bad.example" } });
  mounted.render().props.onSubmit({ preventDefault() {} });
  reject(new Error("failed fixture"));
  await tick();
  assert.match(String(mounted.errors.at(-1)), /failed fixture/);
  assert.equal(addressInput(mounted.render()).props.value, "bad.example");
  mounted.render().props.onSubmit({ preventDefault() {} });
  mounted.unmount();
  reject(new Error("late fixture"));
  await tick();
  assert.equal(mounted.errors.filter(Boolean).length, 1);
});

test("address entry respects runtime locks, missing target identities, Escape and IME Enter", () => {
  for (const overrides of [{ disabled: true }, { targetId: undefined }]) {
    const mounted = mountAddress(overrides);
    addressInput(mounted.render()).props.onChange({ target: { value: "example.com" } });
    const tree = mounted.render();
    assert.equal(addressInput(tree).props.disabled, true);
    tree.props.onSubmit({ preventDefault() {} });
    assert.equal(mounted.calls.length, 0);
  }
  const mounted = mountAddress();
  let prevented = false;
  addressInput(mounted.render()).props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: true }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});
