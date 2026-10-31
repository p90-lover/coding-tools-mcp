"use strict";

// A chat agent asking to control a window is asked on a card in that chat (ComputerControlCard.tsx),
// not in a window of its own that took the focus.
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
  vm.runInNewContext(output, { exports, require: local, console });
  return exports;
};
const card = load("ComputerControlCard.tsx", { "../api/client": { getCodingToolsClient: () => { throw new Error("no preload"); } } });
const request = (over = {}) => ({ id: "r1", workspaceId: "ws", sessions: ["s1"], chat: "codex (session s1)", project: "proj", captureOff: true,
  windows: [{ title: "<img src=x onerror=alert(1)>", pid: 70 }], durations: [{ id: "900", label: "15 minutes" }], ...over });

test("a request shows in the chat whose agent asked, and in no other", () => {
  const ids = (list) => list.map((item) => item.id);
  assert.deepEqual(ids(card.chatComputerRequests([request()], ["s1", "s9"], "ws")), ["r1"]);
  assert.deepEqual(ids(card.chatComputerRequests([request()], ["s2"], "ws")), [], "another chat of the same project does not show it");
  assert.deepEqual(ids(card.chatComputerRequests([request({ sessions: ["s1", "s2"] })], ["s2"], "ws")), ["r1"], "a chat that joined the request shows it too");
  assert.deepEqual(ids(card.chatComputerRequests([request({ sessions: [] })], [], "ws")), ["r1"], "before its agent had a session: the project's chat");
  assert.deepEqual(ids(card.chatComputerRequests([request({ sessions: [] })], [], "other")), []);
});

test("the card names who asks, lists each window as text, and asks for the capture tick", () => {
  const html = renderToStaticMarkup(React.createElement(card.ComputerControlCard, { request: request() }));
  assert.match(html, /Let the agent control a window\?/);
  assert.match(html, /codex \(session s1\) asked to control your screen in proj/);
  assert.ok(!html.includes("<img src=x"), "a window title is text, never markup");
  assert.match(html, /role="radio" aria-checked="false"/);
  assert.match(html, /Turn on screen capture for proj/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Start<\/button>/, "Start waits for a window (and the tick)");
  assert.match(html, /<option value="900"[^>]*>15 minutes<\/option>/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(card.ComputerControlCard, { request: request({ captureOff: false }) })), /screen capture/);
});
