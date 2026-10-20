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
    { exports, require, localStorage: storage, crypto: globalThis.crypto, window: { setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, removeEventListener() {} } });
  return exports;
};
const stored = {};
const storage = { getItem: (key) => stored[key] ?? null, setItem: (key, value) => { stored[key] = value; } };
const chat = compile("ao-chat.ts", () => ({}));

// A tiny hook runtime: state persists across renders by call order.
function mount(Component, props, { effects = false } = {}) {
  const states = []; const refs = []; let cursor = 0, refCursor = 0;
  const react = {
    useState(initial) {
      const at = cursor++;
      if (!(at in states)) states[at] = typeof initial === "function" ? initial() : initial;
      return [states[at], (value) => { states[at] = typeof value === "function" ? value(states[at]) : value; }];
    },
    // Refs persist like state; effects run after each render only when a test asks for them.
    useRef: (initial) => { const at = refCursor++; if (!(at in refs)) refs[at] = { current: initial }; return refs[at]; },
    useEffect: (effect) => { if (effects) effect(); },
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const module = compile(Component, (name) => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx }
    : name === "./ao-chat" ? chat : name === "../icons" ? { Icon: "Icon" } : name === "./ChatMenu" ? { ChatMenu: "ChatMenu", FloatingLayer: "FloatingLayer" } : {});
  const render = (next = {}) => { cursor = 0; refCursor = 0; return module.ChatThreadList({ ...props, ...next }); };
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
    pinnedProjects: [], toggleProjectPin: (id) => calls.push(["projectPin", id]), busyTaskIds: [],
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

const projectButton = (view, name) => walk(view).find((element) => element.type === "button" && element.props.className === "cx-project" && text(element).includes(name));

test("clicking the open project collapses it; clicking another project opens its chats in place, as in Codex", () => {
  const { props, calls } = fixture();
  const list = mount("ChatThreadList.tsx", props);
  let view = list.render();
  assert.equal(projectButton(view, "Alpha").props["aria-expanded"], true);
  projectButton(view, "Alpha").props.onClick();
  view = list.render();
  assert.equal(projectButton(view, "Alpha").props["aria-expanded"], false, "collapsed");
  assert.equal(JSON.parse(stored["coding-tools:ao:collapsed-projects"]).includes("a"), true, "the choice is remembered");
  projectButton(view, "Alpha").props.onClick();
  assert.equal(projectButton(list.render(), "Alpha").props["aria-expanded"], true, "expanded again");
  projectButton(list.render(), "Beta").props.onClick();
  view = list.render();
  assert.equal(projectButton(view, "Beta").props["aria-expanded"], true, "Beta opens under its row");
  assert.deepEqual(calls, [], "the open chat and project stay put");
  assert.match(text(view), /Loading chats…/);
  assert.deepEqual(JSON.parse(stored["coding-tools:ao:open-projects"]), ["b"], "open projects are remembered");
  projectButton(view, "Beta").props.onClick();
  assert.equal(projectButton(list.render(), "Beta").props["aria-expanded"], false, "and closes again");
});

test("another open project lists its chats; opening one switches to its project first", async () => {
  const { props, calls } = fixture();
  stored["coding-tools:ao:open-projects"] = JSON.stringify(["b"]);
  const loaded = [];
  const list = mount("ChatThreadList.tsx", { ...props, loadProjectChats: async (id) => {
    loaded.push(id);
    return [{ taskId: "b1", title: "Beta chat", status: "done", runIds: ["rb"], latestRunId: "rb" }];
  } }, { effects: true });
  list.render();
  await new Promise((resolve) => setImmediate(resolve));
  const view = list.render();
  assert.ok(loaded.includes("b"), "only the other open project is read");
  assert.ok(!loaded.includes("a"));
  const row = walk(view).find((element) => element.type === "button" && element.props.className === "cx-thread-select" && text(element).includes("Beta chat"));
  assert.ok(row, "Beta's chat shows under Beta");
  row.props.onClick();
  assert.deepEqual(calls, [["selectIn", "b", "b1"]]);
  delete stored["coding-tools:ao:open-projects"];
});

test("a used chat rises to the top of its project, and its project to the top of Projects (pinned first)", () => {
  const list = compile("ChatThreadList.tsx", (name) => name === "react" ? { useState() {}, useRef() {}, useEffect() {} } : name === "react/jsx-runtime" ? { jsx() {}, jsxs() {} } : name === "./ao-chat" ? chat : {});
  const projects = [{ id: "a" }, { id: "b" }, { id: "c" }];
  // The module runs in its own realm: compare plain copies.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(list.orderProjects(projects, [], {}).map((item) => item.id)), ["a", "b", "c"], "unused projects keep the list's order");
  assert.deepEqual(plain(list.orderProjects(projects, [], { c: 5, b: 2 }).map((item) => item.id)), ["c", "b", "a"], "the most recently used comes first");
  assert.deepEqual(plain(list.orderProjects(projects, ["a"], { c: 5 }).map((item) => item.id)), ["a", "c", "b"], "pinned projects stay first");

  const chats = [{ taskId: "t1", latestRunId: "r1" }, { taskId: "t2", latestRunId: "r9" }];
  assert.deepEqual(plain(list.releaseUsedChats(["t1", "t2"], { t1: "r1", t2: "r2" }, chats)), { order: ["t1"], used: ["t2"] },
    "a chat with a new run leaves the dragged order, so it rises with the newest chats");
  const unchanged = ["t1", "t2"];
  assert.equal(list.releaseUsedChats(unchanged, { t1: "r1", t2: "r9" }, chats).order, unchanged, "no new run, no change");
  assert.deepEqual(plain(list.releaseUsedChats(unchanged, {}, chats).used), [], "a chat seen for the first time is not a use");
});

test("right-click menus match Codex: its order and glyphs, and every chat item does something", () => {
  const { props, calls } = fixture();
  const list = mount("ChatThreadList.tsx", props);
  const event = { preventDefault() {}, clientX: 10, clientY: 20 };
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const menuOf = () => walk(list.render()).find((element) => element.type === "ChatMenu").props.menu;
  const rows = walk(list.render()).filter((element) => element.type === "li" && element.props.onContextMenu);
  rows[1].props.onContextMenu(event);
  assert.deepEqual([menuOf().x, menuOf().y], [10, 20], "the menu opens at the pointer");
  const taskMenu = menuOf().items.filter((item) => item.kind !== "separator");
  assert.deepEqual(plain(taskMenu.map((item) => item.label)), ["Rename", "Pin", "Mark as unread", "Project", "Section", "Fork", "Schedule start…", "Share", "Copy",
    "Open in new window", "Open in", "Archive", "Delete"]);
  assert.deepEqual(plain(taskMenu.filter((item) => item.shortcut).map((item) => [item.label, item.shortcut])),
    [["Rename", "Alt+Ctrl+R"], ["Pin", "Alt+Ctrl+P"], ["Mark as unread", "Ctrl+Shift+U"], ["Archive", "Ctrl+Shift+A"]]);
  for (const item of taskMenu) {
    assert.ok(item.run || item.items?.length, `${item.label} does something`);
    assert.ok(item.icon, `${item.label} has Codex's glyph`);
  }
  taskMenu.find((item) => item.label === "Schedule start…").run();
  taskMenu.find((item) => item.label === "Delete").run();
  taskMenu.find((item) => item.label === "Share").run();
  taskMenu.find((item) => item.label === "Open in new window").run();
  assert.deepEqual(calls.splice(0), [["lifecycle", "t2", "schedule"], ["lifecycle", "t2", "delete"], ["share", "t2"], ["openWindow", "t2"]]);
  const projects = taskMenu.find((item) => item.label === "Project").items;
  assert.deepEqual(plain(projects.map((item) => [item.label, Boolean(item.run), Boolean(item.checked)])),
    [["Alpha", false, true], ["Continue in Beta", true, false]], "the chat's own project is checked; another continues the chat there");
  projects[1].run();
  taskMenu.find((item) => item.label === "Fork").items[0].run();
  taskMenu.find((item) => item.label === "Copy").items[1].run();
  taskMenu.find((item) => item.label === "Open in").items[0].run();
  assert.deepEqual(calls, [["continueIn", "t2", "b"], ["fork", "t2", "start"], ["copy", "t2", "conversation"], ["openStructure", "t2"]]);

  walk(list.render()).find((element) => element.props?.className === "cx-project" && text(element).includes("Alpha")).props.onContextMenu(event);
  const projectMenu = menuOf().items.filter((item) => item.kind !== "separator");
  assert.deepEqual(plain(projectMenu.map((item) => item.label)), ["Pin", "Edit", "New section…", "Open in Explorer", "Archive chats", "Remove project"]);
  for (const item of projectMenu) assert.ok(item.run || item.reason, `${item.label} is wired or explains why not`);
  projectMenu.find((item) => item.label === "Open in Explorer").run();
  assert.deepEqual(plain(calls.at(-1)), ["openFolder", { id: "a", name: "Alpha", path: "C:\\alpha" }]);
  // Remove project opens the Edit project dialog's confirmation (files are never deleted).
  projectMenu.find((item) => item.label === "Remove project").run();
  assert.deepEqual(plain(calls.at(-1)), ["removeProject", "a"]);
});

test("without a remove action, Remove project stays disabled and says where to remove projects", () => {
  const { props } = fixture();
  const actions = props.actions;
  props.actions = new Proxy({}, { get: (_target, name) => name === "removeProject" ? undefined : actions[name] });
  const list = mount("ChatThreadList.tsx", props);
  const event = { preventDefault() {}, clientX: 1, clientY: 2 };
  walk(list.render()).find((element) => element.props?.className === "cx-project" && text(element).includes("Alpha")).props.onContextMenu(event);
  const remove = walk(list.render()).find((element) => element.type === "ChatMenu").props.menu.items.find((item) => item.label === "Remove project");
  assert.equal(remove.run, undefined);
  assert.equal(remove.reason, "Remove projects on the Workspace page");
});

test("Section › files a chat into a named sidebar section, kept on this computer", () => {
  const { props } = fixture();
  delete stored["coding-tools:ao:chat-sections"];
  const list = mount("ChatThreadList.tsx", props);
  const event = { preventDefault() {}, clientX: 10, clientY: 20 };
  const menuOf = () => walk(list.render()).find((element) => element.type === "ChatMenu").props.menu;
  walk(list.render()).filter((element) => element.type === "li" && element.props.onContextMenu)[1].props.onContextMenu(event);
  menuOf().items.find((item) => item.label === "Section").items.find((item) => item.label === "New section…").run();
  const input = () => walk(list.render()).find((element) => element.type === "input" && element.props["aria-label"] === "New section name");
  input().props.onChange({ target: { value: "Bugs" } });
  input().props.onKeyDown({ key: "Enter" });
  const view = list.render();
  const head = walk(view).find((element) => String(element.props?.className).includes("cx-section-head"));
  assert.match(text(head), /Bugs/);
  const saved = JSON.parse(stored["coding-tools:ao:chat-sections"]);
  assert.deepEqual(saved.map((section) => [section.name, section.taskIds]), [["Bugs", ["t2"]]]);
  const projectChats = walk(walk(view).find((element) => element.props?.className === "cx-projects")).filter((element) => element.type === "li" && String(element.props.className).startsWith("cx-thread-row"));
  assert.deepEqual(projectChats.map((row) => text(row)).map((label) => label.includes("Older") ? "t2" : "t1"), ["t1"], "a filed chat leaves the project list, as a pinned one does");
  walk(list.render()).filter((element) => element.type === "li" && element.props.onContextMenu && text(element).includes("Older"))[0].props.onContextMenu(event);
  const section = menuOf().items.find((item) => item.label === "Section").items;
  assert.equal(section.find((item) => item.label === "Bugs").checked, true);
  section.find((item) => item.label === "Remove from section").run();
  assert.deepEqual(JSON.parse(stored["coding-tools:ao:chat-sections"])[0].taskIds, []);
});

test("chat order: active chats stay on top, new chats come next, then the order you dragged", () => {
  const list = compile("ChatThreadList.tsx", (name) => name === "./ao-chat" ? chat : name === "react" ? { useState() {}, useRef() {}, useEffect() {} } : name === "react/jsx-runtime" ? { jsx() {}, jsxs() {} } : {});
  const chats = [{ taskId: "new", status: "done" }, { taskId: "a", status: "done" }, { taskId: "b", status: "running" }, { taskId: "c", status: "stopped" }];
  // Arrays from the sandbox have their own prototype; compare them as plain JSON.
  const ids = (order, manual, keep = true) => JSON.parse(JSON.stringify(list.orderChats(order, manual, keep).map((item) => item.taskId)));
  const move = (...args) => JSON.parse(JSON.stringify(list.moveChat(...args)));
  assert.deepEqual(ids(chats, []), ["b", "new", "a", "c"], "running first, then newest first");
  assert.deepEqual(ids(chats, ["c", "a"]), ["b", "new", "c", "a"], "a chat you haven't placed stays above your order");
  assert.deepEqual(ids(chats, ["c", "a", "new", "b"], false), ["c", "a", "new", "b"], "without the setting, only your order counts");
  assert.deepEqual(move(["x", "y", "z"], "z", "x"), ["z", "x", "y"]);
  assert.deepEqual(move(["x", "y", "z"], "x", null), ["y", "z", "x"]);
});

test("a long project shows 5 chats and Show more, like Codex; the count is a list setting", () => {
  delete stored["coding-tools:ao:chat-list-settings"];
  delete stored["coding-tools:ao:chat-order:a"];
  const { props } = fixture();
  props.chats = Array.from({ length: 8 }, (_, index) => ({ taskId: `c${index}`, title: `Chat ${index}`, status: "done", runIds: [], latestRunId: "" }));
  props.selectedTaskId = "c7";
  const list = mount("ChatThreadList.tsx", props);
  const projectRows = (view) => walk(walk(view).find((element) => element.props?.className === "cx-projects"))
    .filter((element) => element.type === "li" && String(element.props.className).startsWith("cx-thread-row"))
    .map((row) => text(walk(row).find((element) => element.props?.className === "cx-thread-title")));
  let view = list.render();
  assert.deepEqual(projectRows(view), ["Chat 0", "Chat 1", "Chat 2", "Chat 3", "Chat 4", "Chat 7"], "the first five, plus the open chat");
  const more = () => walk(list.render()).find((element) => element.props?.className === "cx-show-more");
  assert.equal(text(more()), "Show more");
  more().props.onClick();
  assert.equal(projectRows(list.render()).length, 8);
  assert.equal(text(more()), "Show less");
  walk(list.render()).find((element) => element.props?.className === "cx-list-settings")
    .props.onClick({ currentTarget: { getBoundingClientRect: () => ({ bottom: 10, left: 20 }) } });
  const popover = walk(list.render()).find((element) => element.type === "FloatingLayer" && element.props.className === "cx-popover");
  walk(popover).find((element) => element.props?.["aria-label"] === "Chats shown per project").props.onChange({ target: { value: "3" } });
  assert.equal(JSON.parse(stored["coding-tools:ao:chat-list-settings"]).visible, 3);
});

test("a project row has Codex's hover actions (its menu and a new chat there), and Edit opens the project", () => {
  const { props, calls } = fixture();
  const list = mount("ChatThreadList.tsx", props);
  const button = (label) => walk(list.render()).find((element) => element.type === "button" && element.props["aria-label"] === label);
  assert.ok(button("Alpha actions") && button("New chat in Alpha") && button("New chat in Beta"));
  button("New chat in Beta").props.onClick();
  button("Alpha actions").props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 5, bottom: 9 }) } });
  const menu = walk(list.render()).find((element) => element.type === "ChatMenu").props.menu;
  assert.deepEqual([menu.x, menu.y], [5, 13], "the menu opens under the button");
  menu.items.find((item) => item.label === "Edit").run();
  assert.deepEqual(calls, [["newChatIn", "b"], ["editProject", "a"]]);
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

