"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const compile = (file, require) => {
  const exports = {};
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require, localStorage: storage, window: { setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, removeEventListener() {} } });
  return exports;
};
const stored = {};
const storage = { getItem: (key) => stored[key] ?? null, setItem: (key, value) => { stored[key] = value; } };
const chat = compile("ao-chat.ts", () => ({}));

// A tiny hook runtime: state persists across renders by call order.
function mount(Component, props) {
  const states = []; let cursor = 0;
  const react = {
    useState(initial) {
      const at = cursor++;
      if (!(at in states)) states[at] = typeof initial === "function" ? initial() : initial;
      return [states[at], (value) => { states[at] = typeof value === "function" ? value(states[at]) : value; }];
    },
    useRef: (initial) => ({ current: initial }), useEffect() {},
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const module = compile(Component, (name) => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx }
    : name === "./ao-chat" ? chat : name === "../icons" ? { Icon: "Icon" } : name === "./ChatMenu" ? { ChatMenu: "ChatMenu" } : {});
  const render = (next = {}) => { cursor = 0; return module.ChatThreadList({ ...props, ...next }); };
  return { render, states };
}
const walk = (item) => !item || typeof item !== "object" ? [] : Array.isArray(item) ? item.flatMap(walk) : [item, ...walk(item.props?.children)];
const text = (item) => walk(item).flatMap((element) => [element.props?.children].flat()).filter((value) => typeof value === "string" || typeof value === "number").join("");

function fixture() {
  const calls = [];
  const props = {
    workspaces: [{ id: "a", name: "Alpha", path: "C:\\alpha" }, { id: "b", name: "Beta" }], workspaceId: "a",
    onWorkspace: (id) => calls.push(["workspace", id]),
    chats: [{ taskId: "t1", title: "Fix app", status: "running", runIds: ["r1"], latestRunId: "r1", updatedAtMs: 0 },
      { taskId: "t2", title: "Older", status: "done", runIds: ["r2"], latestRunId: "r2", updatedAtMs: 0 }],
    archived: [{ taskId: "t3", title: "Gone", status: "done", runIds: ["r3"], latestRunId: "r3" }],
    selectedTaskId: "t2", now: 0, pinned: [], togglePin: (id) => calls.push(["pin", id]),
    unread: ["t1"], setUnread: (id, value) => calls.push(["unread", id, value]),
    pinnedProjects: [], toggleProjectPin: (id) => calls.push(["projectPin", id]), busy: false,
    actions: new Proxy({}, { get: (_target, name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(); } }),
  };
  return { props, calls };
}

test("each chat row has Codex's hover Pin and Archive buttons, not the old envelope and funnel icons", () => {
  const { props, calls } = fixture();
  const view = mount("ChatThreadList.tsx", props).render();
  const rows = walk(view).filter((element) => element.type === "li" && String(element.props.className).startsWith("cx-thread-row") && !String(element.props.className).includes("is-archived"));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const labels = walk(row).filter((element) => element.type === "button").map((button) => button.props["aria-label"]).filter(Boolean);
    assert.deepEqual(labels, ["Pin chat", "Archive chat"]);
    assert.ok(!walk(row).some((element) => element.type === "Icon" && ["mail", "orchestrator"].includes(element.props.name)), "the envelope and funnel icons are gone");
  }
  // Archive goes through the lifecycle, which asks before stopping a running chat's work.
  const archiveRunning = walk(rows[0]).find((element) => element.props?.["aria-label"] === "Archive chat");
  assert.equal(archiveRunning.props.disabled, false);
  assert.match(rows[0].props.className, /is-unread/, "an unread chat that isn't open is marked");
  walk(rows[1]).find((element) => element.props?.["aria-label"] === "Pin chat").props.onClick();
  walk(rows[1]).find((element) => element.props?.["aria-label"] === "Archive chat").props.onClick();
  walk(rows[1]).find((element) => element.props?.className === "cx-thread-select").props.onClick();
  assert.deepEqual(calls, [["pin", "t2"], ["lifecycle", "t2", "archive"], ["select", "t2"]]);
});

