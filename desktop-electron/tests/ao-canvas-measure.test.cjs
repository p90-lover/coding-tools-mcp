const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

// A React stand-in with real dependency comparison: a layout effect runs on the first render and
// then only when one of its dependencies changed (Object.is), as React runs it.
function harness() {
  const states = [], refs = [], effects = [], cleanups = [];
  let stateCursor = 0, refCursor = 0, effectCursor = 0, pending = [];
  const react = {
    useState(initial) {
      const index = stateCursor++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }];
    },
    useRef(initial) { return refs[refCursor++] ??= { current: initial }; },
    useLayoutEffect(effect, deps) {
      const index = effectCursor++;
      const previous = effects[index];
      effects[index] = deps;
      if (!previous || !deps || deps.some((dep, at) => !Object.is(dep, previous[at]))) pending.push([index, effect]);
    },
    useEffect() {},
  };
  const jsx = (type, props, key) => ({ type, props: props || {}, key });
  const frames = [];
  const observers = [];
  const exports = {};
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorCanvas.tsx"), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, Map, Set, JSON, Math,
    require: name => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx, Fragment: "Fragment" }
      : name === "./AgentOrchestratorTeam" ? { ROLE_TITLE: { orchestrator: "Orchestrator", worker: "Worker", reviewer: "Reviewer" } }
      : name === "./ChatMenu" ? { ChatMenu: "ChatMenu" } : {},
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    window: { addEventListener() {}, removeEventListener() {}, setTimeout: () => 0, clearTimeout() {} },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
      observe(target) { this.targets.add(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    },
  });
  let reads = 0;
  const element = (height) => {
    const fake = { style: {}, height, clientWidth: 1000, clientHeight: 800,
      setAttribute() {}, addEventListener() {}, removeEventListener() {}, contains: () => false,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }) };
    Object.defineProperty(fake, "offsetHeight", { get() { reads += 1; return fake.height; } });
    return fake;
  };
  const cards = new Map();
  const attach = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(attach); return; }
    const { ref, children } = node.props || {};
    if (typeof ref === "function") {
      // Cards are keyed by their node id; everything else (link paths) gets a plain element.
      const fake = node.key && cards.has(node.key) ? cards.get(node.key) : element(80);
      if (node.key && !cards.has(node.key)) cards.set(node.key, fake);
      ref(fake);
    } else if (ref && typeof ref === "object" && !ref.current) ref.current = element(800);
    attach(children);
  };
  const render = (props) => {
    stateCursor = 0; refCursor = 0; effectCursor = 0; pending = [];
    const tree = exports.AgentOrchestratorCanvas(props);
    attach(tree);
    for (const [index, effect] of pending) { cleanups[index]?.(); const cleanup = effect(); cleanups[index] = typeof cleanup === "function" ? cleanup : undefined; }
    while (frames.length) frames.shift()(performance.now());
    return tree;
  };
  const positions = () => refs.map(ref => ref.current).find(value => value instanceof Map && [...value.values()].some(point => point && typeof point.y === "number"));
  return { render, cards, observers, reads: () => reads, positions };
}

const node = (id, parents = []) => ({ id, task_id: id, role: id === "o" ? "orchestrator" : "worker", state: "pending", parents, x: 0, y: 0, positioned: false });
const props = (nodes, levels) => ({ nodes, levels, selectedId: "", busy: false, describe: () => "", onSelect() {}, onMove: async () => {}, onConnect() {}, canConnect: () => false });
const team = (links = { b: ["o"] }) => {
  const nodes = [node("o"), node("a", ["o"]), node("b", links.b)];
  return [nodes, [[nodes[0]], nodes.slice(1)]];
};

test("a page poll that rebuilds the same nodes and levels does not re-measure the cards", () => {
  const canvas = harness();
  canvas.render(props(...team()));
  const first = canvas.reads();
  assert.ok(first >= 3, "each card is measured once when it appears");
  for (let poll = 0; poll < 5; poll += 1) canvas.render(props(...team()));
  assert.equal(canvas.reads(), first, "fresh arrays with the same cards force no layout");
  canvas.render(props(...team({ b: ["a"] })));
  assert.ok(canvas.positions().get("b").y > canvas.positions().get("a").y - 1, "a changed link lays the cards out again");
});

test("a card that grows pushes the cards below it, without a page render", () => {
  const canvas = harness();
  canvas.render(props(...team()));
  const before = canvas.positions().get("a").y;
  const orchestrator = canvas.cards.get("o");
  const observer = canvas.observers.find(candidate => candidate.targets.has(orchestrator));
  assert.ok(observer, "a card is watched");
  assert.deepEqual(["o", "a", "b"].map(id => observer.targets.has(canvas.cards.get(id))), [true, true, true], "every card is watched");
  orchestrator.height = 300;
  observer.callback([{ target: orchestrator }]);
  assert.equal(canvas.positions().get("a").y, before + 300 - 80, "the next level moves down by the growth");
  const reads = canvas.reads();
  observer.callback([{ target: orchestrator }]);
  assert.equal(canvas.positions().get("a").y, before + 220, "an unchanged size changes nothing");
  assert.equal(canvas.reads(), reads + 1, "the observer reads only the card it reported");
});
