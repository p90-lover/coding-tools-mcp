"use strict";

// The page tabs (ChatPages.tsx's ChatPageTabs) rendered with a tiny hook runtime, and how they are
// wired: drawn in each page's title-bar strip, turned by keys and a passive wheel listener.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const ts = require(require.resolve("typescript", { paths: [root] }));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const compile = (file) => ts.transpileModule(read(file), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function loadPages() {
  const contexts = new Map();
  const react = {
    createContext: (value) => { const context = { value }; context.Provider = { context }; return context; },
    useContext: (context) => contexts.has(context) ? contexts.get(context) : context.value,
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useRef: (current) => ({ current }), useMemo: (build) => build(), useCallback: (callback) => callback,
    useEffect() {}, useLayoutEffect() {}, useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  const jsx = (type, props, key) => ({ type, props, key });
  const values = new Map();
  const globals = {
    localStorage: { getItem: (name) => values.get(name) ?? null, setItem: (name, value) => values.set(name, value) },
    window: { addEventListener() {}, removeEventListener() {} },
  };
  const pages = {};
  vm.runInNewContext(compile("src/features/chat-pages.ts"), { exports: pages, require: (name) => name === "react" ? react : require(name), ...globals });
  const host = {};
  const Surface = function AgentOrchestratorSurface() { return null; };
  vm.runInNewContext(compile("src/features/ChatPages.tsx"), { exports: host, ...globals, require: (name) => name === "react" ? react
    : name === "react/jsx-runtime" ? { jsx, jsxs: jsx, Fragment: "Fragment" }
    : name === "./chat-pages" ? pages
    : name === "./AgentOrchestratorSurface" ? { AgentOrchestratorSurface: Surface }
    : name === "./ChatMenu" ? { ChatGlyph: function ChatGlyph() { return null; } }
    : name === "./page-visibility" ? { SurfaceHiddenContext: react.createContext(false), NativeViewsCoveredContext: react.createContext(false), useSurfaceHidden: () => () => false }
    : {} });
  // The registry ChatPages provides carries the tabs each page draws.
  const tree = host.ChatPages({ language: "en", setError() {} });
  const provider = tree.props.children;
  assert.equal(provider.type.context, pages.ChatPagesContext);
  const Tabs = provider.props.value.Tabs;
  assert.equal(typeof Tabs, "function", "the registry hands each page its tabs");
  const render = (pager, page) => { contexts.set(pages.ChatPagerContext, pager); return Tabs({ page }); };
  return { pages, host, tree, render, Surface };
}
const children = (element) => [element.props.children].flat(Infinity).filter(Boolean);
const pagerOf = (extra = {}) => {
  const calls = [];
  return { calls, pager: { active: 1, count: 3, canAdd: true, keys: { previous: "Shift+Q", next: "Shift+R" },
    select: (page) => calls.push(["select", page]), add: () => calls.push(["add"]), ...extra } };
};

test("the open page's tabs are its number among the others and +, with the keys in their tooltips", () => {
  const { render } = loadPages();
  const { pager, calls } = pagerOf();
  const nav = render(pager, 1);
  assert.equal(nav.type, "nav");
  assert.equal(nav.props.className, "cx-page-tabs");
  const [list, add] = children(nav);
  assert.equal(list.props.role, "tablist");
  const tabs = children(list);
  assert.deepEqual(tabs.map((tab) => tab.props.children), [1, 2, 3], "numbers only: no repeated \"Page\" text");
  assert.deepEqual(tabs.map((tab) => tab.props["aria-selected"]), [true, false, false]);
  assert.deepEqual(tabs.map((tab) => tab.props.tabIndex), [0, -1, -1]);
  assert.deepEqual(tabs.map((tab) => tab.props["aria-controls"]), ["chat-page-1", "chat-page-2", "chat-page-3"]);
  assert.equal(tabs[1].props.title, "Page 2 (Shift+Q / Shift+R)");
  assert.equal(list.props["aria-keyshortcuts"], "Shift+Q Shift+R");
  assert.equal(add.props["aria-label"], "New page");
  tabs[2].props.onClick();
  add.props.onClick();
  assert.deepEqual(calls, [["select", 3], ["add"]]);
});

