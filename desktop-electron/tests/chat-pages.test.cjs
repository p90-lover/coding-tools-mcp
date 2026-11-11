"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const ts = require(require.resolve("typescript", { paths: [root] }));
const source = fs.readFileSync(path.join(root, "src/features/chat-pages.ts"), "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const plain = (value) => JSON.parse(JSON.stringify(value));

function load(entries = []) {
  const values = new Map(entries);
  const events = new Map();
  const localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const exports = {};
  vm.runInNewContext(output, { exports, localStorage, window: {
    addEventListener: (type, listener) => events.set(type, listener), removeEventListener: (type) => events.delete(type),
  }, require: (name) => require(require.resolve(name, { paths: [root] })) });
  return { api: exports, values, localStorage };
}
// Ctrl+<digit> on the digit row, as Chromium reports it.
const key = (digit = "2", extra = {}) => ({
  key: digit, code: `Digit${digit}`, shiftKey: false, ctrlKey: true, altKey: false, metaKey: false, repeat: false,
  isComposing: false, defaultPrevented: false, keyCode: 0, target: null, getModifierState: () => false, ...extra,
});
const configured = (api) => ({ ...plain(api.DEFAULT_CHAT_PAGES), enabled: true, pageCount: 3 });

test("chat pages default on, an explicit off stays off, and corrupt or out-of-range settings preserve usable defaults", () => {
  const { api } = load();
  assert.deepEqual(plain(api.parseChatPagePreferences(null)), plain(api.DEFAULT_CHAT_PAGES));
  // Nothing saved (the user's app on 2026-11-08): pages, their keys and the wheel all work.
  assert.equal(api.DEFAULT_CHAT_PAGES.enabled, true);
  assert.equal(api.parseChatPagePreferences(null).enabled, true);
  assert.equal(api.parseChatPagePreferences('{"pageCount":3}').enabled, true, "a store without the switch is on");
  assert.equal(api.parseChatPagePreferences('{"enabled":false,"pageCount":3}').enabled, false, "turned off in Settings stays off");
  for (const raw of ["broken", "null", "[]", '{"pageCount":0}', '{"pageCount":999}', '{"pageCount":2.5}']) {
    assert.equal(api.parseChatPagePreferences(raw).pageCount, 1);
  }
  const parsed = api.parseChatPagePreferences('{"enabled":true,"pageCount":4,"keyboard":false,"wheel":false,"next":"ctrl+shift+n","previous":"shift+r","unknown":"discard"}');
  assert.deepEqual(plain(parsed), { enabled: true, pageCount: 4, keyboard: false, wheel: false }, "old previous/next keys are dropped");
});

test("Shift+Q / Shift+R are gone: no letter turns a page, and saved keys drop out on the next save", () => {
  const { api, values } = load([["coding-tools:ao:chat-pages", '{"enabled":true,"pageCount":3,"keyboard":true,"wheel":true,"previous":"Shift+Q","next":"Shift+R"}']]);
  assert.equal(api.recordPageShortcut, undefined);
  assert.equal(api.pageShortcutDirection, undefined);
  assert.deepEqual(Object.keys(api.DEFAULT_CHAT_PAGES).sort(), ["enabled", "keyboard", "pageCount", "wheel"]);
  for (const letter of ["Q", "R", "q", "r"]) {
    assert.equal(api.pageNumberKey(key(letter, { code: `Key${letter.toUpperCase()}`, ctrlKey: false, shiftKey: true }), configured(api)), 0);
    assert.equal(api.pageNumberKey(key(letter, { code: `Key${letter.toUpperCase()}` }), configured(api)), 0, `Ctrl+${letter}`);
  }
  api.saveChatPagePreferences({ wheel: false });
  assert.deepEqual(JSON.parse(values.get(api.CHAT_PAGES_STORE)), { enabled: true, pageCount: 3, keyboard: true, wheel: false });
});

test("Ctrl+1 … Ctrl+9 open pages 1 to 9 and Ctrl+0 page 10, on any layout, and only pages that are open", () => {
  const { api } = load();
  const twelve = { ...configured(api), pageCount: 12 };
  for (let page = 1; page <= 10; page++) assert.equal(api.pageNumberKey(key(String(page % 10)), twelve), page);
  assert.equal(api.pageNumberKey(key("&", { code: "Digit1" }), twelve), 1, "AZERTY: the digit row counts by position");
  assert.equal(api.pageNumberKey(key("3", { code: "Numpad3" }), twelve), 3, "the number pad with NumLock on");
  assert.equal(api.pageNumberKey(key("End", { code: "Numpad1" }), twelve), 0, "NumLock off: Ctrl+End stays Ctrl+End");
  const three = configured(api);
  assert.equal(api.pageNumberKey(key("3"), three), 3);
  assert.equal(api.pageNumberKey(key("4"), three), 0, "page 4 is not open: the key is left alone");
  assert.equal(api.pageNumberKey(key("0"), three), 0);
  for (const disabled of [{ enabled: false }, { keyboard: false }, { pageCount: 1 }]) {
    assert.equal(api.pageNumberKey(key("1"), { ...three, ...disabled }), 0, JSON.stringify(disabled));
  }
});

test("page number keys need Ctrl alone and skip composition, repeats, AltGr and an already handled event", () => {
  const { api } = load();
  const preferences = configured(api);
  for (const extra of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true },
    { ctrlKey: false }, { shiftKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: false, metaKey: true }]) {
    assert.equal(api.pageNumberKey(key("2", extra), preferences), 0, JSON.stringify(extra));
  }
});

