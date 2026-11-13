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
  assert.match(source, /className="cx-scroll" ref=\{scroller\} role="region" aria-label="Chat messages" tabIndex=\{0\}/);
  const css = fs.readFileSync(path.resolve(__dirname, "../src/features/codex-chat.css"), "utf8");
  assert.match(css, /\.cx-scroll-bottom-anchor \{[^}]*height: 0/);
  assert.doesNotMatch(css, /\.cx-to-bottom \{[^}]*position: sticky/);
});

const chatSource = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorChat.tsx"), "utf8");
const chatAst = ts.createSourceFile("chat.tsx", chatSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const scrollHandlers = {};
let clickHandler = "() => {}";
function visit(node) {
  if (ts.isJsxOpeningElement(node)) {
    const attributes = node.attributes.properties;
    const className = attributes.find(a => a.name?.text === "className")?.initializer?.text;
    if (className === "cx-scroll" || className === "cx-column") {
      for (const a of attributes) {
        if (!a.name?.text.startsWith("on") || !a.initializer?.expression) continue;
        if (className === "cx-scroll") scrollHandlers[a.name.text] = a.initializer.expression.getText(chatAst);
        else if (a.name.text === "onClickCapture") clickHandler = a.initializer.expression.getText(chatAst);
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(chatAst);
const followCode = chatSource.slice(chatSource.indexOf("  // Following new output"), chatSource.indexOf("  useFarTurns(scroller, column);"));
const compiledFollow = ts.transpileModule(`function install() {
${followCode}
return { following, followBottom, click: ${clickHandler}, handlers: {
${Object.entries(scrollHandlers).map(([name, handler]) => `${name}: ${handler}`).join(",\n")}
} }; }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function followFixture() {
  let resize;
  const effects = [];
  const box = {
    scrollHeight: 1200, clientHeight: 400, scrollTop: 800,
    scrollTo({ top }) { this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight)); },
  };
  const env = {
    atBottom: true, jumpingToBottom: { current: false }, scroller: { current: box },
    turns: [], stepCount: 0, selectedTaskId: "one",
    useRef: value => ({ current: value === null ? {} : value }),
    useEffect: fn => effects.push(fn),
    setAtBottom: value => { env.atBottom = value; },
    requestAnimationFrame() {},
    ResizeObserver: class { constructor(fn) { resize = fn; } observe() {} disconnect() {} },
  };
  const controller = vm.runInNewContext(`${compiledFollow}\ninstall()`, env);
  effects.forEach(fn => fn());
  const scroll = () => controller.handlers.onScroll({ currentTarget: box });
  return { box, controller, env, scroll, countChanged: effects[0],
    grow: () => { box.scrollHeight += 120; resize(); },
    bottom: () => { box.scrollTop = box.scrollHeight - box.clientHeight; scroll(); } };
}

test("transcript clicks never disable following the next model response", () => {
  const f = followFixture();
  f.controller.click();
  f.grow();
  assert.equal(f.box.scrollTop, f.box.scrollHeight - f.box.clientHeight);
  assert.equal(f.controller.following.current, true);
});

test("layout scrolls do not masquerade as a user scrolling up", () => {
  const f = followFixture();
  f.scroll();
  f.box.scrollTop -= 60;
  f.scroll();
  f.grow();
  assert.equal(f.box.scrollTop, f.box.scrollHeight - f.box.clientHeight);
});

test("scrolling up pauses model output and reaching the latest message resumes it", () => {
  const f = followFixture();
  f.controller.handlers.onWheel({ deltaY: -200, currentTarget: f.box });
  f.box.scrollTop -= 200;
  f.scroll();
  const top = f.box.scrollTop;
  f.grow();
  assert.equal(f.box.scrollTop, top);
  assert.equal(f.env.atBottom, false);
  f.bottom();
  f.grow();
  assert.equal(f.box.scrollTop, f.box.scrollHeight - f.box.clientHeight);
  assert.equal(f.env.atBottom, true);
});

test("a new step cannot re-arm following between wheel input and its scroll event", () => {
  const f = followFixture();
  f.controller.handlers.onWheel({ deltaY: -200, currentTarget: f.box });
  f.countChanged();
  assert.equal(f.controller.following.current, false);
});

test("downward wheel input and a touch without movement keep following", () => {
  const f = followFixture();
  f.controller.handlers.onWheel({ deltaY: 100, currentTarget: f.box });
  f.controller.handlers.onTouchStart({ touches: [{ clientY: 100 }] });
  f.grow();
  assert.equal(f.box.scrollTop, f.box.scrollHeight - f.box.clientHeight);
});

test("scroll input that cannot move a short transcript does not disable following", () => {
  const f = followFixture();
  f.box.scrollHeight = 200;
  f.box.scrollTop = 0;
  f.controller.handlers.onWheel({ deltaY: -100, currentTarget: f.box });
  f.controller.handlers.onTouchStart({ touches: [{ clientY: 100 }] });
  f.controller.handlers.onTouchMove({ touches: [{ clientY: 180 }], currentTarget: f.box });
  f.controller.handlers.onKeyDown({ key: "Home", target: { tagName: "DIV" }, currentTarget: f.box });
  assert.equal(f.controller.following.current, true);
  f.grow();
  f.grow();
  assert.equal(f.box.scrollTop, f.box.scrollHeight - f.box.clientHeight);
});

test("touch scrolling upward pauses until the latest message is reached", () => {
  const f = followFixture();
  f.controller.handlers.onTouchStart({ touches: [{ clientY: 100 }] });
  f.controller.handlers.onTouchMove({ touches: [{ clientY: 180 }], currentTarget: f.box });
  f.box.scrollTop -= 80;
  f.scroll();
  const top = f.box.scrollTop;
  f.grow();
  assert.equal(f.box.scrollTop, top);
  f.bottom();
  f.grow();
  assert.equal(f.box.scrollTop, f.box.scrollHeight - f.box.clientHeight);
});

test("keyboard scrolling pauses, but typing inside transcript fields does not", () => {
  const f = followFixture();
  f.controller.handlers.onKeyDown({ key: "ArrowUp", target: { tagName: "TEXTAREA" }, currentTarget: f.box });
  assert.equal(f.controller.following.current, true);
  f.controller.handlers.onKeyDown({ key: "PageUp", target: { tagName: "DIV" }, currentTarget: f.box });
  assert.equal(f.controller.following.current, false);
  f.box.scrollTop -= 100;
  f.scroll();
  const top = f.box.scrollTop;
  f.grow();
  assert.equal(f.box.scrollTop, top);
  f.bottom();
  f.grow();
  assert.equal(f.box.scrollTop, f.box.scrollHeight - f.box.clientHeight);
});

test("a scrollbar gesture pauses and a click without scrolling does not leave following stuck", () => {
  const f = followFixture();
  f.controller.handlers.onPointerDown({ target: f.box, currentTarget: f.box });
  assert.equal(f.controller.following.current, false);
  f.controller.handlers.onPointerUp({ currentTarget: f.box });
  f.grow();
  assert.equal(f.box.scrollTop, f.box.scrollHeight - f.box.clientHeight);
  f.controller.handlers.onPointerDown({ target: f.box, currentTarget: f.box });
  f.box.scrollTop -= 200;
  f.scroll();
  f.controller.handlers.onPointerUp({ currentTarget: f.box });
  const top = f.box.scrollTop;
  f.grow();
  assert.equal(f.box.scrollTop, top);
  f.bottom();
  f.grow();
  assert.equal(f.box.scrollTop, f.box.scrollHeight - f.box.clientHeight);
});

test("a smooth jump catches up with model output that arrived during the animation", () => {
  const f = followFixture();
  f.env.jumpingToBottom.current = true;
  f.grow();
  f.scroll();
  f.controller.handlers.onScrollEnd();
  assert.equal(f.box.scrollTop, f.box.scrollHeight - f.box.clientHeight);
  assert.equal(f.env.jumpingToBottom.current, false);
});

test("sending follows again while automatic requests respect a paused reader", () => {
  const f = followFixture();
  f.controller.handlers.onWheel({ deltaY: -200, currentTarget: f.box });
  f.box.scrollTop -= 200;
  f.scroll();
  f.controller.followBottom();
  f.grow();
  assert.equal(f.box.scrollTop, f.box.scrollHeight - f.box.clientHeight);
  assert.match(chatSource, /if \(here\(\)\) followBottom\(\);/);
  assert.match(chatSource, /if \(!requestKeys \|\| !following\.current\) return;\s*followBottom\(\);/);
});