test("every project's archived chats show in a folder per project, Chats for chats with no project, and Recently deleted last", () => {
  const { props } = fixture();
  const restored = [];
  const day = 86_400_000;
  const list = mount("ChatThreadList.tsx", { ...props, now: 10 * day,
    archivedAll: { days: 5, chats: [
      { workspaceId: "a", taskId: "x", title: "Alpha old", visibility: "archived", archivedAt: 7 * day },
      { workspaceId: "b", taskId: "y", title: "Beta loose", visibility: "archived", archivedAt: 9 * day },
      { workspaceId: "a", taskId: "z", title: "Long gone", visibility: "deleted" },
    ] },
    restoreArchived: (workspaceId, taskId) => restored.push([workspaceId, taskId]), setArchiveDays: () => {} });
  const toggle = walk(list.render()).find((element) => element.props?.className === "cx-archived-toggle");
  assert.match(text(toggle), /Archived \(2\)/, "deleted chats are counted apart");
  toggle.props.onClick();
  const view = list.render();
  const heads = walk(view).filter((element) => element.type === "button" && /cx-project/.test(String(element.props.className)) && element.props["aria-expanded"] !== undefined)
    .map((element) => text(element)).filter((value) => /Alpha|Chats|Recently deleted/.test(value) && !/Fix app|Older/.test(value));
  assert.deepEqual(heads.slice(-3), ["Alpha1", "Chats1", "Recently deleted1"], "Beta has no folder, so its chat is under Chats");
  const rows = walk(view).filter((element) => element.type === "li" && element.props.className === "cx-thread-row is-archived");
  assert.match(text(rows[0]), /Alpha old.*2d/, "two days left of five");
  walk(rows[1]).find((element) => element.props?.className === "cx-restore").props.onClick();
  assert.deepEqual(restored, [["b", "y"]], "restore goes to the chat's own project");
});