// A small stand-in for Element.closest over PAGE_KEYS_PAUSED's simple selectors: tags,
// [attr], [attr="value"] and [attr]:not([attr="value"]), on an element and its ancestors.
function element(tag, attributes = {}, parent = null, extra = {}) {
  const matches = (node, selector) => {
    const [, name = "", rest = ""] = /^([a-z]*)(.*)$/.exec(selector.trim());
    if (name && node.tag !== name) return false;
    for (const [, negate, attr, value] of rest.matchAll(/(:not\()?\[([a-z-]+)(?:="([^"]*)")?\]\)?/g)) {
      const has = attr in node.attributes && (value === undefined || node.attributes[attr] === value);
      if (negate ? has : !has) return false;
    }
    return true;
  };
  const node = { tag, attributes, parent, ...extra,
    closest(selectors) {
      for (let at = node; at; at = at.parent) if (selectors.split(",").some((selector) => matches(at, selector))) return at;
      return null;
    } };
  return node;
}

test("Ctrl+number works while you type in a chat, never in a dialog, menu or list", () => {
  const { api } = load();
  const preferences = configured(api);
  const rich = element("div", { contenteditable: "" });
  const anywhere = [element("textarea", { class: "cx-composer" }), element("input", { type: "text" }), rich, element("span", {}, rich),
    element("div", { role: "textbox" }), element("body"), element("button", { role: "tab" }), null];
  for (const target of anywhere) assert.equal(api.pageNumberKey(key("2", { target }), preferences), 2, target ? target.tag : "no target");
  for (const target of [element("button", {}, element("div", { role: "dialog" })), element("div", { role: "menu" }), element("div", { role: "listbox" })]) {
    assert.equal(api.pageNumberKey(key("2", { target }), preferences), 0, JSON.stringify(target.attributes));
  }
});

test("Alt+scroll turns pages anywhere; over the chats only a plain sideways swipe does; over the tabs any scroll", () => {
  const { api } = load();
  const wheel = (extra) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });
  assert.equal(api.pageWheelDelta(wheel({ deltaY: 100, altKey: true }), false), 100, "Alt+scroll down: the next page");
  assert.equal(api.pageWheelDelta(wheel({ deltaY: -100, altKey: true }), false), -100, "Alt+scroll up: the previous page");
  assert.equal(api.pageWheelDelta(wheel({ deltaY: -3, deltaMode: 1, altKey: true }), false), -48, "lines count as 16 px");
  assert.equal(api.pageWheelDelta(wheel({ deltaY: 100, altKey: true, shiftKey: true }), false), 0, "Alt+Shift is no page turn");
  assert.equal(api.pageWheelDelta(wheel({ deltaY: 100 }), false), 0, "scrolling messages never turns a page");
  assert.equal(api.pageWheelDelta(wheel({ deltaY: 100, deltaX: 20 }), false), 0, "a mostly up/down scroll is no swipe");
  assert.equal(api.pageWheelDelta(wheel({ deltaX: 100 }), false), 100, "a tilted wheel or touchpad swipe");
  assert.equal(api.pageWheelDelta(wheel({ deltaX: -30, deltaY: 4 }), false), -30);
  assert.equal(api.pageWheelDelta(wheel({ deltaY: 100, shiftKey: true }), false), 0, "Shift+wheel scrolls sideways and turns nothing (Alt does)");
  assert.equal(api.pageWheelDelta(wheel({ deltaX: -100, shiftKey: true }), false), 0);
  assert.equal(api.pageWheelDelta(wheel({ deltaY: -3, deltaMode: 1 }), true), -48, "over the tabs, lines count as 16 px");
  assert.equal(api.pageWheelDelta(wheel({ deltaY: 100 }), true), 100, "over the tabs, down is the next page");
  for (const modifier of ["ctrlKey", "metaKey"]) {
    assert.equal(api.pageWheelDelta(wheel({ deltaX: 100, [modifier]: true }), false), 0, `${modifier}+wheel zooms`);
    assert.equal(api.pageWheelDelta(wheel({ deltaY: 100, [modifier]: true, altKey: true }), true), 0);
  }
});

