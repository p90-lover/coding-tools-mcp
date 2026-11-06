const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function load(file, imports = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => name === "react" || name === "react/jsx-runtime" ? require(name) : imports[name] ?? {} });
  return exports;
}
const changes = load("ChatTurnChanges.tsx");
const scroll = load("ChatScrollToBottom.tsx");
const workbench = load("ChatWorkbench.tsx");
const files = Array.from({ length: 8 }, (_, index) => ({ path: `src/features/file-${index}.tsx`, additions: index + 1, deletions: index }));

function mountCard(input) {
  let expanded = false;
  const exports = {};
  const jsx = (type, props) => typeof type === "function" ? type(props) : { type, props: props ?? {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/ChatTurnChanges.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => name === "react" ? { useState: () => [expanded, value => { expanded = value; }] } : { jsx, jsxs: jsx } });
  return () => exports.ChatTurnChanges(input);
}
const walk = value => !value || typeof value !== "object" ? [] : Array.isArray(value) ? value.flatMap(walk) : [value, ...walk(value.props?.children)];
const rows = tree => walk(tree).filter(item => item.props?.className === "cx-turn-change-file");

 test("Codex's completed-turn file card shows three rows and a functional show-more control", () => {
  const render = mountCard({ files, onOpen() {} });
  const initial = render();
  assert.equal(rows(initial).length, 3);
  const more = walk(initial).find(item => item.props?.className === "cx-turn-changes-more");
  assert.equal(more.props["aria-expanded"], false);
  assert.equal(more.props.children[0].props.children, "Show 5 more files");
  more.props.onClick();
  const expanded = render();
  assert.equal(rows(expanded).length, 8);
  const collapse = walk(expanded).find(item => item.props?.className === "cx-turn-changes-more");
  assert.equal(collapse.props["aria-expanded"], true);
  collapse.props.onClick();
  assert.equal(rows(render()).length, 3);
});

test("file rows open that file, while the summary opens all changed files", () => {
  const calls = [];
  const render = mountCard({ files, onOpen: file => calls.push(file) });
  const tree = render();
  rows(tree)[1].props.onClick();
  walk(tree).find(item => item.props?.className === "cx-turn-changes-open").props.onClick();
  walk(tree).find(item => item.props?.className === "cx-turn-changes-view").props.onClick();
  assert.deepEqual(calls, ["src/features/file-1.tsx", undefined, undefined]);
});

test("a single file uses Edited filename and opens it without a redundant file row", () => {
  const calls = [];
  const tree = mountCard({ files: [{ path: "src\\parser.ts", additions: 7, deletions: 2 }], onOpen: file => calls.push(file) })();
  assert.equal(rows(tree).length, 0);
  walk(tree).find(item => item.props?.className === "cx-turn-changes-open").props.onClick();
  assert.deepEqual(calls, ["src\\parser.ts"]);
  assert.equal(walk(tree).find(item => item.props?.className === "cx-turn-changes-title").props.children, "Edited parser.ts");
});

test("the file card uses Codex's resource rows and totals rather than filename chips", () => {
  const html = renderToStaticMarkup(React.createElement(changes.ChatTurnChanges, { files, onOpen() {} }));
  assert.match(html, /Edited 8 files/);
  assert.match(html, /cx-turn-change-counts/);
  assert.match(html, /\+36/);
  assert.match(html, /-28/);
  assert.match(html, /cx-turn-change-dir/);
  assert.doesNotMatch(html, /cx-reply-file|file-3\.tsx/);
  assert.equal(renderToStaticMarkup(React.createElement(changes.ChatTurnChanges, { files: [] })), "");
});

test("unavailable file navigation is disabled, not a fake View changes action", () => {
  const tree = mountCard({ files })();
  assert.ok(walk(tree).filter(item => item.type === "button" && item.props.className !== "cx-turn-changes-more").every(item => item.props.disabled));
});

test("the bottom control is accessible only while visible and supports the working dots", () => {
  const hidden = renderToStaticMarkup(React.createElement(scroll.ChatScrollToBottom, { show: false, working: false, onClick() {} }));
  assert.match(hidden, /aria-label="Scroll to bottom" aria-hidden="true" tabindex="-1"/);
  const shown = renderToStaticMarkup(React.createElement(scroll.ChatScrollToBottom, { show: true, working: true, onClick() {} }));
  assert.match(shown, /is-visible is-working/);
  assert.match(shown, /cx-scroll-working/);
  assert.match(shown, /cx-scroll-arrow/);
  assert.doesNotMatch(shown, /tabindex="-1"/);
});

test("absolute and Windows paths select the matching worktree diff without matching only a basename", () => {
  assert.equal(workbench.changeTargetPath("G:\\project\\src\\a.ts", ["src/a.ts", "tests/a.ts"]), "src/a.ts");
  assert.equal(workbench.changeTargetPath("src/a.ts", ["src/a.ts", "tests/a.ts"]), "src/a.ts");
  assert.equal(workbench.changeTargetPath("elsewhere/a.ts", ["src/a.ts", "tests/a.ts"]), "elsewhere/a.ts");
});
