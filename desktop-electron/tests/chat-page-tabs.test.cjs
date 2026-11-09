"use strict";

// The page tabs (ChatPages.tsx's ChatPageTabs) rendered with a tiny hook runtime, and how they are
// wired: a glass dock at the foot of each page's chat column, turned by keys and a passive wheel listener.
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

// `options`: `effects` collects the host's effects to run by hand, `store` seeds localStorage,
// `window` and `Element` stand in for the browser's.
function loadPages(options = {}) {
  const contexts = new Map();
  const react = {
    createContext: (value) => { const context = { value }; context.Provider = { context }; return context; },
    useContext: (context) => contexts.has(context) ? contexts.get(context) : context.value,
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useRef: (current) => ({ current }), useMemo: (build) => build(), useCallback: (callback) => callback,
    useEffect: (effect) => { options.effects?.push(effect); }, useLayoutEffect: (effect) => { options.layout?.push(effect); },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  const jsx = (type, props, key) => ({ type, props, key });
  const values = new Map(options.store ?? []);
  const globals = {
    localStorage: { getItem: (name) => values.get(name) ?? null, setItem: (name, value) => values.set(name, value) },
    window: options.window ?? { addEventListener() {}, removeEventListener() {} },
    ...(options.Element ? { Element: options.Element } : {}),
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
  return { pages, host, tree, render, Surface, values };
}
const children = (element) => [element.props.children].flat(Infinity).filter(Boolean);
// The dock's parts: the sheen, the tablist (the blob first, then the tabs) and + when it is shown.
const dock = (nav) => {
  const [sheen, list, add] = children(nav);
  assert.equal(sheen.props.className, "cx-page-sheen");
  assert.equal(sheen.props["aria-hidden"], "true");
  const [blob, ...tabs] = children(list);
  assert.equal(blob.props.className, "cx-page-blob");
  assert.equal(blob.props["aria-hidden"], "true");
  return { list, blob, tabs, add };
};
const pagerOf = (extra = {}) => {
  const calls = [];
  return { calls, pager: { active: 1, count: 3, canAdd: true, keys: true,
    select: (page) => calls.push(["select", page]), add: () => calls.push(["add"]), ...extra } };
};

test("the open page's tabs are its number among the others and +, with the keys in their tooltips", () => {
  const { render } = loadPages();
  const { pager, calls } = pagerOf();
  const nav = render(pager, 1);
  assert.equal(nav.type, "nav");
  assert.equal(nav.props.className, "cx-page-tabs");
  const { list, tabs, add } = dock(nav);
  assert.equal(list.props.role, "tablist");
  assert.deepEqual(tabs.map((tab) => tab.props.children), [1, 2, 3], "numbers only: no repeated \"Page\" text");
  assert.deepEqual(tabs.map((tab) => tab.props["aria-selected"]), [true, false, false]);
  assert.deepEqual(tabs.map((tab) => tab.props.tabIndex), [0, -1, -1]);
  assert.deepEqual(tabs.map((tab) => tab.props["aria-controls"]), ["chat-page-1", "chat-page-2", "chat-page-3"]);
  assert.deepEqual(tabs.map((tab) => tab.props.title), ["Page 1 (Ctrl+1)", "Page 2 (Ctrl+2)", "Page 3 (Ctrl+3)"]);
  assert.deepEqual(tabs.map((tab) => tab.props["aria-keyshortcuts"]), ["Control+1", "Control+2", "Control+3"]);
  assert.equal(list.props["aria-keyshortcuts"], undefined, "no Shift+Q / Shift+R any more");
  assert.equal(add.props["aria-label"], "New page");
  tabs[2].props.onClick();
  add.props.onClick();
  assert.deepEqual(calls, [["select", 3], ["add"]]);
});

test("arrow keys, Home and End move along the tabs, wrapping round", () => {
  const { render } = loadPages();
  const { pager, calls } = pagerOf({ active: 3 });
  const { list } = dock(render(pager, 3));
  let prevented = 0;
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End", "a"]) list.props.onKeyDown({ key, preventDefault: () => prevented++ });
  assert.deepEqual(calls, [["select", 1], ["select", 2], ["select", 1], ["select", 3]]);
  assert.equal(prevented, 4, "other keys are left alone");
});

test("only the open page draws tabs; none with pages off; no + once twelve pages are open; keys off leave plain tooltips", () => {
  const { render } = loadPages();
  assert.equal(render(pagerOf({ active: 2 }).pager, 1), null, "a page out of view draws no tabs (and no duplicate ids)");
  assert.equal(render(null, 1), null, "pages turned off in Settings");
  const full = dock(render(pagerOf({ count: 12, canAdd: false }).pager, 1));
  assert.equal(full.add, undefined, "twelve pages: no +");
  const twelve = full.tabs;
  assert.deepEqual([twelve[9].props.title, twelve[10].props.title, twelve[11].props.title], ["Page 10 (Ctrl+0)", "Page 11", "Page 12"],
    "Ctrl+0 is page 10; pages 11 and 12 have no key");
  assert.equal(twelve[10].props["aria-keyshortcuts"], undefined);
  const quiet = dock(render(pagerOf({ keys: false }).pager, 1)).tabs;
  assert.equal(quiet[0].props.title, "Page 1");
  assert.equal(quiet[0].props["aria-keyshortcuts"], undefined);
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

test("the liquid blob sits under the open tab and springs there from the last page's tab, unless motion is reduced", () => {
  const turn = (window) => {
    const layout = [];
    const { render } = loadPages({ layout, ...(window ? { window } : {}) });
    const animations = [];
    const node = { style: {}, animate: (frames, timing) => animations.push({ frames, timing }) };
    // Each page's surface draws its own dock: open page 1, then page 3, as two separate docks.
    for (const [active, x] of [[1, 0], [3, 60]]) {
      layout.length = 0;
      const nav = render(pagerOf({ active }).pager, active);
      nav.props.ref.current = { querySelector: (selector) => selector.includes('aria-selected="true"') ? { offsetLeft: x, offsetWidth: 28 } : null };
      dock(nav).blob.props.ref.current = node;
      for (const effect of layout) effect();
    }
    return { style: { ...node.style }, animations: JSON.parse(JSON.stringify(animations)) };
  };
  const moved = turn();
  assert.deepEqual(moved.style, { transform: "translateX(60px)", width: "28px" }, "the blob ends under page 3's tab");
  assert.equal(moved.animations.length, 1, "no spring on the first page drawn, one on the turn");
  const [{ frames, timing }] = moved.animations;
  assert.equal(frames[0].transform, "translateX(0px)", "it starts where the last page's blob was");
  assert.equal(frames.at(-1).transform, "translateX(60px)");
  assert.match(frames[1].transform, /scaleY\(0\.\d+\)/, "halfway it stretches thinner");
  assert.ok(parseFloat(frames[1].width) > 28, "and wider, reaching across");
  assert.ok(timing.duration <= 600, "a short spring");
  const still = turn({ addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
  assert.deepEqual(still.style, moved.style, "reduced motion: the blob still moves");
  assert.equal(still.animations.length, 0, "but jumps there without the spring");
});

test("the tabs float as a glass dock at the foot of the window's chat column, clear of its composers", () => {
  const surface = read("src/features/AgentOrchestratorSurface.tsx");
  assert.match(surface, /const PageTabs = pane \? undefined : pageRegistry\?\.Tabs;/);
  assert.match(surface, /\{pane \? null : <div className="ao-dragstrip" aria-hidden="true" \/>\}/, "the title-bar strip is a plain drag region again");
  // Drawn once, after the stage, as the last thing in .ao-main: centred under the chats, not the thread list.
  const drawn = "{PageTabs ? <PageTabs page={pageNumber} /> : null}";
  const tabsAt = surface.indexOf(drawn);
  assert.ok(tabsAt > surface.indexOf('<div className="ao-stage"'), "after the stage");
  assert.equal(surface.indexOf("<PageTabs", tabsAt + drawn.length), -1, "drawn once");
  assert.equal(surface.indexOf("<PageTabs"), tabsAt + drawn.indexOf("<PageTabs"), "and nowhere before");
  assert.match(surface.slice(tabsAt), /^\{PageTabs \? <PageTabs page=\{pageNumber\} \/> : null\}\s*<\/div>/);
  const pagesCss = read("src/features/chat-pages.css");
  assert.match(pagesCss, /\.ao-main:has\(> \.cx-page-tabs\) \{[^}]*position: relative;[^}]*padding-bottom: 40px;/,
    "the column keeps a band for the dock, so it never covers a composer");
  const dockRule = /\.cx-page-tabs \{([^}]*)\}/.exec(pagesCss)[1];
  assert.match(dockRule, /position: absolute; left: 50%; bottom: 7px;/);
  assert.match(dockRule, /transform: translateX\(-50%\);/, "centred");
  assert.match(dockRule, /backdrop-filter: blur\(\d+px\) saturate\([\d.]+\)/, "glass: what is behind shows through, blurred");
  assert.match(dockRule, /-webkit-app-region: no-drag/);
  assert.doesNotMatch(pagesCss, /animation|infinite/, "nothing loops: motion runs only when it is used");
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/.exec(pagesCss)[1];
  assert.match(reduced, /transition: none;/);
  assert.match(reduced, /\.cx-page-sheen \{ display: none; \}/);
  assert.doesNotMatch(pagesCss, /cx-pages-bar|cx-page-step/, "the separate 38 px page bar is gone");
  assert.match(read("src/features/agent-orchestrator.css"), /\.ao-dragstrip \{[^}]*-webkit-app-region: drag;/);
  const host = read("src/features/ChatPages.tsx");
  assert.doesNotMatch(host, /className="cx-pages-bar"/);
});

test("Alt+scroll turns pages and holds the chat still only while Alt is down; Ctrl+number opens a page", () => {
  // Listeners by type, each with whether it may block scrolling (passive: false).
  const bus = () => {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(type, listener, options) {
        listeners.set(type, [...(listeners.get(type) ?? []), { listener, passive: typeof options === "object" ? options.passive : undefined }]);
      },
      removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) ?? []).filter((item) => item.listener !== listener)); },
      fire(type, event) { for (const { listener } of [...(listeners.get(type) ?? [])]) listener(event); },
      blocking(type) { return (listeners.get(type) ?? []).filter((item) => item.passive === false).length; },
    };
  };
  class Element { closest() { return null; } }
  const win = bus();
  const effects = [];
  const { tree, values } = loadPages({ effects, window: win, Element, store: [["coding-tools:ao:chat-pages", '{"pageCount":3}']] });
  const element = { ...bus(), querySelector: () => null };
  tree.props.ref.current = element;
  for (const effect of effects) effect();
  const active = () => values.get("coding-tools:ao:chat-pages:active") ?? "1";
  let stopped = 0, prevented = 0;
  const wheel = (deltaY, extra = {}) => element.fire("wheel", { deltaX: 0, deltaY, deltaMode: 0, shiftKey: false, ctrlKey: false,
    metaKey: false, altKey: false, target: new Element(), preventDefault: () => stopped++, ...extra });
  const key = (type, extra) => win.fire(type, { key: "", code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    repeat: false, isComposing: false, keyCode: 0, defaultPrevented: false, target: new Element(),
    preventDefault: () => prevented++, stopImmediatePropagation() {}, ...extra });

  assert.equal(element.blocking("wheel"), 0, "no blocking wheel listener until Alt is held");
  wheel(100, { altKey: true, timeStamp: 1000 });
  assert.equal(active(), "2", "Alt+scroll down: the next page");
  key("keydown", { key: "Alt", altKey: true });
  assert.equal(element.blocking("wheel"), 1, "Alt held: the chat under the pointer is kept still");
  wheel(-100, { altKey: true, timeStamp: 2000 });
  assert.equal(active(), "1", "Alt+scroll up: the previous page");
  assert.equal(stopped, 1, "and the chat did not scroll with it");
  key("keyup", { key: "Alt" });
  assert.equal(element.blocking("wheel"), 0, "Alt let go: scrolling is passive again");
  wheel(100, { timeStamp: 3000 });
  assert.deepEqual([active(), stopped], ["1", 1], "a plain scroll scrolls the chat and turns nothing");
  key("keydown", { key: "Alt", altKey: true });
  win.fire("blur", {});
  assert.equal(element.blocking("wheel"), 0, "leaving the window lets go of Alt too");

  key("keydown", { key: "3", code: "Digit3", ctrlKey: true });
  assert.deepEqual([active(), prevented], ["3", 1], "Ctrl+3: page 3");
  key("keydown", { key: "R", code: "KeyR", shiftKey: true });
  key("keydown", { key: "5", code: "Digit5", ctrlKey: true });
  assert.deepEqual([active(), prevented], ["3", 1], "Shift+R does nothing now, nor Ctrl+5 with three pages");
});

test("scrolling never waits for the page listener, and page keys check typing before anything costly", () => {
  const host = read("src/features/ChatPages.tsx");
  assert.match(host, /element\.addEventListener\("wheel", wheel, \{ passive: true \}\)/);
  assert.match(host, /if \(held\) element\.addEventListener\("wheel", still, \{ passive: false \}\);/, "a blocking listener only while Alt is held");
  const key = /const key = \(event: KeyboardEvent\) => \{([\s\S]*?)\n {4}\};/.exec(host)[1];
  assert.ok(key.indexOf("pageNumberKey") < key.indexOf("dialogOpen()"), "the DOM query runs only for a page key");
  // A page's chats are one element while their inputs are: turning a page redraws two pages, not all.
  assert.match(host, /function PageSurface[\s\S]*?return useMemo\(\(\) => <AgentOrchestratorSurface language=\{language\} setError=\{setError\} pageNumber=\{page\} \/>, \[page, language, setError\]\);/);
});