test("a scroll gesture turns one page at most, and one that starts up/down or is kept turns none", () => {
  const { api } = load();
  const run = (deltas, { step = 16, blocked } = {}) => {
    const swipe = api.createPageSwipe();
    return deltas.map((delta, index) => swipe(delta, 1000 + index * step, blocked)).filter(Boolean);
  };
  assert.deepEqual(run([100]), [1], "a wheel notch turns at once");
  assert.deepEqual(run([-100]), [-1]);
  assert.deepEqual(run([10, 10, 10, 10, 10, 10, 9, 9, 8, 6, 4, 3, 2, 1]), [1], "a touchpad swipe and its momentum: one page");
  assert.deepEqual(run([100, 100, 100, 100]), [1], "notches in a burst: one page");
  assert.deepEqual(run([100, 100], { step: 300 }), [1, 1], "notches apart: a page each");
  assert.deepEqual(run([0, 30, 30, 30, 30]), [], "an up/down scroll drifting sideways never turns a page");
  assert.deepEqual(run([30, -30, -30]), [-1], "a reversal counts afresh");
  let asked = 0;
  assert.deepEqual(run([60, 60, 60], { blocked: () => { asked++; return true; } }), [], "a wide code block keeps its own swipe");
  assert.equal(asked, 1, "what is under the pointer is read once per gesture, not per event");
});

test("page navigation wraps in both directions without making a new page", () => {
  const { api } = load();
  assert.equal(api.adjacentChatPage(3, 1, 3), 1);
  assert.equal(api.adjacentChatPage(1, -1, 3), 3);
  assert.equal(api.adjacentChatPage(2, 1, 3), 3);
  assert.equal(api.adjacentChatPage(1, -1, 1), 1);
});

test("settings persist independently and failed or out-of-range writes do not replace them", () => {
  const { api, values, localStorage } = load();
  api.saveChatPagePreferences({ enabled: true, pageCount: 4 });
  api.saveChatPagePreferences({ keyboard: false });
  const saved = values.get(api.CHAT_PAGES_STORE);
  assert.deepEqual(JSON.parse(saved), { ...plain(api.DEFAULT_CHAT_PAGES), enabled: true, pageCount: 4, keyboard: false });
  assert.throws(() => api.saveChatPagePreferences({ pageCount: 13 }), /between 1 and 12/);
  assert.equal(values.get(api.CHAT_PAGES_STORE), saved);
  localStorage.setItem = () => { throw new Error("storage full"); };
  assert.throws(() => api.saveChatPagePreferences({ wheel: false }), /storage full/);
  assert.equal(values.get(api.CHAT_PAGES_STORE), saved);
});

