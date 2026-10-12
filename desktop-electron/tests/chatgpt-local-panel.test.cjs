"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const stored = {};
const storage = {
  getItem: (key) => (key in stored ? stored[key] : null),
  setItem: (key, value) => { stored[key] = String(value); },
};
const timers = [];
const fakeWindow = { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, addEventListener() {}, removeEventListener() {} };
const fakeDocument = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };

const compile = (file, require) => {
  const exports = {};
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require, localStorage: storage, window: fakeWindow, document: fakeDocument });
  return exports;
};

// A tiny hook runtime: state persists across renders by call order; effects run only on request.
function mount(file, exportName, props, modules = {}) {
  const states = [];
  let cursor = 0;
  let effects = [];
  const react = {
    useState(initial) {
      const at = cursor++;
      if (!(at in states)) states[at] = typeof initial === "function" ? initial() : initial;
      return [states[at], (value) => { states[at] = typeof value === "function" ? value(states[at]) : value; }];
    },
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useEffect: (fn) => { effects.push(fn); },
    useLayoutEffect() {},
  };
  const jsx = (type, elementProps) => ({ type, props: elementProps || {} });
  const module = compile(file, (name) => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx, Fragment: "Fragment" } : modules[name] ?? {});
  const render = (next = {}) => { cursor = 0; effects = []; return module[exportName]({ ...props, ...next }); };
  const runEffects = () => effects.forEach((effect) => effect());
  return { render, runEffects, states, module };
}

const walk = (item) => !item || typeof item !== "object" ? [] : Array.isArray(item) ? item.flatMap(walk) : [item, ...walk(item.props?.children)];
const text = (item) => walk(item).flatMap((element) => [element.props?.children].flat()).filter((value) => typeof value === "string").join(" ");
const find = (view, predicate) => walk(view).find(predicate);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeApi(previews = [{ state: "ok", title: "ChatGPT", image: "data:image/jpeg;base64,QUJD", width: 10, height: 10, capturedAt: 1 }]) {
  const calls = [];
  return {
    calls,
    async chatGptLocalPreview() { calls.push(["preview"]); return previews.length > 1 ? previews.shift() : previews[0]; },
    async sendChatGptLocalMessage(value) { calls.push(["send", value]); if (value === "fail") throw new Error("Error invoking remote method 'launcher:chatgpt-desktop-local-send': Error: Could not find ChatGPT's message box"); return { ok: true, sentAt: 2 }; },
  };
}

const panel = compile("ChatGptLocalPanel.tsx", () => ({}));
const EXTENSION_KEY = panel.SEND_EXTENSION_KEY;

test("the preview refreshes while found, slows down while minimized, and stops when ChatGPT is not open", () => {
  assert.equal(panel.nextPreviewDelay("ok"), 1500);
  for (const state of ["minimized", "hidden", "blank"]) assert.equal(panel.nextPreviewDelay(state), 4000);
  for (const state of ["not-running", "unsupported", "error"]) assert.equal(panel.nextPreviewDelay(state), null);
});

test("the send extension is off by default: no message box, nothing can be sent", async () => {
  delete stored[EXTENSION_KEY];
  const api = fakeApi();
  const view = mount("ChatGptLocalPanel.tsx", "ChatGptLocalPanel", { api, active: true, installed: true });
  let tree = view.render();
  view.runEffects();
  await flush();
  tree = view.render();
  assert.ok(find(tree, (el) => el.type === "img" && el.props.src === "data:image/jpeg;base64,QUJD"), "the live preview is shown");
  assert.equal(find(tree, (el) => el.type === "textarea"), undefined);
  assert.equal(find(tree, (el) => el.type === "form"), undefined);
  const toggle = find(tree, (el) => el.props.role === "switch");
  assert.equal(toggle.props["aria-checked"], false);
  assert.ok(!api.calls.some(([name]) => name === "send"));
  // The next capture is scheduled, not fired at once.
  assert.equal(timers.at(-1).ms, 1500);
});