test("clicking the open project collapses it; clicking another project opens it", () => {
  const { props, calls } = fixture();
  const list = mount("ChatThreadList.tsx", props);
  const project = (view, name) => walk(view).find((element) => element.type === "button" && element.props.className === "cx-project" && text(element).includes(name));
  let view = list.render();
  assert.equal(project(view, "Alpha").props["aria-expanded"], true);
  project(view, "Alpha").props.onClick();
  view = list.render();
  assert.equal(project(view, "Alpha").props["aria-expanded"], false, "collapsed");
  assert.equal(JSON.parse(stored["coding-tools:ao:collapsed-projects"]).includes("a"), true, "the choice is remembered");
  project(view, "Alpha").props.onClick();
  assert.equal(project(list.render(), "Alpha").props["aria-expanded"], true, "expanded again");
  project(list.render(), "Beta").props.onClick();
  assert.deepEqual(calls, [["workspace", "b"]]);
});

test("right-click menus match Codex and every item is either wired or disabled with a reason", () => {
  const { props, calls } = fixture();
  const list = mount("ChatThreadList.tsx", props);
  const event = { preventDefault() {}, clientX: 10, clientY: 20 };
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const menuOf = () => walk(list.render()).find((element) => element.type === "ChatMenu").props.menu;
  const rows = walk(list.render()).filter((element) => element.type === "li" && element.props.onContextMenu);
  rows[1].props.onContextMenu(event);
  const taskMenu = menuOf().items.filter((item) => item.kind !== "separator");
  assert.deepEqual(plain(taskMenu.map((item) => item.label)), ["Rename", "Pin", "Mark as unread", "Project", "Section", "Fork", "Schedule start…", "Share", "Copy",
    "Open in new window", "Open in", "Archive", "Delete (recoverable)"]);
  assert.deepEqual(plain(taskMenu.filter((item) => item.shortcut).map((item) => [item.label, item.shortcut])),
    [["Rename", "Alt+Ctrl+R"], ["Pin", "Alt+Ctrl+P"], ["Mark as unread", "Ctrl+Shift+U"], ["Archive", "Ctrl+Shift+A"]]);
  for (const item of taskMenu) assert.ok(item.run || item.items?.length || item.reason, `${item.label} is wired or explains why not`);
  assert.deepEqual(plain(taskMenu.filter((item) => !item.run && !item.items).map((item) => item.label)),
    ["Project", "Section", "Share", "Open in new window"]);
  taskMenu.find((item) => item.label === "Schedule start…").run();
  taskMenu.find((item) => item.label === "Delete (recoverable)").run();
  assert.deepEqual(calls.splice(0), [["lifecycle", "t2", "schedule"], ["lifecycle", "t2", "delete"]]);
  taskMenu.find((item) => item.label === "Fork").items[0].run();
  taskMenu.find((item) => item.label === "Copy").items[1].run();
  taskMenu.find((item) => item.label === "Open in").items[0].run();
  assert.deepEqual(calls, [["fork", "t2", "start"], ["copy", "t2", "conversation"], ["openStructure", "t2"]]);

  walk(list.render()).find((element) => element.props?.className === "cx-project" && text(element).includes("Alpha")).props.onContextMenu(event);
  const projectMenu = menuOf().items.filter((item) => item.kind !== "separator");
  assert.deepEqual(plain(projectMenu.map((item) => item.label)), ["Pin", "Edit", "Section", "Open in Explorer", "Archive chats", "Remove project"]);
  for (const item of projectMenu) assert.ok(item.run || item.reason, `${item.label} is wired or explains why not`);
  projectMenu.find((item) => item.label === "Open in Explorer").run();
  assert.deepEqual(plain(calls.at(-1)), ["openFolder", { id: "a", name: "Alpha", path: "C:\\alpha" }]);
});

test("archived chats sit in their own section and can be restored", () => {
  const { props, calls } = fixture();
  const list = mount("ChatThreadList.tsx", props);
  const toggle = walk(list.render()).find((element) => element.props?.className === "cx-archived-toggle");
  assert.match(text(toggle), /Archived \(1\)/);
  toggle.props.onClick();
  walk(list.render()).find((element) => element.props?.className === "cx-restore").props.onClick();
  assert.deepEqual(calls, [["lifecycle", "t3", "restore"]]);
});