test("a project's git label: none for a repository's root, worktree said plainly, anything chats can't use flagged", () => {
  const { projectGitLabel } = compile("ChatThreadList.tsx", (name) => name === "react" ? { useState() {}, useRef() {}, useEffect() {} }
    : name === "react/jsx-runtime" ? { jsx() {}, jsxs() {} } : name === "./ao-chat" ? chat : {});
  const label = (git) => JSON.parse(JSON.stringify(projectGitLabel(git)));
  assert.deepEqual(label({ kind: "repo", root: "G:\\repo", mainRepo: null, branch: "main" }), { tag: null, line: "Git repository · main", warn: false });
  assert.deepEqual(label({ kind: "worktree", root: "C:\\wt", mainRepo: "G:\\repo", branch: "feat/x" }),
    { tag: "worktree", line: "Worktree of G:\\repo · feat/x", warn: false });
  const inside = label({ kind: "inside", root: "G:\\repo", mainRepo: null, branch: "main" });
  assert.equal(inside.tag, "subfolder");
  assert.equal(inside.warn, true);
  assert.match(inside.line, /inside the repository G:\\repo/);
  const none = label({ kind: "none", root: null, mainRepo: null, branch: null });
  assert.deepEqual([none.tag, none.warn], ["not git", true]);
  assert.match(none.line, /Not a git repository/);
  assert.deepEqual([label({ kind: "missing", root: null, mainRepo: null, branch: null }).tag], ["missing"]);
  assert.equal(projectGitLabel(null), null, "not read yet: no label");
});