test("page 1 keeps legacy workspace and split keys; other pages and saved selections are isolated", () => {
  const { api, values } = load();
  assert.equal(api.chatPageKey("coding-tools:ao:split-view", 1), "coding-tools:ao:split-view");
  assert.equal(api.chatPageKey("coding-tools:ao:split-view", 2), "coding-tools:ao:split-view:page-2");
  assert.equal(api.readPageSelection(2), null);
  const second = api.chatPageKey(`${api.CHAT_PAGES_STORE}:selection`, 2);
  values.set(second, '{"workspaceId":"project-2","taskId":"task-8","foreign":"discard"}');
  assert.deepEqual(plain(api.readPageSelection(2)), { workspaceId: "project-2", taskId: "task-8" });
  assert.equal(api.readPageSelection(1), null);
  values.set(second, '{"workspaceId":"project-2","taskId":7}');
  assert.equal(api.readPageSelection(2), null);
});

test("an existing chat returns to its page and exact split pane, with project-scoped ownership", () => {
  const { api } = load();
  const seen = [];
  const registry = api.createChatPageRegistry((page) => seen.push(["page", page]));
  registry.register(2, [{ workspaceId: "project-2", taskId: "task-8", paneId: "pane-4" }], (pane) => seen.push(["pane", pane]));
  assert.equal(registry.has(1, "project-2", "task-8"), true);
  assert.equal(registry.reveal(1, "project-2", "task-8"), true);
  assert.deepEqual(seen, [["page", 2], ["pane", "pane-4"]]);
  assert.equal(registry.reveal(2, "project-2", "task-8"), false);
  assert.equal(registry.reveal(1, "another-project", "task-8"), false);
  assert.equal(registry.reveal(1, "project-2", ""), false);
});

test("a stale page cleanup cannot erase a newer ownership registration", () => {
  const { api } = load();
  const registry = api.createChatPageRegistry(() => {});
  const old = registry.register(2, [{ workspaceId: "ws", taskId: "old", paneId: "main" }], () => {});
  const current = registry.register(2, [{ workspaceId: "ws", taskId: "new", paneId: "main" }], () => {});
  old();
  assert.equal(registry.has(1, "ws", "new"), true);
  assert.equal(registry.has(1, "ws", "old"), false);
  current();
  assert.equal(registry.has(1, "ws", "new"), false);
});

test("a full page's chat goes to the next page with room, wrapping round, and a page is added only when all are full", () => {
  const { api } = load();
  const roomOn = (...pages) => (page) => pages.includes(page);
  assert.equal(api.overflowPage(2, 4, roomOn(1, 3, 4), true), 3, "the next page first");
  assert.equal(api.overflowPage(2, 4, roomOn(1, 4), true), 4, "then the one after");
  assert.equal(api.overflowPage(4, 4, roomOn(1, 2), true), 1, "from the last page it wraps, as Alt+scroll down does");
  assert.equal(api.overflowPage(3, 4, roomOn(1), true), 1, "an earlier page with room before a new page");
  assert.equal(api.overflowPage(1, 4, roomOn(), true), 5, "every page full: a new one");
  assert.equal(api.overflowPage(1, 12, roomOn(), false), null, "twelve full pages: nowhere");
  assert.equal(api.overflowPage(1, 1, roomOn(1), true), 2, "one page: never itself, a second one");
});

function overflowRegistry(api, { count = 2, limit = 12, enabled = true } = {}) {
  const seen = [];
  const layout = { count: () => enabled ? count : 0, canAdd: () => enabled && count < limit, add: () => { seen.push(["add", count + 1]); count++; return true; } };
  const registry = api.createChatPageRegistry((page) => seen.push(["page", page]), layout);
  const room = (page, has) => registry.register(page, [], () => {}, { room: () => has, wake: () => seen.push(["wake", page]) });
  return { registry, seen, room };
}
const ask = { workspaceId: "ws", taskId: "", maxColumns: 5 };

test("a full page's new chat waits on the page that has room, which takes it once", () => {
  const { api } = load();
  const { registry, seen, room } = overflowRegistry(api);
  room(1, false); room(2, true);
  assert.equal(registry.openElsewhere(1, ask), true);
  assert.deepEqual(seen, [["page", 2], ["wake", 2]], "page 2 shows and is told a chat is waiting");
  assert.deepEqual(plain(registry.takeOpen(2)), { ...ask, tried: [1] });
  assert.equal(registry.takeOpen(2), undefined, "taken once");
});

