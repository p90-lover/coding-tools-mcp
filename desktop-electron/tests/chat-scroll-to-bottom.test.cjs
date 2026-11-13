const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function load(file) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => require(name) });
  return exports;
}
const { ChatScrollToBottom } = load("ChatScrollToBottom.tsx");
const render = props => renderToStaticMarkup(React.createElement(ChatScrollToBottom, { show: true, working: false, onClick() {}, ...props }));

test("the bottom control is accessible only while visible and supports the working dots", () => {
  const hidden = render({ show: false });
  assert.match(hidden, /aria-label="Scroll to bottom" aria-hidden="true" tabindex="-1"/);
  assert.doesNotMatch(hidden, /is-visible/);
  const shown = render({ working: true });
  assert.match(shown, /is-visible is-working/);
  assert.match(shown, /cx-scroll-working/);
  assert.match(shown, /cx-scroll-arrow/);
  assert.doesNotMatch(shown, /tabindex="-1"|aria-hidden="true" tabindex/);
  assert.doesNotMatch(render({}), /cx-scroll-working/);
});

test("the working dots only move while the control shows", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../src/features/codex-chat.css"), "utf8");
  assert.match(css, /\.cx-scroll-working > span \{[^}]*animation: cx-scroll-dot-wave 1\.2s ease-in-out infinite;/);
  // At the bottom of a working chat the control is faded out but still mounted: its dots stand still.
  assert.match(css, /\.cx-to-bottom:not\(\.is-visible\) \.cx-scroll-working > span \{ animation: none; \}/);
  assert.match(render({ show: false, working: true }), /class="cx-to-bottom is-working"[\s\S]*cx-scroll-working/);
});

test("it rises above the approval dock and otherwise keeps its CSS place", () => {
  assert.doesNotMatch(render({}), /style=/);
  assert.doesNotMatch(render({ lift: 0 }), /style=/);
  assert.match(render({ lift: 140 }), /style="bottom:140px"/);
});

test("the hidden control ignores clicks", () => {
  let clicks = 0;
  const element = ChatScrollToBottom({ show: false, working: false, onClick: () => { clicks += 1; } });
  const button = element.props.children;
  assert.equal(button.props.onClick, undefined);
  const visible = ChatScrollToBottom({ show: true, working: false, onClick: () => { clicks += 1; } }).props.children;
  visible.props.onClick();
  assert.equal(clicks, 1);
});

test("the chat mounts the control outside the scroller, lifted over the approval dock", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
  assert.match(source, /<ChatScrollToBottom show=\{!atBottom\} working=\{anyWorking\} lift=\{dockHeight \? dockHeight \+ 20 : 0\}/);
  assert.doesNotMatch(source, /className="cx-to-bottom"/);
  const css = fs.readFileSync(path.resolve(__dirname, "../src/features/codex-chat.css"), "utf8");
  assert.match(css, /\.cx-scroll-bottom-anchor \{[^}]*height: 0/);
  assert.doesNotMatch(css, /\.cx-to-bottom \{[^}]*position: sticky/);
});

test("following stops only when the view moves up, as in Codex, and a send re-arms it", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
  const scroller = source.slice(source.indexOf('<div className="cx-scroll" ref={scroller}'), source.indexOf("onScroll={(event) => {"));
  // A wheel down (or any wheel at the bottom, which fires no scroll event) keeps following.
  assert.match(scroller, /onWheel=\{\(event\) => \{[^}]*if \(event\.deltaY < 0\) following\.current = false;/);
  // A touch or a click in the thread moves nothing; only the scrollbar itself stops following.
  assert.match(scroller, /onTouchStart=\{\(\) => \{ jumpingToBottom\.current = false; \}\}/);
  assert.match(scroller, /if \(event\.target === event\.currentTarget\) following\.current = false;/);
  assert.equal((scroller.match(/following\.current = false/g) || []).length, 2);
  // A send and a new request follow the thread again, not only set atBottom.
  assert.match(source, /const followBottom = \(\) => \{\s*jumpingToBottom\.current = false;\s*following\.current = true;\s*setAtBottom\(true\);/);
  assert.match(source, /if \(here\(\)\) followBottom\(\);/);
  assert.match(source, /if \(!requestKeys\) return;\s*followBottom\(\);/);
  assert.doesNotMatch(source, /if \(here\(\)\) setAtBottom\(true\);/);
});