test("turning the extension on is remembered and shows the message box; Send and Enter send, Shift+Enter does not", async () => {
  delete stored[EXTENSION_KEY];
  const api = fakeApi();
  const view = mount("ChatGptLocalPanel.tsx", "ChatGptLocalPanel", { api, active: true, installed: true });
  view.render();
  view.runEffects();
  await flush();
  let tree = view.render();
  find(tree, (el) => el.props.role === "switch").props.onClick();
  assert.equal(stored[EXTENSION_KEY], "1");
  tree = view.render();
  assert.equal(find(tree, (el) => el.props.role === "switch").props["aria-checked"], true);
  const box = find(tree, (el) => el.type === "textarea");
  assert.ok(box);
  // Empty draft: the button is disabled and a submit does nothing.
  assert.equal(find(tree, (el) => el.type === "button" && el.props.type === "submit").props.disabled, true);
  find(tree, (el) => el.type === "form").props.onSubmit({ preventDefault() {} });
  await flush();
  assert.ok(!api.calls.some(([name]) => name === "send"));

  box.props.onChange({ target: { value: "hello there" } });
  tree = view.render();
  let prevented = false;
  find(tree, (el) => el.type === "textarea").props.onKeyDown({ key: "Enter", shiftKey: true, nativeEvent: { isComposing: false }, preventDefault() { prevented = true; } });
  find(tree, (el) => el.type === "textarea").props.onKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: true }, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.ok(!api.calls.some(([name]) => name === "send"));
  assert.equal(find(tree, (el) => el.type === "button" && el.props.type === "submit").props.disabled, false);
  find(tree, (el) => el.type === "textarea").props.onKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await flush();
  assert.deepEqual(api.calls.filter(([name]) => name === "send"), [["send", "hello there"]]);
  tree = view.render();
  assert.equal(find(tree, (el) => el.type === "textarea").props.value, "");
  assert.match(text(tree), /Sent to your ChatGPT app/);

  // A remount on this computer starts with the extension still on.
  const again = mount("ChatGptLocalPanel.tsx", "ChatGptLocalPanel", { api, active: true, installed: true }).render();
  assert.ok(find(again, (el) => el.type === "textarea"));
});

test("a failed send is reported in the panel without the IPC wrapper", async () => {
  stored[EXTENSION_KEY] = "1";
  const api = fakeApi();
  const view = mount("ChatGptLocalPanel.tsx", "ChatGptLocalPanel", { api, active: true, installed: true });
  view.render();
  view.runEffects();
  await flush();
  let tree = view.render();
  find(tree, (el) => el.type === "textarea").props.onChange({ target: { value: "fail" } });
  tree = view.render();
  find(tree, (el) => el.type === "form").props.onSubmit({ preventDefault() {} });
  await flush();
  tree = view.render();
  const status = find(tree, (el) => el.props.role === "status");
  assert.equal(status.props.className, "cgd-local-result is-error");
  assert.equal(status.props.children, "Could not find ChatGPT's message box");
  // The draft is kept so the user can try again.
  assert.equal(find(tree, (el) => el.type === "textarea").props.value, "fail");
});

test("with ChatGPT not open the preview stops, offers Check again, and Send stays disabled", async () => {
  stored[EXTENSION_KEY] = "1";
  const api = fakeApi([{ state: "not-running", title: null, image: null, width: 0, height: 0, capturedAt: 1 }]);
  const view = mount("ChatGptLocalPanel.tsx", "ChatGptLocalPanel", { api, active: true, installed: true });
  view.render();
  const before = timers.length;
  view.runEffects();
  await flush();
  let tree = view.render();
  assert.equal(timers.length, before, "no further capture is scheduled");
  assert.match(text(tree), /not open/);
  find(tree, (el) => el.type === "textarea").props.onChange({ target: { value: "hello" } });
  tree = view.render();
  assert.equal(find(tree, (el) => el.type === "button" && el.props.type === "submit").props.disabled, true);
  find(tree, (el) => el.type === "form").props.onSubmit({ preventDefault() {} });
  await flush();
  assert.ok(!api.calls.some(([name]) => name === "send"));
  const retry = find(tree, (el) => el.type === "button" && el.props.children === "Check again");
  assert.ok(retry);
  retry.props.onClick();
  assert.equal(view.states[4], 1, "Check again restarts the preview loop");
});

test("the preview loop does not run while the page is hidden", () => {
  const api = fakeApi();
  const view = mount("ChatGptLocalPanel.tsx", "ChatGptLocalPanel", { api, active: false, installed: true });
  view.render();
  view.runEffects();
  assert.deepEqual(api.calls, []);
});

test("the ChatGPT Desktop page shows the panel by default and remembers hiding it", () => {
  delete stored[panel.LOCAL_PANEL_KEY];
  const api = { chatGptDesktopStatus: async () => null, onChatGptDesktopChanged: () => () => {}, setChatGptDesktopSurfaceActive: async () => true };
  const view = mount("ChatGptDesktopSurface.tsx", "ChatGptDesktopSurface", { api, active: true, setError() {} }, {
    "./ChatGptLocalPanel": { ...panel, ChatGptLocalPanel: "ChatGptLocalPanel" },
  });
  let tree = view.render();
  assert.ok(find(tree, (el) => el.type === "ChatGptLocalPanel"));
  const toggle = find(tree, (el) => el.type === "button" && el.props["aria-pressed"] === true);
  toggle.props.onClick();
  assert.equal(stored[panel.LOCAL_PANEL_KEY], "0");
  tree = view.render();
  assert.equal(find(tree, (el) => el.type === "ChatGptLocalPanel"), undefined);
  const reopened = mount("ChatGptDesktopSurface.tsx", "ChatGptDesktopSurface", { api, active: true, setError() {} }, {
    "./ChatGptLocalPanel": { ...panel, ChatGptLocalPanel: "ChatGptLocalPanel" },
  }).render();
  assert.equal(find(reopened, (el) => el.type === "ChatGptLocalPanel"), undefined, "still hidden after a remount");
});