test("with every page full a page is added for the chat, and with none left it stays where it was", () => {
  const { api } = load();
  const full = overflowRegistry(api);
  full.room(1, false); full.room(2, false);
  assert.equal(full.registry.openElsewhere(1, ask), true);
  assert.deepEqual(full.seen, [["add", 3], ["page", 3]], "a third page, which mounts and takes it");
  assert.deepEqual(plain(full.registry.takeOpen(3)), { ...ask, tried: [1] });

  const capped = overflowRegistry(api, { count: 2, limit: 2 });
  capped.room(1, false); capped.room(2, false);
  assert.equal(capped.registry.openElsewhere(1, ask), false, "all twelve pages full: New chat opens on this page as before");
  assert.deepEqual(capped.seen, []);
});

test("a chat handed on never returns to a page that already had no room, and pages off never hand one on", () => {
  const { api } = load();
  const { registry, seen, room } = overflowRegistry(api, { count: 2, limit: 2 });
  room(1, false);
  assert.equal(registry.openElsewhere(1, ask), true, "page 2 has not loaded yet: it may have room");
  const passed = registry.takeOpen(2);
  room(2, false);
  assert.equal(registry.openElsewhere(2, passed), false, "page 2 loaded full: page 1 was tried, nowhere is left");
  assert.deepEqual(seen, [["page", 2]]);

  const off = overflowRegistry(api, { enabled: false });
  off.room(1, false);
  assert.equal(off.registry.openElsewhere(1, ask), false, "without page tabs a chat never moves to a page no one can see");
  assert.equal(api.createChatPageRegistry(() => {}).openElsewhere(1, ask), false, "no layout: no pages to go to");
});

test("with nothing saved, a plain New chat on a full page adds page 2, keeps it and waits there", () => {
  const { api, values } = load();
  const failures = [];
  const latest = { current: api.parseChatPagePreferences(null) };
  const seen = [];
  const registry = api.createChatPageRegistry((page) => seen.push(page), api.chatPageLayout(latest, (message) => failures.push(message)));
  registry.register(1, [], () => {}, { room: () => false });
  assert.equal(registry.openElsewhere(1, ask), true, "not only Shift+New chat: the page tabs need no switching on first");
  assert.deepEqual(seen, [2]);
  assert.equal(JSON.parse(values.get(api.CHAT_PAGES_STORE)).pageCount, 2, "the new page is kept for the next start");
  assert.equal(latest.current.pageCount, 2);
  assert.deepEqual(plain(registry.takeOpen(2)), { ...ask, tried: [1] });
  assert.deepEqual(failures, []);
});

test("the page layout stops at twelve pages, does nothing while pages are off, and reports a failed save", () => {
  const { api, localStorage } = load();
  const failures = [];
  const latest = { current: { ...plain(api.DEFAULT_CHAT_PAGES), pageCount: 12 } };
  const layout = api.chatPageLayout(latest, (message) => failures.push(message));
  assert.equal(layout.count(), 12);
  assert.equal(layout.canAdd(), false, "twelve pages: the cap");
  latest.current = { ...latest.current, enabled: false, pageCount: 3 };
  assert.equal(layout.count(), 0, "pages off: no page to hand a chat to");
  assert.equal(layout.canAdd(), false);
  latest.current = { ...latest.current, enabled: true };
  localStorage.setItem = () => { throw new Error("storage full"); };
  assert.equal(layout.add(), false);
  assert.equal(latest.current.pageCount, 3, "a failed save adds no page");
  // The error comes from this realm, not the module's, so it reads "Error: storage full" here.
  assert.equal(failures.length, 1);
  assert.match(failures[0], /storage full/);
});

