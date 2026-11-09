"use strict";
// Runtime > Computer use (src/features/ComputerUseSurface.tsx): the sidebar tab for chat agents'
// computer use. The module is transpiled and run against stand-in React hooks, so what it renders
// and when it reads control's state are checked without a browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const SOURCE = path.resolve(__dirname, "../src/features/ComputerUseSurface.tsx");

/** The module, with hooks that hand out `states` in order and record effects. */
function load({ states = [], client = {} } = {}) {
  const effects = [];
  const queue = [...states];
  const element = (type, props) => ({ type, props: props ?? {} });
  const modules = {
    react: {
      useState: (initial) => [queue.length ? queue.shift() : initial, () => undefined],
      useCallback: (fn) => fn,
      useEffect: (fn, deps) => effects.push({ fn, deps }),
    },
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: "Fragment" },
    "../api/client": { getCodingToolsClient: () => ({ computer: client }) },
    "./computer-use.css": {},
  };
  const { outputText } = ts.transpileModule(fs.readFileSync(SOURCE, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  const timers = [];
  const window = { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => undefined, confirm: () => true };
  vm.runInNewContext(outputText, {
    module, exports: module.exports, window,
    require: (name) => { if (!(name in modules)) throw new Error(`unexpected import ${name}`); return modules[name]; },
  });
  return { api: module.exports, effects, timers };
}

/** Renders a component's tree, calling function components, into plain elements. */
function render(node) {
  if (Array.isArray(node)) return node.flatMap(render);
  if (!node || typeof node !== "object") return node === null || node === undefined || node === false ? [] : [node];
  if (typeof node.type === "function") return render(node.type(node.props));
  return [{ ...node, props: { ...node.props, children: render(node.props.children) } }];
}
const walk = (nodes, visit) => { for (const node of nodes) { if (node && typeof node === "object") { visit(node); walk(node.props.children ?? [], visit); } } };
const text = (nodes) => { const out = []; const visit = (list) => { for (const node of list) { if (typeof node === "string" || typeof node === "number") out.push(String(node)); else if (node?.props) visit(node.props.children ?? []); } }; visit(nodes); return out.join(""); };
const plain = (value) => JSON.parse(JSON.stringify(value));
const buttons = (nodes) => { const found = []; walk(nodes, (node) => { if (node.type === "button") found.push(node); }); return found; };

const OVERVIEW = {
  ready: true, state: "active",
  controlled: { app: "notepad.exe", appName: "Notepad", title: "notes.txt - Notepad", agent: "Claude Code", model: "gpt-6.1-sol", action: "Typing 5 characters" },
  history: [{ time: "10:00:02", agent: "Claude Code", model: "gpt-6.1-sol", action: "Typing 5 characters", app: "Notepad", outcome: "running" },
    { time: "10:00:01", agent: "Claude Code", model: "", action: "Clicking “Save”", app: "Notepad", outcome: "failed" }],
  apps: [{ app: "chrome.exe", name: "Google Chrome", at: 1 }],
  requests: [{ id: "r1", workspaceId: "ws", sessions: ["s1"], agent: "Codex", app: "Paint", window: "<img src=x>", project: "proj",
    captureOff: true, firstUse: false, elevated: false, persistModes: ["always", "conversation"] }],
};
const props = (extra = {}) => ({ active: true, toolsOn: true, desktopOn: true, reviewSteps: false, setPreference: () => undefined, setError: () => undefined, ...extra });

test("open apps to allow: one row per app not yet always allowed, two titles at most, by name", () => {
  const { api } = load();
  const rows = api.appsToAllow([
    { app: "notepad.exe", appName: "Notepad", title: "a.txt" }, { app: "notepad.exe", appName: "Notepad", title: "b.txt" },
    { app: "notepad.exe", appName: "Notepad", title: "c.txt" }, { app: "chrome.exe", appName: "Google Chrome", title: "Inbox" },
    { app: "blender.exe", appName: "Blender", title: "" }, { app: "", appName: "", title: "no program" },
  ], [{ app: "chrome.exe", name: "Google Chrome", at: 1 }]);
  assert.deepEqual(plain(rows.map((row) => [row.app, row.titles])), [["blender.exe", []], ["notepad.exe", ["a.txt", "b.txt"]]]);
  assert.equal(api.controlState({ ...OVERVIEW, ready: false }), "starting");
  assert.equal(api.controlState(OVERVIEW), "in control");
  assert.equal(api.controlState({ ...OVERVIEW, controlled: null, state: "unknown" }), "state unknown");
  assert.equal(api.controlState({ ...OVERVIEW, controlled: null, state: "stopped" }), "idle");
});

test("the tab shows the window under control with Stop, the request waiting, the allowed apps and the steps", async () => {
  const calls = [];
  const client = { stop: async () => { calls.push("stop"); return { ok: true }; }, answer: async (input) => { calls.push(["answer", input]); return { ok: true }; },
    overview: async () => OVERVIEW, forgetApp: async (input) => { calls.push(["forget", input]); return { ok: true }; } };
  const { api } = load({ states: [OVERVIEW, null, null], client });
  const tree = render(api.ComputerUseSurface(props()));
  const all = text(tree);
  for (const shown of ["Computer use", "Notepad", "notes.txt - Notepad", "Typing 5 characters", "Claude Code · gpt-6.1-sol",
    "Allow Codex to use Paint?", "Window: <img src=x>", "Allowing it turns on screen capture for proj.", "Google Chrome", "10:00:01", "Clicking “Save”"]) {
    assert.ok(all.includes(shown), shown);
  }
  const labels = buttons(tree).map((button) => text([button]) || button.props["aria-label"]);
  for (const label of ["Let chat agents use the computer", "Review each step", "Stop", "Always allow", "Deny", "Allow this conversation", "Remove",
    "Allow an app from your open windows"]) assert.ok(labels.includes(label), label);
  const marks = []; walk(tree, (node) => { if (node.props.className === "cu-mark") marks.push(text([node])); });
  assert.deepEqual(marks, ["…", "✕"]);

  const click = (label) => buttons(tree).find((button) => (text([button]) || button.props["aria-label"]) === label).props.onClick();
  click("Stop");
  click("Allow this conversation");
  click("Remove");
  await new Promise(setImmediate);
  assert.deepEqual(plain(calls), ["stop", ["answer", { id: "r1", decision: "conversation" }], ["forget", { app: "chrome.exe" }]]);
});

test("the switches: computer use needs the app's chat tools, and Review each step needs computer use", () => {
  const changed = [];
  const { api } = load({ states: [{ ...OVERVIEW, controlled: null, requests: [], history: [], apps: [] }, null, null] });
  const switches = (extra) => buttons(render(api.ComputerUseSurface(props({ setPreference: (key, value) => changed.push([key, value]), ...extra }))))
    .filter((button) => button.props.role === "switch");
  const [use, review] = switches({ desktopOn: false });
  assert.deepEqual([use.props["aria-checked"], use.props.disabled, review.props.disabled], [false, false, true]);
  use.props.onClick();
  assert.deepEqual(changed, [["chatAgentDesktopTools", true]]);
  const [off] = switches({ toolsOn: false });
  assert.deepEqual([off.props["aria-checked"], off.props.disabled], [false, true], "off and fixed while the app's chat tools are off");
  const [, reviewing] = switches({ reviewSteps: true });
  assert.equal(reviewing.props["aria-checked"], true);
  reviewing.props.onClick();
  assert.deepEqual(changed.at(-1), ["computerReviewSteps", false]);
});

test("control's state is read only while the tab is on screen, again every 1.5 s, and when a chat asks", async () => {
  let reads = 0, subscribed = 0, unsubscribed = 0;
  const client = { overview: async () => { reads += 1; return OVERVIEW; }, onRequests: () => { subscribed += 1; return () => { unsubscribed += 1; }; } };
  const hidden = load({ client });
  hidden.api.ComputerUseSurface(props({ active: false }));
  const poll = hidden.effects.find((effect) => effect.deps?.[0] === false);
  assert.equal(poll.fn(), undefined);
  assert.deepEqual([reads, subscribed], [0, 0], "a hidden tab reads nothing");

  const shown = load({ client });
  shown.api.ComputerUseSurface(props());
  const cleanup = shown.effects.find((effect) => effect.deps?.[0] === true).fn();
  await new Promise(setImmediate);
  assert.deepEqual([reads, subscribed], [1, 1]);
  assert.equal(shown.timers.at(-1).ms, 1_500);
  shown.timers.at(-1).fn();
  await new Promise(setImmediate);
  assert.equal(reads, 2);
  cleanup();
  assert.equal(unsubscribed, 1);
});

test("the sidebar has a Computer use tab under Runtime, kept mounted like the others", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "../src/App.tsx"), "utf8");
  assert.match(app, /<SidebarItem active=\{surface === "computer-use"\} icon="cursor" label="Computer use" onClick=\{\(\) => navigateSurface\("computer-use"\)\} \/>/);
  assert.match(app, /keepAlive\("computer-use", \(\) => \(\s*<ComputerUseSurface\s+active=\{surface === "computer-use"\}/);
  const types = fs.readFileSync(path.resolve(__dirname, "../src/types.ts"), "utf8");
  assert.match(types, /"subagents" \| "computer-use"/);
});
