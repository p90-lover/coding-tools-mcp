const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

// Hooks as plain calls: state keeps its initial value and effects do not run, so a render is
// only what the component reads while it renders.
const react = { useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}], useEffect() {}, useRef: (current) => ({ current }) };
const annotations = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/ChatAnnotations.tsx"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports: annotations, document: { body: {} }, window: { innerWidth: 1000, innerHeight: 800 }, require: (name) => name === "react" ? react : name === "react-dom" ? { createPortal: (node) => node }
  : name === "react/jsx-runtime" ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "Fragment" } : {} });

// Seen 2026-10-28 on 0.8.29: with no annotation in any chat, SelectionAnnotator read the
// transcript's bounds on every render. Each read laid out the whole window (82k elements, five
// panes), 7.4 s of the renderer's 10 s, hidden or not, while chats worked.
test("with nothing to show, a render reads no layout", () => {
  let reads = 0;
  const area = { getBoundingClientRect() { reads += 1; return { top: 0, bottom: 100, left: 0, right: 100 }; }, closest: () => null };
  const view = annotations.SelectionAnnotator({ root: { current: area }, annotations: [], onAdd: () => 0, onComment() {} });
  assert.equal(view, null);
  assert.equal(reads, 0, "no getBoundingClientRect while there is no annotation, selection bar or note editor");
});