test("arrow keys, Home and End move along the tabs, wrapping round", () => {
  const { render } = loadPages();
  const { pager, calls } = pagerOf({ active: 3 });
  const [list] = children(render(pager, 3));
  let prevented = 0;
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End", "a"]) list.props.onKeyDown({ key, preventDefault: () => prevented++ });
  assert.deepEqual(calls, [["select", 1], ["select", 2], ["select", 1], ["select", 3]]);
  assert.equal(prevented, 4, "other keys are left alone");
});

test("only the open page draws tabs; none with pages off; no + once twelve pages are open; keys off leave plain tooltips", () => {
  const { render } = loadPages();
  assert.equal(render(pagerOf({ active: 2 }).pager, 1), null, "a page out of view draws no tabs (and no duplicate ids)");
  assert.equal(render(null, 1), null, "pages turned off in Settings");
  const full = render(pagerOf({ count: 12, canAdd: false }).pager, 1);
  assert.equal(children(full).length, 1, "twelve pages: no +");
  const quiet = children(children(render(pagerOf({ keys: null }).pager, 1))[0]);
  assert.equal(quiet[0].props.title, "Page 1");
});

test("each visited page draws its own surface, and only visited pages mount", () => {
  const { tree, Surface } = loadPages();
  const sections = children(tree.props.children.props.children);
  assert.equal(sections.length, 1, "one page, nothing saved");
  const [section] = sections;
  assert.equal(section.type, "section");
  assert.equal(section.props.role, "tabpanel");
  assert.equal(section.props.hidden, false);
  const visibility = section.props.children;
  assert.equal(visibility.props.value, false);
  const surface = visibility.props.children;
  assert.deepEqual({ page: surface.props.page, language: surface.props.language }, { page: 1, language: "en" });
  const drawn = surface.type(surface.props);
  assert.equal(drawn.type, Surface);
  assert.equal(drawn.props.pageNumber, 1);
});

test("the tabs sit in each page's title-bar strip, which stays a drag region around them", () => {
  const surface = read("src/features/AgentOrchestratorSurface.tsx");
  assert.match(surface, /const PageTabs = pane \? undefined : pageRegistry\?\.Tabs;/);
  assert.match(surface, /<div className="ao-dragstrip" aria-hidden=\{PageTabs \? undefined : true\}>\{PageTabs \? <PageTabs page=\{pageNumber\} \/> : null\}<\/div>/);
  const pagesCss = read("src/features/chat-pages.css");
  assert.match(/\.cx-page-tabs \{([^}]*)\}/.exec(pagesCss)[1], /-webkit-app-region: no-drag/);
  assert.doesNotMatch(pagesCss, /cx-pages-bar|cx-page-step/, "the separate 38 px page bar is gone");
  assert.match(read("src/features/agent-orchestrator.css"), /\.ao-dragstrip \{[^}]*-webkit-app-region: drag;/);
  const host = read("src/features/ChatPages.tsx");
  assert.doesNotMatch(host, /className="cx-pages-bar"/);
});

test("scrolling never waits for the page listener, and page keys check typing before anything costly", () => {
  const host = read("src/features/ChatPages.tsx");
  assert.match(host, /element\.addEventListener\("wheel", wheel, \{ passive: true \}\)/);
  const key = /const key = \(event: KeyboardEvent\) => \{([\s\S]*?)\n {4}\};/.exec(host)[1];
  assert.ok(key.indexOf("pageShortcutDirection") < key.indexOf("dialogOpen()"), "the DOM query runs only for a page key");
  // A page's chats are one element while their inputs are: turning a page redraws two pages, not all.
  assert.match(host, /function PageSurface[\s\S]*?return useMemo\(\(\) => <AgentOrchestratorSurface language=\{language\} setError=\{setError\} pageNumber=\{page\} \/>, \[page, language, setError\]\);/);
});
