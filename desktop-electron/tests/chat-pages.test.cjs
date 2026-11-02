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
const key = (value = "E", extra = {}) => ({
  key: value, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, repeat: false,
  isComposing: false, defaultPrevented: false, keyCode: 0, target: null, getModifierState: () => false, ...extra,
});
const configured = (api) => ({ ...plain(api.DEFAULT_CHAT_PAGES), enabled: true, pageCount: 3 });

test("chat pages default off, and corrupt or out-of-range settings preserve usable defaults", () => {
  const { api } = load();
  assert.deepEqual(plain(api.parseChatPagePreferences(null)), plain(api.DEFAULT_CHAT_PAGES));
  for (const raw of ["broken", "null", "[]", '{"pageCount":0}', '{"pageCount":999}', '{"pageCount":2.5}']) {
    assert.equal(api.parseChatPagePreferences(raw).pageCount, 1);
  }
  const parsed = api.parseChatPagePreferences('{"enabled":true,"pageCount":4,"keyboard":false,"wheel":false,"next":"ctrl+shift+n","previous":"shift+r","unknown":"discard"}');
  assert.deepEqual(plain(parsed), { enabled: true, pageCount: 4, keyboard: false, wheel: false, next: "Ctrl+Shift+N", previous: "Shift+R" });
  assert.deepEqual(plain(api.parseChatPagePreferences('{"next":"Shift+R","previous":"Shift+R"}')), plain(api.DEFAULT_CHAT_PAGES));
});

test("shortcut recording normalizes modifiers and rejects plain typing, duplicate modifiers and AltGr", () => {
  const { api } = load();
  assert.equal(api.normalizePageShortcut("shift+ctrl+e"), "Ctrl+Shift+E");
  assert.equal(api.normalizePageShortcut("Alt+ArrowRight"), "Alt+ArrowRight");
  assert.equal(api.normalizePageShortcut("Ctrl+PageDown"), "Ctrl+PageDown");
  assert.equal(api.normalizePageShortcut("Meta+F12"), "Meta+F12");
  for (const value of ["E", "Shift", "Shift+Shift+R", "Ctrl+", "Ctrl+F25", "Win+E", null]) assert.equal(api.normalizePageShortcut(value), null);
  assert.equal(api.recordPageShortcut(key("e")), "Shift+E");
  assert.equal(api.recordPageShortcut(key(" ", { shiftKey: false, ctrlKey: true })), "Ctrl+Space");
  assert.equal(api.recordPageShortcut(key("E", { isComposing: true })), null);
  assert.equal(api.recordPageShortcut(key("e", { ctrlKey: true, altKey: true, getModifierState: () => true })), null);
});

test("next and previous defaults and rebound keys obey the enable switches", () => {
  const { api } = load();
  const preferences = configured(api);
  assert.equal(api.pageShortcutDirection(key("E"), preferences), 1);
  assert.equal(api.pageShortcutDirection(key("R"), preferences), -1);
  for (const disabled of [{ enabled: false }, { keyboard: false }, { pageCount: 1 }]) {
    assert.equal(api.pageShortcutDirection(key("E"), { ...preferences, ...disabled }), 0);
  }
  const rebound = { ...preferences, next: "Ctrl+Shift+N" };
  assert.equal(api.pageShortcutDirection(key("E"), rebound), 0);
  assert.equal(api.pageShortcutDirection(key("N", { ctrlKey: true }), rebound), 1);
});

test("page keys never consume editing, dialogs, composition, repeats or an already handled event", () => {
  const { api } = load();
  const preferences = configured(api);
  for (const extra of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true },
    { shiftKey: false }, { ctrlKey: true }, { target: { closest: () => ({}) } }]) {
    assert.equal(api.pageShortcutDirection(key("E", extra), preferences), 0);
  }
});

test("page navigation wraps in both directions without making a new page", () => {
  const { api } = load();
  assert.equal(api.adjacentChatPage(3, 1, 3), 1);
  assert.equal(api.adjacentChatPage(1, -1, 3), 3);
  assert.equal(api.adjacentChatPage(2, 1, 3), 3);
  assert.equal(api.adjacentChatPage(1, -1, 1), 1);
});

test("settings persist independently and failed or conflicting writes do not replace them", () => {
  const { api, values, localStorage } = load();
  api.saveChatPagePreferences({ enabled: true, pageCount: 4, next: "Ctrl+Shift+N" });
  api.saveChatPagePreferences({ keyboard: false });
  const saved = values.get(api.CHAT_PAGES_STORE);
  assert.deepEqual(JSON.parse(saved), { ...plain(api.DEFAULT_CHAT_PAGES), enabled: true, pageCount: 4, next: "Ctrl+Shift+N", keyboard: false });
  assert.throws(() => api.saveChatPagePreferences({ previous: "Ctrl+Shift+N" }), /different shortcuts/);
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
  } else {
    const statement = surface.body.statements.find((node) => ts.isVariableStatement(node)
      && node.declarationList.declarations.some((item) => item.name.getText(file) === name));
    callback = statement.declarationList.declarations.find((item) => item.name.getText(file) === name).initializer.arguments[0];
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