// Execute the production callbacks so these checks cover the integration, not a copy of it.
function surfaceCallback(name, bindings) {
  const text = fs.readFileSync(path.join(root, "src/features/AgentOrchestratorSurface.tsx"), "utf8");
  const file = ts.createSourceFile("surface.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const surface = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "AgentOrchestratorSurface");
  let callback;
  if (name === "selection") {
    const statement = surface.body.statements.find((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.getText(file) === "useEffect"
      && node.expression.arguments[0]?.getText(file).includes("if (chatTaskId !== null || !board"));
    callback = statement.expression.arguments[0];
  } else if (name === "register") {
    const statement = surface.body.statements.find((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.getText(file) === "useLayoutEffect"
      && node.expression.arguments[0]?.getText(file).includes("return pageRegistry.register(pageNumber"));
    callback = statement.expression.arguments[0];
  } else {
    const statement = surface.body.statements.find((node) => ts.isVariableStatement(node)
      && node.declarationList.declarations.some((item) => item.name.getText(file) === name));
    const initializer = statement.declarationList.declarations.find((item) => item.name.getText(file) === name).initializer;
    callback = ts.isArrowFunction(initializer) ? initializer : initializer.arguments[0];
  }
  const exports = {};
  vm.runInNewContext(ts.transpileModule(`exports.run = ${callback.getText(file)}`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, ...bindings });
  return exports.run;
}
function selectionBindings(wanted) {
  const selected = [];
  return {
    selected, chatTaskId: null, board: { tasks: [] }, boardWorkspace: { current: "valid-project" }, workspaceId: "valid-project",
    pane: undefined, paneWanted: { current: wanted }, paneSelectionPending: { current: true }, loadedWorkspace: "valid-project",
    pageNumber: 2, pageRegistry: { has: () => false, reveal: () => { throw new Error("Automatic restore must not change pages"); } },
    missions: [], taskLifecycle: [], chatSeed: null, pendingSelect: { current: null },
    chatList: () => [{ taskId: "current-chat", latestRunId: "current-run" }],
    setChatTaskId: (id) => selected.push(id), setSelectedRunId: () => {}, setView: () => {},
  };
}

test("a removed saved project or a newer workspace selection retires the old root restore", () => {
  for (const old of ["removed-project", "previous-project"]) {
    const bindings = selectionBindings({ workspaceId: old, taskId: "old-chat" });
    surfaceCallback("selection", bindings)();
    assert.equal(bindings.paneWanted.current, null);
    assert.deepEqual(bindings.selected, ["current-chat"]);
  }
});

test("late page restoration with another owner stays local and never reveals a different page", () => {
  const bindings = selectionBindings({ workspaceId: "valid-project", taskId: "current-chat" });
  bindings.pageRegistry.has = () => true;
  surfaceCallback("selection", bindings)();
  assert.deepEqual(bindings.selected, [""]);
});

function splitBindings(registry, pageNumber = 2, splitPanes = []) {
  const exports = {};
  const splitSource = fs.readFileSync(path.join(root, "src/features/chat-split.ts"), "utf8");
  vm.runInNewContext(ts.transpileModule(splitSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
  const state = { panes: splitPanes, errors: [], focus: "main", main: null };
  const bindings = { ...exports, state, splitPanes, pageRegistry: registry, pageNumber, workspaceId: "ws", chatTaskId: "local-chat", splitMaxCols: 3,
    crypto: { randomUUID: () => "new-pane" }, paneShowing: (workspaceId, taskId) => splitPanes.find((pane) => pane.workspaceId === workspaceId && pane.taskId === taskId)?.id,
    setView: () => {}, setSheet: () => {}, setFocusedPane: (id) => { state.focus = id; },
    setSplitPanes: (update) => { state.panes = typeof update === "function" ? update(state.panes) : update; },
    showInMain: (workspaceId, taskId) => { state.main = { workspaceId, taskId }; },
    setError: (error) => state.errors.push(error), moveSplitPane: () => {}, moveMainChat: () => {} };
  bindings.takeChatHere = surfaceCallback("takeChatHere", bindings);
  return bindings;
}

function selectionActionBindings(registry, page = 2) {
  const bindings = splitBindings(registry, page);
  return { ...bindings, composerIntent: { current: 0 }, switchTarget: { current: "" }, pendingSelect: { current: null },
    pendingChat: null, chatUnread: [], missions: [], board: { tasks: [] }, taskLifecycle: [], chatList: () => [],
    focusedSplit: undefined, loadedWorkspace: "ws", preloaded: { current: null },
    setPendingChat() {}, setInspectedId() {}, setDraftTeam() {}, setConfigStatus() {}, setSelectedRunId() {},
    setView: (view) => { bindings.state.view = view; }, setChatTaskId: (taskId) => { bindings.state.taskId = taskId; },
    switchToWorkspace: (id) => { bindings.state.workspaceId = id; }, markUnread() {} };
}

test("chat selection and structure actions stay on later pages instead of revealing page one", () => {
  for (const page of [2, 3]) for (const action of ["showChat", "selectChat", "structure", "selectChatIn"]) {
    const { api } = load();
    const seen = [];
    const registry = api.createChatPageRegistry((page) => seen.push(["page", page]));
    registry.register(1, [{ workspaceId: "ws", taskId: "other-chat", paneId: "main" }], () => {}, { release: (id) => seen.push(["release", id]) });
    const bindings = selectionActionBindings(registry, page);
    bindings.selectChat = surfaceCallback("selectChat", bindings);
    bindings.selectChatIn = surfaceCallback("selectChatIn", bindings);
    if (action === "showChat") surfaceCallback("showChat", bindings)("ws", "other-chat");
    else if (action === "selectChatIn") bindings.selectChatIn("ws", "other-chat");
    else bindings.selectChat("other-chat", action === "structure" ? "overview" : "chat");
    assert.deepEqual(seen, [["release", "main"]], `${action} on page ${page} transfers once without navigating`);
    assert.equal(bindings.state.taskId, "other-chat");
    assert.equal(bindings.state.view, action === "structure" ? "overview" : "chat");
  }
});

test("selection targets the focused pane and cross-project loading stays on its requesting page", async () => {
  const { api } = load();
  const registry = api.createChatPageRegistry(() => { throw new Error("Must not turn pages"); });
  registry.register(1, [{ workspaceId: "other", taskId: "other-chat", paneId: "main" }], () => {}, { release() {} });
  const bindings = selectionActionBindings(registry, 3);
  bindings.focusedSplit = { id: "focused" };
  bindings.state.panes = [{ id: "focused", workspaceId: "ws", taskId: "previous", col: 1, row: 0 }];
  surfaceCallback("showChat", bindings)("other", "other-chat");
  assert.equal(bindings.state.panes[0].workspaceId, "other");
  assert.equal(bindings.state.panes[0].taskId, "other-chat");
  const calls = [];
  const switching = selectionActionBindings(registry, 2);
  switching.moduleCall = async (operation, args) => { calls.push([operation, args.workspaceId]); return {}; };
  surfaceCallback("selectChatIn", switching)("other", "other-chat");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [["board", "other"], ["runs", "other"]]);
  assert.equal(switching.state.workspaceId, "other");
  assert.equal(switching.pendingSelect.current.taskId, "other-chat");
});

test("an unavailable source release rejects every local selection action without navigating", () => {
  for (const action of ["showChat", "selectChat", "selectChatIn"]) {
    const { api } = load();
    const registry = api.createChatPageRegistry(() => { throw new Error("Must not navigate"); });
    registry.register(1, [{ workspaceId: "ws", taskId: "other-chat", paneId: "main" }], () => {});
    const bindings = selectionActionBindings(registry);
    if (action === "selectChat") surfaceCallback(action, bindings)("other-chat");
    else surfaceCallback(action, bindings)("ws", "other-chat");
    assert.equal(bindings.state.errors.length, 1);
    assert.equal(bindings.state.taskId, undefined);
    assert.equal(registry.has(2, "ws", "other-chat"), true);
  }
});

test("an explicit split moves the existing owner to the current page without navigating or duplicating it", () => {
  for (const target of [undefined, { kind: "column" }, { kind: "cell", col: 0, row: 1 }, { kind: "left" }]) {
    const { api } = load();
    const navigated = [], released = [];
    const registry = api.createChatPageRegistry((page) => navigated.push(page));
    registry.register(1, [{ workspaceId: "ws", taskId: "other-chat", paneId: "main" }], () => {}, { release: (id) => released.push(id) });
    const bindings = splitBindings(registry);
    surfaceCallback("openInSplit", bindings)("ws", "other-chat", target);
    assert.deepEqual(navigated, [], "explicit splits never reveal another page");
    assert.deepEqual(released, ["main"], "the old view releases its chat once");
    assert.equal(registry.has(2, "ws", "other-chat"), false, "old ownership is removed before another render");
    assert.equal(bindings.state.main?.taskId ?? bindings.state.panes.find((pane) => pane.taskId === "other-chat")?.taskId, "other-chat");
  }
});

test("a page releases only the requested chat and project, while explicit registry reveal remains available", () => {
  const { api } = load();
  const seen = [];
  const registry = api.createChatPageRegistry((page) => seen.push(["page", page]));
  registry.register(1, [
    { workspaceId: "ws", taskId: "shared-id", paneId: "main" },
    { workspaceId: "other", taskId: "shared-id", paneId: "side" },
  ], (pane) => seen.push(["focus", pane]), { release: (pane) => seen.push(["release", pane]) });
  assert.equal(registry.releaseChat(2, "ws", "shared-id"), true);
  assert.equal(registry.has(2, "ws", "shared-id"), false);
  assert.equal(registry.has(2, "other", "shared-id"), true);
  assert.equal(registry.reveal(2, "other", "shared-id"), true);
  assert.deepEqual(seen, [["release", "main"], ["page", 1], ["focus", "side"]]);
  assert.equal(registry.releaseChat(1, "other", "shared-id"), true, "same-page moves do not release their own view");
  assert.equal(registry.releaseChat(2, "ws", ""), true, "new drafts have no owner");
  assert.equal(registry.has(2, "other", "shared-id"), true);
});

test("a split keeps the source untouched when it cannot release ownership", () => {
  const { api } = load();
  const registry = api.createChatPageRegistry(() => { throw new Error("Must not navigate"); });
  registry.register(1, [{ workspaceId: "ws", taskId: "other-chat", paneId: "main" }], () => {});
  const bindings = splitBindings(registry);
  surfaceCallback("openInSplit", bindings)("ws", "other-chat");
  assert.equal(registry.has(2, "ws", "other-chat"), true);
  assert.equal(bindings.state.panes.length, 0);
  assert.equal(bindings.state.errors.length, 1);
});

test("a source page clears a lone main chat, otherwise closes or promotes only the released pane", () => {
  for (const [paneId, panes] of [["main", []], ["main", [{ id: "side", workspaceId: "ws", taskId: "side-chat", col: 1, row: 0 }]],
    ["side", [{ id: "side", workspaceId: "ws", taskId: "side-chat", col: 1, row: 0 }]]]) {
    const { api } = load();
    const registry = api.createChatPageRegistry(() => { throw new Error("Must not navigate"); });
    const released = [];
    const bindings = { ...splitBindings(registry, 1, panes), pane: undefined, setSettingsOpen: () => {}, setPageOpenAsked: () => {},
      startNewChat: () => released.push("new"), closeSplitPane: (id) => released.push(id) };
    surfaceCallback("register", bindings)();
    registry.releaseChat(2, "ws", paneId === "main" ? "local-chat" : "side-chat");
    assert.deepEqual(released, [paneId === "main" && !panes.length ? "new" : paneId]);
  }
});

test("same-page and blank splits still allocate locally without losing existing panes", () => {
  const { api } = load();
  const registry = api.createChatPageRegistry(() => { throw new Error("Must not navigate"); });
  const side = { id: "side", workspaceId: "ws", taskId: "side-chat", col: 1, row: 0 };
  const bindings = splitBindings(registry, 3, [side]);
  surfaceCallback("openInSplit", bindings)("ws", "side-chat");
  assert.equal(bindings.state.focus, "side");
  surfaceCallback("openInSplit", bindings)("ws", "", { kind: "column" });
  assert.equal(bindings.state.panes.length, 2);
  assert.equal(bindings.state.panes[0].taskId, "side-chat");
  assert.equal(bindings.state.panes[1].taskId, "");
});

test("hidden pages do not start an archived-chat retention scan", async () => {
  let requests = 0, applied = 0;
  const bindings = { workspaceIds: "valid-project", surfaceHidden: () => true,
    moduleCall: async () => { requests++; return { chats: [], days: 0, idleDays: 0 }; },
    setArchivedAll: () => { applied++; } };
  await surfaceCallback("loadArchived", bindings)();
  assert.equal(requests, 0);
  bindings.surfaceHidden = () => false;
  await surfaceCallback("loadArchived", bindings)();
  assert.equal(requests, 1);
  assert.equal(applied, 1);
});
