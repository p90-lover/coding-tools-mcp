"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const folder = path.resolve(__dirname, "../src/features");
const plain = (value) => JSON.parse(JSON.stringify(value));
function load(file, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(folder, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require, ...globals });
  return exports;
}
const split = load("chat-split.ts");
const pages = load("chat-pages.ts");
const geometry = load("annotation-layout.ts", { window: { innerWidth: 2560, innerHeight: 1400 } });
const main = { workspaceId: "ws", taskId: "main-chat" };
const ten = [{ id: "bottom", col: 0, row: 1 }, ...[1, 2, 3, 4].flatMap((col) => [
  { id: `top-${col}`, col, row: 0 }, { id: `bottom-${col}`, col, row: 1 },
])].map((pane) => ({ ...pane, workspaceId: "ws", taskId: pane.id }));

function callback(name, bindings) {
  const text = fs.readFileSync(path.join(folder, "AgentOrchestratorSurface.tsx"), "utf8");
  const file = ts.createSourceFile("surface.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const surface = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "AgentOrchestratorSurface");
  const statement = surface.body.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => item.name.getText(file) === name));
  const initializer = statement.declarationList.declarations.find((item) => item.name.getText(file) === name).initializer;
  const exports = {};
  vm.runInNewContext(ts.transpileModule(`exports.run = ${initializer.getText(file)}`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, ...bindings });
  return exports.run;
}
function world(panes = ten) {
  const calls = [];
  return { calls, ...split, pane: undefined, workspaceId: "ws", chatTaskId: "main-chat", splitPanes: panes, splitMaxCols: 5,
    pageNumber: 1, pageRegistry: { openElsewhere: (...args) => { calls.push(["overflow", ...plain(args)]); return true; } },
    focusedSplit: undefined, focusComposer: { current: false },
    setView() {}, setSheet() {}, setSettingsOpen() {},
    setFocusedPane: (id) => calls.push(["focus", id]), setComposerFocusAsked() {},
    openInSplit: (...args) => calls.push(["split", ...plain(args)]),
    newChatInPane: (...args) => calls.push(["replace", ...args]), startNewChat: () => calls.push(["new"]),
    setChatSeed: () => calls.push(["seed"]), chooseWorkspace: () => calls.push(["workspace"]),
    setError: (message) => calls.push(["error", message]),
  };
}

