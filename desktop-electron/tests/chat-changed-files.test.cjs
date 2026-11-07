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
  }).outputText, { exports, setTimeout, clearTimeout, require: name => imports[name] ?? (name === "react" || name === "react/jsx-runtime" ? require(name) : {}) });
  return exports;
}
const changes = load("ChatChangedFiles.tsx");
const files = [
  { path: "G:\\project\\src\\index.ts", additions: 7, deletions: 2 },
  { path: "G:\\project\\tests\\index.ts", additions: 3, deletions: 0 },
];
const walk = value => !value || typeof value !== "object" ? [] : Array.isArray(value) ? value.flatMap(walk) : [value, ...walk(value.props?.children)];

function mount(props) {
  let state = [], refs = [], cursor = 0, refCursor = 0;
  const jsx = (type, props) => typeof type === "function" ? type(props) : { type, props: props ?? {} };
  const ui = load("ChatChangedFiles.tsx", {
    react: {
      useState(initial) { const at = cursor++; if (!(at in state)) state[at] = initial; return [state[at], value => { state[at] = value; }]; },
      useRef(initial) { const at = refCursor++; return refs[at] ?? (refs[at] = { current: initial }); },
      useEffect() {}, useLayoutEffect() {}, useId: () => "changes-test",
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
  });
  return () => { cursor = refCursor = 0; return ui.ChatChangedFiles(props); };
}

test("one compact accessible summary replaces both the path-title tooltip and inline file box", () => {
  const html = renderToStaticMarkup(React.createElement(changes.ChatChangedFiles, { files }));
  assert.match(html, /aria-label="2 files changed, 10 lines added, 2 lines removed"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /\+10/);
  assert.match(html, /−2/);
  assert.doesNotMatch(html, /title=|index\.ts|cx-reply-files|cx-turn-changes|role="dialog"/);
  assert.equal(renderToStaticMarkup(React.createElement(changes.ChatChangedFiles, { files: [] })), "");
});

test("hover and keyboard focus open details with the full path and counts for every file", () => {
  const render = mount({ files: [...files, ...Array.from({ length: 20 }, (_, index) => ({ path: `src/file-${index}.ts`, additions: index, deletions: 1 }))] });
  const trigger = walk(render()).find(item => item.type === "button");
  trigger.props.onPointerEnter({ pointerType: "mouse" });
  const tree = render();
  const panel = walk(tree).find(item => item.props.role === "dialog");
  assert.equal(panel.props.popover, "manual", "uses the unclipped top layer, not an absolutely positioned child of the scroll pane");
  assert.equal(walk(tree).filter(item => item.type === "li").length, 22, "the list is scrollable, not truncated");
  assert.match(JSON.stringify(tree), /G:\/project\/src\//);
  assert.match(JSON.stringify(tree), /G:\/project\/tests\//);
  assert.match(JSON.stringify(tree), /file-19\.ts/);
  assert.doesNotMatch(JSON.stringify(tree), /View all changes/, "no pretend navigation when the workbench isn't available");
  const focus = mount({ files });
  walk(focus()).find(item => item.type === "button").props.onFocus();
  assert.ok(walk(focus()).some(item => item.props.role === "dialog"));
});

test("touch and click can open the card without requiring hover", () => {
  const render = mount({ files });
  const trigger = walk(render()).find(item => item.type === "button");
  trigger.props.onPointerEnter({ pointerType: "touch" });
  assert.ok(!walk(render()).some(item => item.props.role === "dialog"));
  trigger.props.onClick();
  assert.ok(walk(render()).some(item => item.props.role === "dialog"));
});

test("file navigation preserves the original Windows path and dismisses the popup", () => {
  const calls = [];
  const render = mount({ files, onOpen: file => calls.push(file) });
  walk(render()).find(item => item.type === "button").props.onClick();
  const row = walk(render()).find(item => item.type === "button" && item.props.className === "cx-changed-file");
  row.props.onClick();
  assert.deepEqual(calls, [files[0].path]);
  assert.ok(!walk(render()).some(item => item.props.role === "dialog"));
  walk(render()).find(item => item.type === "button").props.onClick();
  walk(render()).find(item => item.type === "button" && item.props.className === undefined).props.onClick();
  assert.deepEqual(calls, [files[0].path, undefined]);
});

test("placement flips above the footer and stays inside a narrow viewport", () => {
  const pos = changes.changedFilesPosition({ left: 240, right: 310, top: 670, bottom: 696 }, 304, 400, { width: 320, height: 720 });
  assert.equal(pos.left, 8);
  assert.equal(pos.top, 264);
  assert.equal(pos.maxHeight, 400);
  const below = changes.changedFilesPosition({ left: 20, right: 100, top: 20, bottom: 46 }, 304, 120, { width: 320, height: 720 });
  assert.equal(below.top, 52);
  assert.equal(below.left, 8);
  const short = changes.changedFilesPosition({ left: 20, right: 100, top: 80, bottom: 106 }, 304, 400, { width: 320, height: 200 });
  assert.ok(short.top >= 8);
  assert.ok(short.top + short.maxHeight <= 192);
});

test("the reply renders only the compact changed-file control beside runtime, including for a single file", () => {
  const head = load("ChatReplyHead.tsx", { "./ChatChangedFiles": changes, "./HarnessLogo": { ModelLogo: () => null }, "./ao-chat": { dshDuration: () => "1m" },
    "./ChatTurnStats": { useTurnRequests: () => ({ ref: { current: null }, summary: "" }) } });
  for (const selected of [files, files.slice(0, 1), []]) {
    const html = renderToStaticMarkup(React.createElement(head.ReplyHead, { team: false, name: "Agent", tone: "done", startedAtMs: 1000, endedAtMs: 61000, members: [], changes: selected }));
    assert.doesNotMatch(html, /cx-reply-files|cx-turn-changes|title="G:/);
    assert.equal((html.match(/cx-changed-files-trigger/g) ?? []).length, selected.length ? 1 : 0);
    if (selected.length) assert.match(html, /cx-reply-time[^>]*>1m<\/span><span class="cx-changed-files"/);
  }
});
