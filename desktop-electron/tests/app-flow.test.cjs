"use strict";
// Runtime > App layout > How it works (src/features/AppFlow.tsx, app-flow.css): the animated flow
// of how a message moves through Coding Tools. It must show every step and what each hands to the
// next, play once (never loop), stop when the page is left, and stay still for reduced motion.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const SOURCE = path.resolve(__dirname, "../src/features/AppFlow.tsx");
const CSS = path.resolve(__dirname, "../src/features/app-flow.css");

function load({ reducedMotion = false, hidden = false } = {}) {
  const effects = [];
  const timers = [];
  const state = new Map();
  let slot = 0;
  const element = (type, props) => ({ type, props: props ?? {} });
  const modules = {
    react: {
      useState: (initial) => {
        const key = slot++;
        if (!state.has(key)) state.set(key, initial);
        return [state.get(key), (next) => state.set(key, typeof next === "function" ? next(state.get(key)) : next)];
      },
      useRef: (initial) => ({ current: initial }),
      useEffect: (fn, deps) => effects.push({ fn, deps }),
    },
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: "Fragment" },
    "./app-flow.css": {},
  };
  const { outputText } = ts.transpileModule(fs.readFileSync(SOURCE, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    module, exports: module.exports,
    window: { matchMedia: (query) => ({ matches: reducedMotion && /reduce/.test(query) }) },
    document: { hidden },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    require: (name) => {
      if (!(name in modules)) throw new Error(`unexpected import ${name}`);
      return modules[name];
    },
  });
  const renderOnce = (props) => { slot = 0; effects.length = 0; return module.exports.AppFlow(props); };
  return { api: module.exports, effects, timers, state, renderOnce };
}

const flatten = (node) => {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!node || typeof node !== "object") return node === null || node === undefined || node === false ? [] : [node];
  return [node, ...flatten(node.props.children)];
};
const text = (node) => flatten(node).filter((item) => typeof item === "string" || typeof item === "number").join("");
const props = (overrides = {}) => ({ active: true, canOpen: () => true, onOpen: () => {}, ...overrides });

test("the flow shows every step, what it points to, and what it hands to the next", () => {
  const { api, renderOnce } = load();
  const steps = api.APP_FLOW;
  assert.deepEqual([...steps.map((step) => step.id)], ["you", "chat", "orchestrator", "models", "tools", "review", "result"]);
  for (const step of steps) {
    assert.ok(step.does && step.handsOff && step.pointsTo.length, step.id);
  }
  const tree = renderOnce(props());
  const items = flatten(tree).filter((node) => node.type === "li");
  assert.equal(items.length, steps.length);
  const shown = text(tree);
  for (const step of steps) assert.ok(shown.includes(step.handsOff), `hands off: ${step.id}`);
  assert.match(shown, /Back to you: /, "the last step hands back to the first");
});

test("it plays once through the steps while the page is open, then rests; Replay plays it again", () => {
  const { api, effects, timers, state, renderOnce } = load();
  renderOnce(props());
  const cleanup = effects[0].fn();
  // Each step lights for APP_FLOW_STEP_MS, then the play-through ends with nothing lit.
  const lit = [state.get(0)];
  while (timers.some((timer) => !timer.cleared && !timer.ran)) {
    const next = timers.find((timer) => !timer.cleared && !timer.ran);
    assert.equal(next.ms, api.APP_FLOW_STEP_MS);
    next.ran = true;
    next.fn();
    lit.push(state.get(0));
  }
  assert.deepEqual(lit, [0, 1, 2, 3, 4, 5, 6, -1], "every step once, then rest: no loop");
  assert.ok(timers.length <= api.APP_FLOW.length, "a bounded number of timers, none repeating");
  cleanup();
  // Replay bumps the round the effect depends on.
  const before = state.get(2);
  const tree = renderOnce(props());
  const replay = flatten(tree).find((node) => node.type === "button" && text(node).includes("Replay"));
  replay.props.onClick();
  assert.equal(state.get(2), before + 1);
});

test("leaving the page stops it at once, and it never plays hidden, inactive or with reduced motion", () => {
  {
    const { effects, timers, state, renderOnce } = load();
    renderOnce(props());
    const cleanup = effects[0].fn();
    cleanup();
    assert.ok(timers.every((timer) => timer.cleared), "the pending step timer is cleared");
    assert.equal(state.get(0), -1);
  }
  for (const [label, options, extra] of [["inactive", {}, { active: false }], ["reduced motion", { reducedMotion: true }, {}], ["hidden window", { hidden: true }, {}]]) {
    const { effects, timers, renderOnce } = load(options);
    renderOnce(props(extra));
    effects[0].fn();
    assert.equal(timers.length, 0, label);
  }
});

test("a page the app cannot open is shown but not clickable", () => {
  const { renderOnce } = load();
  const opened = [];
  const tree = renderOnce(props({ canOpen: (surface) => surface !== "agent-orchestrator", onOpen: (surface) => opened.push(surface) }));
  const chat = flatten(tree).find((node) => node.type === "button" && text(node) === "Chat");
  assert.equal(chat.props.disabled, true);
});

test("the styles animate only once, only transform and opacity, and not at all for reduced motion", () => {
  // Comments may name what is avoided; only the rules count.
  const css = fs.readFileSync(CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /\binfinite\b/, "no endless animation: it keeps the GPU drawing every frame");
  const keyframes = [...css.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)].map((match) => match[1]);
  assert.ok(keyframes.length >= 2);
  for (const body of keyframes) {
    for (const property of body.matchAll(/([a-z-]+)\s*:/g)) assert.ok(["opacity", "transform"].includes(property[1]), property[1]);
  }
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /animation: none !important;/);
  assert.match(reduced, /transition: none !important;/);
});