test("annotation details fit each of five narrow panes in either row", () => {
  for (const col of [0, 1, 4]) for (const row of [0, 1]) {
    const bounds = { left: 280 + col * 440, right: 720 + col * 440, top: 40 + row * 650, bottom: 690 + row * 650 };
    for (const y of [bounds.top + 10, bounds.bottom - 40]) {
      const anchor = { left: bounds.right - 130, right: bounds.right - 10, top: y, bottom: y + 30 };
      const result = geometry.annotationPosition(anchor, bounds, 384, 320);
      assert.ok(result.left >= bounds.left + 8);
      assert.ok(result.left + result.width <= bounds.right - 8);
      assert.ok(result.top >= bounds.top + 8);
      assert.ok(result.top + result.maxHeight <= bounds.bottom - 8);
      assert.ok(result.maxHeight > 0);
    }
  }
});
test("short resized panes constrain both editors and long lists, and flip below top-edge chips", () => {
  const bounds = { left: 300, right: 505, top: 400, bottom: 530 };
  const result = geometry.annotationPosition({ left: 490, right: 500, top: 408, bottom: 438 }, bounds, 384, 320);
  assert.equal(result.width, 189);
  assert.equal(result.top, 444);
  assert.equal(result.maxHeight, 78);
  const editor = geometry.annotationPosition({ left: 490, right: 500, top: 492, bottom: 512 }, bounds, 294, 36, true);
  assert.equal(editor.top, 450, "not clipped below the pane");
});
test("annotation bounds intersect the owning pane and viewport, never a neighboring pane", () => {
  const pane = { getBoundingClientRect: () => ({ left: -20, right: 400, top: 50, bottom: 1500 }) };
  assert.deepEqual(plain(geometry.annotationBounds({ closest: (name) => name === ".cx-pane" ? pane : null })),
    { left: 0, right: 400, top: 50, bottom: 1400 });
});
test("Shift placement fills free cells, focuses same-project drafts and refuses to replace other drafts", () => {
  assert.equal(split.newChatPlace(ten, 5, main, "ws"), null);
  assert.deepEqual(plain(split.newChatPlace(ten.slice(0, -1), 5, main, "ws")), { col: 4, row: 1 });
  assert.deepEqual(plain(split.newChatPlace(ten, 5, { ...main, taskId: "" }, "ws")), { paneId: "main" });
  const draft = ten.map((pane, i) => i ? pane : { ...pane, taskId: "" });
  assert.deepEqual(plain(split.newChatPlace(draft, 5, main, "ws")), { paneId: "bottom" });
  assert.equal(split.newChatPlace(draft, 5, main, "other-project"), null);
});
test("production Shift handler sends a full first page to overflow without replacing a chat", () => {
  const bindings = world();
  callback("openNewChat", bindings)("ws", true);
  assert.deepEqual(bindings.calls, [["overflow", 1, { workspaceId: "ws", taskId: "", maxColumns: 5, newScreen: true }]]);
});
test("production Shift handler opens a free cell while plain New chat stays in the focused pane", () => {
  const bindings = world(ten.slice(0, -1));
  bindings.focusedSplit = { id: "focused" };
  callback("openNewChat", bindings)("ws", true);
  assert.deepEqual(bindings.calls, [["split", "ws", "", { col: 4, row: 1 }]]);
  bindings.calls.length = 0;
  callback("openNewChat", bindings)("ws", false);
  assert.deepEqual(bindings.calls, [["replace", "focused", "ws"]]);
});
test("Shift focuses an unsent draft without resetting it and nested panes forward the intent", () => {
  const bindings = world();
  bindings.chatTaskId = "";
  callback("openNewChat", bindings)("ws", true);
  assert.deepEqual(bindings.calls, [["focus", "main"]]);
  bindings.calls.length = 0;
  bindings.pane = { onNewChat: (...args) => bindings.calls.push(args) };
  callback("openNewChat", bindings)("other", true);
  assert.deepEqual(bindings.calls, [["other", true]]);
});
test("a capped or failed page handoff never falls through to replace an occupied screen", () => {
  const bindings = world();
  bindings.pageRegistry.openElsewhere = () => false;
  callback("openNewChat", bindings)("ws", true);
  assert.equal(bindings.calls.length, 1);
  assert.equal(bindings.calls[0][0], "error");
  bindings.calls.length = 0;
  callback("openFromPage", bindings)({ workspaceId: "ws", taskId: "", maxColumns: 5, tried: [1], newScreen: true });
  assert.equal(bindings.calls[0][0], "error");
});
test("lazy destination rechecks strict placement and retains the handoff intent", () => {
  const bindings = world();
  callback("openFromPage", bindings)({ workspaceId: "ws", taskId: "", maxColumns: 5, tried: [1], newScreen: true });
  assert.equal(bindings.calls[0][0], "overflow");
  assert.equal(bindings.calls[0][2].newScreen, true);
  const room = world(ten.slice(0, -1));
  callback("openFromPage", room)({ workspaceId: "ws", taskId: "", maxColumns: 5, tried: [1], newScreen: true });
  assert.deepEqual(room.calls, [["split", "ws", "", { col: 4, row: 1 }]]);
});
test("with nothing saved, a plain New chat on a full page opens on a new page instead of replacing a chat", () => {
  // The user's app on 2026-11-08: ten screens of chats, no page settings ever saved.
  const values = new Map();
  const fresh = load("chat-pages.ts", { localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    window: { addEventListener() {}, removeEventListener() {} } });
  const selected = [];
  const registry = fresh.createChatPageRegistry((page) => selected.push(page), fresh.chatPageLayout({ current: fresh.parseChatPagePreferences(null) }, () => {}));
  registry.register(1, [], () => {}, { room: () => false });
  const bindings = world();
  bindings.focusedSplit = { id: "bottom-4" };
  bindings.pageRegistry = registry;
  callback("openNewChat", bindings)("ws", false);
  assert.deepEqual(bindings.calls, [], "no chat on the full page lost its screen");
  assert.deepEqual(selected, [2], "page 2 opens");
  assert.equal(JSON.parse(values.get("coding-tools:ao:chat-pages")).pageCount, 2);
  assert.deepEqual(plain(registry.takeOpen(2)), { workspaceId: "ws", taskId: "", maxColumns: 5, tried: [1] });
  // Nine screens: room on this page, so New chat stays in the focused pane (the 2026-10-31 rule).
  const room = world(ten.slice(0, -1));
  room.focusedSplit = { id: "bottom-3" };
  room.pageRegistry = registry;
  callback("openNewChat", room)("ws", false);
  assert.deepEqual(room.calls, [["replace", "bottom-3", "ws"]]);
  assert.deepEqual(selected, [2]);
});

test("only explicit Shift overflow enables disabled pages and preserves new-screen metadata", () => {
  let enabled = false, count = 1, enabledCalls = 0;
  const selected = [];
  const registry = pages.createChatPageRegistry((page) => selected.push(page), {
    count: () => enabled ? count : 0, canAdd: () => count < 12,
    enable: () => { enabledCalls++; enabled = true; return true; }, add: () => { count++; return true; },
  });
  const open = { workspaceId: "ws", taskId: "", maxColumns: 5 };
  assert.equal(registry.openElsewhere(1, open), false);
  assert.equal(enabledCalls, 0);
  assert.equal(registry.openElsewhere(1, { ...open, newScreen: true }), true);
  assert.deepEqual(selected, [2]);
  assert.equal(registry.takeOpen(2).newScreen, true);
  assert.equal(registry.takeOpen(2), undefined);
});
test("page registry does not overwrite a chat already waiting on a lazy page", () => {
  let count = 2;
  const registry = pages.createChatPageRegistry(() => {}, { count: () => count, canAdd: () => count < 12, add: () => { count++; return true; } });
  const open = { workspaceId: "one", taskId: "", maxColumns: 5, newScreen: true };
  assert.equal(registry.openElsewhere(1, open), true);
  assert.equal(registry.openElsewhere(1, { ...open, workspaceId: "two" }), true);
  assert.equal(registry.takeOpen(2).workspaceId, "one");
  assert.equal(registry.takeOpen(3).workspaceId, "two");
});
test("failed page enabling or creation leaves existing pages and selections alone", () => {
  const layout = { count: () => 0, enable: () => false, canAdd: () => true, add: () => false };
  const selected = [];
  const registry = pages.createChatPageRegistry((page) => selected.push(page), layout);
  const open = { workspaceId: "ws", taskId: "", maxColumns: 5, newScreen: true };
  assert.equal(registry.openElsewhere(1, open), false);
  layout.count = () => 1;
  assert.equal(registry.openElsewhere(1, open), false);
  assert.deepEqual(selected, []);
});
