"use strict";

// Claude Code's split view for chats: the grid rules (chat-split.ts) and the host that draws them (ChatSplit.tsx).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const ts = require(require.resolve("typescript", { paths: [root] }));
const React = require(require.resolve("react", { paths: [root] }));
const { renderToStaticMarkup } = require(require.resolve("react-dom/server", { paths: [root] }));

const load = (file, modules = {}, globals = {}) => {
  const exports = {};
  const source = fs.readFileSync(path.resolve(root, "src/features", file), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const local = (name) => modules[name] ?? require(require.resolve(name, { paths: [root] }));
  vm.runInNewContext(output, { exports, require: local, console, window: globalThis, ...globals });
  return exports;
};
const split = load("chat-split.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const pane = (id, col, row, taskId = id) => ({ id, workspaceId: "ws", taskId, col, row });

test("one column per 360 px of width, from one up to five", () => {
  assert.deepEqual([300, 720, 1079, 1080, 4000].map(split.splitMaxColumns), [1, 2, 2, 3, 5]);
});

test("a new pane takes a new column while one fits, then a free bottom row, then the last chat's place", () => {
  assert.deepEqual(plain(split.defaultPlace([], 2)), { col: 1, row: 0 }, "the first pane goes to the right of the window's chat");
  const two = [pane("a", 1, 0)];
  assert.deepEqual(plain(split.defaultPlace(two, 2)), { col: 0, row: 1 }, "two columns full: below the window's chat");
  assert.deepEqual(plain(split.defaultPlace(two, 3)), { col: 2, row: 0 }, "a wider window gets a third column");
  const full = [pane("a", 1, 0), pane("b", 0, 1), pane("c", 1, 1)];
  assert.deepEqual(plain(split.defaultPlace(full, 2)), { replace: "c" }, "every cell taken: the last chat makes way");
  assert.deepEqual(plain(split.defaultPlace([pane("a", 1, 0), pane("b", 0, 1), pane("draft", 1, 1, "")], 2)), { replace: "a" },
    "a new chat not sent yet is not replaced while a pane with a chat can be");
  assert.deepEqual(plain(split.belowPlace([pane("a", 1, 0)], { col: 1, row: 0 }, 2)), { col: 1, row: 1 }, "New chat below: under the focused pane");
});

test("a page has room for a chat until all ten screens hold one", () => {
  const ten = [pane("a", 0, 1), ...[1, 2, 3, 4].flatMap((col) => [pane(`t${col}`, col, 0), pane(`b${col}`, col, 1)])];
  assert.equal(ten.length + 1, 10, "five columns of two, the window's chat included");
  assert.equal(split.splitHasRoom(ten, 5, "main-chat"), false, "every screen a chat: full");
  assert.equal(split.splitHasRoom(ten, 5, ""), true, "the window's chat not sent yet: a new chat can go there");
  assert.equal(split.splitHasRoom(ten.map((item) => item.id === "b4" ? { ...item, taskId: "" } : item), 5, "main-chat"), true,
    "a pane with an unsent chat is room");
  assert.equal(split.splitHasRoom(ten.filter((item) => item.id !== "b4"), 5, "main-chat"), true, "a free cell is room");
  assert.equal(split.splitHasRoom([], 5, "main-chat"), true, "one chat alone");
  assert.equal(split.splitHasRoom([pane("a", 1, 0), pane("b", 0, 1), pane("c", 1, 1)], 2, "main-chat"), false,
    "a narrow window's page fills at its own column count");
});

test("closing a pane leaves no gap: columns close up and a lone bottom pane moves to the top", () => {
  assert.deepEqual(plain(split.normalizeSplit([pane("b", 2, 0), pane("c", 2, 1)]).map((item) => [item.id, item.col, item.row])),
    [["b", 1, 0], ["c", 1, 1]]);
  assert.deepEqual(plain(split.normalizeSplit([pane("a", 1, 1)]).map((item) => [item.col, item.row])), [[1, 0]]);
  assert.deepEqual(plain(split.normalizeSplit([pane("a", 0, 1)]).map((item) => [item.col, item.row])), [[0, 1]],
    "below the window's own chat stays below it");
});

test("drop zones are Claude Code's: a new column on the last column's right half, the left band of the window's chat, any other cell", () => {
  const at = (x, y, weights = [1], maxColumns = 3) => plain(split.splitDropTarget({ x, y, width: 1200, height: 800, weights, rowSplit: 0.5, maxColumns }));
  assert.deepEqual(at(900, 100), { kind: "column" }, "right half of the only column");
  assert.deepEqual(at(100, 100), { kind: "left" }, "the band from 16 px to a third of the window's chat");
  assert.equal(at(10, 100), null, "the first 16 px are no target");
  assert.equal(at(500, 100), null, "nor is the rest of the window's chat");
  assert.deepEqual(at(500, 600), { kind: "cell", col: 0, row: 1 }, "its lower half is the cell below it");
  assert.deepEqual(at(900, 100, [1, 1]), { kind: "column" }, "two columns of three: the second's right half adds a third");
  assert.deepEqual(at(700, 100, [1, 1]), { kind: "cell", col: 1, row: 0 });
  assert.deepEqual(at(1100, 100, [1, 1], 2), { kind: "cell", col: 1, row: 0 }, "no new column once the window is full");
  assert.equal(at(100, 100, [1, 1], 2), null, "nor a chat in front of the window's own");
});

test("the drop badge says Open here over a chat and Split view over a new or empty place, 8 px inside it", () => {
  const panes = [pane("a", 1, 0)];
  assert.deepEqual(plain(split.splitBadge({ kind: "cell", col: 1, row: 0 }, panes, [1, 1])), { left: 50, width: 50, band: "full", label: "Open here" });
  assert.deepEqual(plain(split.splitBadge({ kind: "cell", col: 1, row: 1 }, panes, [1, 1])), { left: 50, width: 50, band: "bottom", label: "Split view" });
  assert.deepEqual(plain(split.splitBadge({ kind: "cell", col: 1, row: 0 }, [...panes, pane("b", 1, 1)], [1, 1])).band, "top");
  assert.deepEqual(plain(split.splitBadge({ kind: "column" }, panes, [1, 1])), { left: 200 / 3, width: 100 / 3, band: "full", label: "Split view" });
});

test("saved column widths hold while every column keeps 320 px; the row split stays between 15% and 85%", () => {
  assert.deepEqual(plain(split.splitWeights([2, 1], 2, 1200)), [2, 1]);
  assert.deepEqual(plain(split.splitWeights([5, 1], 2, 1200)), [1, 1], "a column under 320 px resets them all");
  assert.deepEqual(plain(split.splitWeights([1, 1], 3, 1200)), [1, 1, 1], "another column count starts equal");
  assert.equal(split.clampRowSplit(0.01, 4000), 0.15);
  assert.equal(split.clampRowSplit(0.99, 4000), 0.85);
  assert.equal(split.clampRowSplit(0.2, 800), 0.4, "each row keeps 320 px");
  assert.equal(split.clampRowSplit(0.99, 800), 0.6, "the bottom row also keeps 320 px");
  for (const value of [0.01, 0.5, 0.99]) assert.equal(split.clampRowSplit(value, 500), 0.5, "an undersized host shares the space equally");
  assert.equal(split.clampRowSplit(0.01, 0), 0.15, "unmeasured height keeps the ratio bounds");
  assert.equal(split.clampRowSplit(0.99, 0), 0.85);
});

test("Ctrl+] and Ctrl+[ step through panes by column and row; Ctrl+Alt+Arrow finds the pane that way", () => {
  const panes = [pane("c", 1, 1), pane("b", 1, 0), pane("d", 0, 1)];
  assert.deepEqual(plain(split.focusOrder(panes)), ["main", "d", "b", "c"]);
  assert.equal(split.spatialNeighbour(panes, "main", "right"), "b");
  assert.equal(split.spatialNeighbour(panes, "main", "down"), "d");
  assert.equal(split.spatialNeighbour(panes, "c", "up"), "b");
  assert.equal(split.spatialNeighbour(panes, "c", "left"), "d");
  assert.equal(split.spatialNeighbour(panes, "main", "left"), undefined);
});

test("only chats are kept between runs, each in one place", () => {
  const saved = split.readSplit(JSON.stringify({ panes: [
    { workspaceId: "ws", taskId: "a", col: 1, row: 0 },
    { workspaceId: "ws", taskId: "", col: 2, row: 0 },
    { workspaceId: "ws", taskId: "b", col: 1, row: 0 },
    { workspaceId: "ws", taskId: "a", col: 2, row: 0 },
    { workspaceId: "ws", taskId: "c", col: 0, row: 0 },
    { workspaceId: "ws", taskId: "d", col: 0, row: 1 },
  ], weights: [2, 1], rowSplit: 0.95 }));
  assert.deepEqual(plain(saved), { panes: [{ workspaceId: "ws", taskId: "a", col: 1, row: 0 }, { workspaceId: "ws", taskId: "d", col: 0, row: 1 }],
    weights: [2, 1], rowSplit: 0.85 });
  assert.deepEqual(plain(split.readSplit("not json")), { panes: [] });
});

test("the host draws the window's chat and its panes in Claude Code's grid, with dividers and a dimmed unfocused pane", () => {
  const { ChatSplit } = load("ChatSplit.tsx", { "./chat-split": split });
  const html = renderToStaticMarkup(React.createElement(ChatSplit, {
    focused: "b", onFocus() {}, rowSplit: 0.5, maxColumns: 3,
    panes: [{ ...pane("b", 1, 0), content: React.createElement("p", null, "pane b") }, { ...pane("c", 1, 1), content: React.createElement("p", null, "pane c") }],
  }, React.createElement("p", null, "window chat")));
  assert.match(html, /class="cx-split" data-split=""/);
  assert.match(html, /<div class="cx-pane" data-col="0" data-row="0" role="region" aria-label="Primary pane" data-pane-immovable="" style="grid-column:1;grid-row:1 \/ span 2">/);
  assert.match(html, /aria-label="Secondary pane" aria-current="true" data-focused=""/, "the focused pane says so; the others are dimmed by CSS");
  assert.match(html, /aria-label="Resize pane columns"/);
  assert.match(html, /aria-label="Resize pane rows"/, "column 1 has a top and a bottom pane");
  const single = renderToStaticMarkup(React.createElement(ChatSplit, { focused: "main", onFocus() {}, rowSplit: 0.5, maxColumns: 2, panes: [] },
    React.createElement("p", null, "window chat")));
  assert.doesNotMatch(single, /role="region"|separator|data-split/, "one chat alone is no split: no regions, no dividers");
});

test("a pane dragged by its grip moves: a new column, an empty cell, or trading places", () => {
  const panes = [pane("b", 1, 0), pane("c", 1, 1), pane("d", 2, 0)];
  const at = (list) => Object.fromEntries(list.map((item) => [item.id, `${item.col}:${item.row}`]));
  assert.deepEqual(at(split.movePane(panes, "c", { kind: "column" })), { b: "1:0", c: "3:0", d: "2:0" }, "a new column at the end");
  assert.deepEqual(at(split.movePane(panes, "d", { kind: "cell", col: 1, row: 0 })), { b: "2:0", c: "1:1", d: "1:0" }, "onto a pane: the two trade places");
  assert.deepEqual(at(split.movePane(panes, "c", { kind: "cell", col: 2, row: 1 })), { b: "1:0", c: "2:1", d: "2:0" }, "into an empty bottom cell");
  assert.deepEqual(at(split.movePane([pane("b", 1, 0), pane("c", 1, 1)], "b", { kind: "cell", col: 1, row: 1 })), { b: "1:1", c: "1:0" }, "top and bottom swap");
  // A lone pane leaving its column closes the gap it left.
  assert.deepEqual(at(split.movePane([pane("b", 1, 0), pane("d", 2, 0)], "b", { kind: "cell", col: 2, row: 1 })), { b: "1:1", d: "1:0" });
  assert.equal(split.movePane(panes, "b", { kind: "cell", col: 1, row: 0 }), null, "its own cell: no move");
  assert.equal(split.movePane(panes, "b", { kind: "cell", col: 0, row: 0 }), null, "the primary's cell is not a target");
  assert.equal(split.movePane(panes, "b", { kind: "left" }), null, "the window makes a chat dropped left its own");
  assert.equal(split.movePane([pane("b", 1, 0)], "b", { kind: "column" }), null, "the last column's only pane stays");
});

test("an open chat dragged from the sidebar to another place opens there and its old pane closes", () => {
  const panes = [pane("b", 1, 0), pane("c", 1, 1), pane("d", 2, 0)];
  const at = (list) => Object.fromEntries(list.map((item) => [item.id, `${item.col}:${item.row}`]));
  assert.deepEqual(at(split.relocatePane(panes, "c", { kind: "cell", col: 2, row: 0 })), { b: "1:0", c: "2:0" },
    "onto another chat: that chat closes, and the chat leaves its old cell");
  assert.deepEqual(at(split.relocatePane(panes, "c", { kind: "cell", col: 2, row: 1 })), { b: "1:0", c: "2:1", d: "2:0" }, "into an empty cell");
  assert.deepEqual(at(split.relocatePane(panes, "c", { kind: "column" })), { b: "1:0", c: "3:0", d: "2:0" }, "into a new column");
  // Its old column closes when the chat was the only one in it.
  assert.deepEqual(at(split.relocatePane([pane("b", 1, 0), pane("d", 2, 0)], "b", { kind: "cell", col: 2, row: 1 })), { b: "1:1", d: "1:0" });
  assert.equal(split.relocatePane(panes, "b", { kind: "cell", col: 1, row: 0 }), null, "its own cell: no change");
  assert.equal(split.relocatePane(panes, "b", { kind: "cell", col: 0, row: 0 }), null, "the primary's cell is not a target");
  assert.equal(split.relocatePane(panes, "b", { kind: "left" }), null, "left is the window's pane move");
  // The window uses it: an open chat dropped somewhere else moves instead of only being focused.
  const surface = fs.readFileSync(path.join(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8");
  assert.match(surface, /relocatePane\(splitPanes, open, at\)/);
  assert.match(surface, /if \(open === "main" && at && "kind" in at && at\.kind !== "left"\) \{ moveMainChat\(at\); return; \}/);
});

test("a movable split gives each other pane a Move grip and a corner where dividers meet", () => {
  const { ChatSplit } = load("ChatSplit.tsx", { "./chat-split": split });
  const render = (props) => renderToStaticMarkup(React.createElement(ChatSplit, {
    focused: "main", onFocus() {}, rowSplit: 0.5, maxColumns: 3,
    panes: [{ ...pane("b", 1, 0), content: "b" }, { ...pane("c", 1, 1), content: "c" }], ...props,
  }, "window chat"));
  const html = render({ onMovePane() {} });
  assert.equal(html.match(/class="cx-pane-grip" title="Move"/g)?.length, 2, "one grip on each pane but the window's own");
  assert.equal(html.match(/data-pane-immovable/g)?.length, 1, "only the window's own pane stays put");
  assert.match(html, /class="cx-split-corner" aria-hidden="true" style="left:50%"/, "column 1 is split, so the divider before it has a corner");
  assert.doesNotMatch(render({}), /cx-pane-grip/, "without onMovePane, nothing moves");
  assert.doesNotMatch(render({ panes: [{ ...pane("b", 1, 0), content: "b" }] }), /cx-split-corner/, "no row divider, no corner");
});

function splitHost(initial = {}) {
  const slots = [], effects = [], pending = [], listeners = [], rows = [], moves = [], drops = [];
  let cursor, tree, dirty, size = { width: 1000, height: 800 }, observe;
  const host = { dataset: {}, getBoundingClientRect: () => ({ left: 0, top: 0, ...size }) };
  const effect = (work, deps, phase) => {
    const index = cursor++, before = effects[index];
    if (!before || deps.some((value, i) => !Object.is(value, before.deps[i]))) pending.push({ phase, work: () => {
      before?.cleanup?.(); effects[index] = { deps, phase, cleanup: work() };
    } });
  };
  const hooks = { ...React,
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = typeof value === "function" ? value() : value;
      return [slots[index], next => { const value = typeof next === "function" ? next(slots[index]) : next;
        if (!Object.is(value, slots[index])) { slots[index] = value; dirty = true; } }]; },
    useRef: value => slots[cursor++] ??= { current: value },
    useEffect: (work, deps) => effect(work, deps, 1), useLayoutEffect: (work, deps) => effect(work, deps, 0),
  };
  const window = {
    addEventListener(type, fn, capture = false) { listeners.push({ type, fn, capture }); },
    removeEventListener(type, fn, capture = false) { const index = listeners.findIndex(item => item.type === type && item.fn === fn && item.capture === capture); if (index >= 0) listeners.splice(index, 1); },
  };
  const { ChatSplit } = load("ChatSplit.tsx", { "./chat-split": split, react: hooks }, { window, clearTimeout, setTimeout,
    ResizeObserver: class { constructor(work) { observe = work; } observe() { observe([{ contentRect: size }]); } disconnect() {} },
  });
  const props = { focused: "main", onFocus() {}, rowSplit: 0.85, onRowSplit: value => rows.push(value), maxColumns: 2,
    onMovePane: (...args) => moves.push(plain(args)), onDropChat: (...args) => drops.push(plain(args)),
    panes: [{ ...pane("b", 0, 1), content: "b" }], ...initial };
  const nodes = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  const render = (next = {}) => {
    Object.assign(props, next);
    for (let pass = 0; pass < 10; pass++) {
      cursor = 0; dirty = false; tree = ChatSplit(props); tree.props.ref.current = host;
      for (const item of pending.splice(0).sort((a, b) => a.phase - b.phase)) item.work();
      if (!dirty) return tree;
    }
    throw new Error("split host hooks did not settle");
  };
  const emit = (type, event = {}) => { for (const item of [...listeners]) if (item.type === type && listeners.includes(item)) item.fn(event); };
  const find = label => nodes(tree).find(node => node.props?.["aria-label"] === label);
  return { render, find, rows, moves, drops, listeners, emit,
    resize(height) { size = { ...size, height }; observe([{ contentRect: size }]); return render(); },
    start(pointerId = 1) { const grip = nodes(tree).find(node => node.props?.className === "cx-pane-grip"); assert.ok(grip);
      grip.props.onPointerDown({ button: 0, pointerId, clientX: 500, clientY: 650, preventDefault() {},
        currentTarget: { closest: () => ({ querySelector: () => ({ textContent: "Pane b" }) }) } }); },
    unmount() { for (const item of effects.filter(Boolean).sort((a, b) => a.phase - b.phase)) { if (item.phase === 1) tree.props.ref.current = null; item.cleanup?.(); } tree.props.ref.current = null; },
  };
}

test("a restored row ratio adapts to the measured height for rendering, keys and drop targets", () => {
  const ui = splitHost();
  ui.render();
  assert.equal(ui.resize(4000).props.style["--cx-pane-row"], 0.85, "a tall host keeps its saved ratio");
  const tree = ui.resize(800);
  assert.equal(tree.props.style["--cx-pane-row"], 0.6, "a smaller host clamps the saved ratio before drawing");
  assert.equal(ui.find("Resize pane rows").props["aria-valuenow"], 60);
  ui.find("Resize pane rows").props.onKeyDown({ key: "ArrowUp", preventDefault() {} });
  assert.equal(ui.rows.at(-1), 0.59, "keys start from the displayed divider rather than the saved ratio");
  tree.props.onDrop({ clientX: 450, clientY: 550, preventDefault() {}, dataTransfer: {
    getData: () => JSON.stringify({ workspaceId: "ws", taskId: "other" }),
  } });
  assert.deepEqual(ui.drops, [[{ workspaceId: "ws", taskId: "other" }, { kind: "cell", col: 0, row: 1 }]], "drop geometry uses the displayed lower row");
  assert.equal(ui.resize(500).props.style["--cx-pane-row"], 0.5);
  ui.unmount();
});

test("pane moves release their listeners and never commit after unmount, disabling moves or blur", () => {
  for (const end of ["unmount", "disabled", "blur"]) {
    const ui = splitHost(); ui.render(); ui.start();
    ui.emit("pointermove", { pointerId: 1, clientX: 750, clientY: 650 }); ui.render();
    assert.equal(ui.listeners.filter(item => item.capture).length, 4, end);
    if (end === "unmount") ui.unmount();
    else if (end === "disabled") ui.render({ onMovePane: undefined });
    else ui.emit("blur");
    assert.equal(ui.listeners.filter(item => item.capture).length, 0, end);
    assert.doesNotThrow(() => ui.emit("pointermove", { pointerId: 1, clientX: 780, clientY: 650 }), end);
    ui.emit("pointerup", { pointerId: 1 });
    assert.deepEqual(ui.moves, [], end);
    if (end !== "unmount") ui.unmount();
  }
});

test("a second grip press cancels the first move while the current pointer can still commit once", () => {
  const ui = splitHost(); ui.render(); ui.start();
  ui.emit("pointermove", { pointerId: 1, clientX: 750, clientY: 650 }); ui.render();
  ui.start(2);
  assert.equal(ui.listeners.filter(item => item.capture).length, 4, "only the current gesture owns window listeners");
  ui.emit("pointerup", { pointerId: 1 });
  assert.deepEqual(ui.moves, [], "the old pointer cannot commit its captured target");
  ui.emit("pointermove", { pointerId: 2, clientX: 760, clientY: 650 });
  ui.emit("pointerup", { pointerId: 2 });
  ui.emit("pointerup", { pointerId: 2 });
  assert.deepEqual(ui.moves, [["b", { kind: "column" }]]);
  assert.equal(ui.listeners.filter(item => item.capture).length, 0);
  ui.unmount();
});

test("pane topology changes cancel captured moves while ordinary content renders keep them active", () => {
  const b = { ...pane("b", 0, 1), content: "b" }, c = { ...pane("c", 1, 0), content: "c" };
  for (const [name, panes] of [
    ["dragged pane removed", [c]],
    ["another pane added", [b, c, { ...pane("d", 1, 1), content: "d" }]],
    ["another pane removed", [b]],
    ["pane moved", [{ ...b, col: 1, row: 1 }, c]],
    ["pane task replaced", [{ ...b, taskId: "new-task" }, c]],
    ["pane workspace replaced", [{ ...b, workspaceId: "new-workspace" }, c]],
  ]) {
    const ui = splitHost({ panes: [b, c] }); ui.render(); ui.start();
    ui.emit("pointermove", { pointerId: 1, clientX: 750, clientY: 650 }); ui.render();
    ui.render({ panes });
    assert.equal(ui.listeners.filter(item => item.capture).length, 0, name);
    ui.emit("pointerup", { pointerId: 1 });
    assert.deepEqual(ui.moves, [], name);
    ui.unmount();
  }
  const ui = splitHost({ panes: [b, c] }); ui.render(); ui.start();
  ui.emit("pointermove", { pointerId: 1, clientX: 750, clientY: 650 }); ui.render();
  ui.render({ panes: [b, c].map(item => ({ ...item, content: "refreshed content" })) });
  assert.equal(ui.listeners.filter(item => item.capture).length, 4, "fresh objects and content keep the same topology");
  ui.emit("pointerup", { pointerId: 1 });
  assert.equal(ui.moves.length, 1, "the unchanged gesture still commits once");
  ui.unmount();
});
