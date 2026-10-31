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

const load = (file, modules = {}) => {
  const exports = {};
  const source = fs.readFileSync(path.resolve(root, "src/features", file), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const local = (name) => modules[name] ?? require(require.resolve(name, { paths: [root] }));
  vm.runInNewContext(output, { exports, require: local, console, window: globalThis });
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
