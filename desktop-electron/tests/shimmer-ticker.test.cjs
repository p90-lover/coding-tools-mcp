const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function setup() {
  const timers = new Map();
  let next = 0;
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/shimmer-ticker.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports,
    setInterval: (fn, ms) => { timers.set(++next, { fn, ms }); return next; },
    clearInterval: (id) => timers.delete(id) });
  const listeners = new Map();
  const doc = { hidden: false, timeline: { currentTime: 1000 },
    // Walking the whole document is what the ticker must not do.
    getAnimations() { throw new Error("document.getAnimations walks every element"); },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => listeners.get(type) === fn && listeners.delete(type) };
  const element = () => ({ isConnected: true, animations: [], getAnimations() { return this.animations; } });
  const animation = (animationName, target) => {
    const created = { animationName, playState: "running", currentTime: 0, effect: { target }, pause() { this.playState = "paused"; } };
    target.animations.push(created);
    return created;
  };
  const start = (animationName, target) => listeners.get("animationstart")?.({ animationName, target });
  return { install: exports.installShimmerTicker, doc, timers, listeners, element, animation, start };
}

test("shimmer ticker pauses shimmers and steps them on one 30 Hz clock", () => {
  const { install, doc, timers, element, animation, start } = setup();
  install(doc);
  const first = element();
  const second = element();
  const shimmers = [animation("cx-shimmer", first), animation("cx-shimmer", second)];
  const pulse = animation("cx-pulse", first);
  start("cx-pulse", first);
  assert.equal(timers.size, 0, "other animations never start the ticker");
  start("cx-shimmer", first);
  assert.equal(timers.size, 1);
  assert.ok(Math.abs([...timers.values()][0].ms - 1000 / 30) < 0.01);
  assert.deepEqual([shimmers[0].playState, shimmers[0].currentTime], ["paused", 1000]);
  assert.equal(pulse.playState, "running", "compositor animations are left alone");
  start("cx-shimmer", second);
  assert.equal(timers.size, 1, "a second shimmer reuses the running ticker");
  assert.deepEqual([shimmers[1].playState, shimmers[1].currentTime], ["paused", 1000]);
  doc.timeline.currentTime = 1033;
  [...timers.values()][0].fn();
  assert.deepEqual(shimmers.map((shimmer) => shimmer.currentTime), [1033, 1033]);
});

test("shimmer ticker skips hidden windows and stops when no shimmer is left", () => {
  const { install, doc, timers, listeners, element, animation, start } = setup();
  const uninstall = install(doc);
  const host = element();
  const shimmer = animation("cx-shimmer", host);
  start("cx-shimmer", host);
  const tick = [...timers.values()][0].fn;
  doc.hidden = true;
  doc.timeline.currentTime = 5000;
  tick();
  assert.equal(shimmer.currentTime, 1000, "a hidden window does not step");
  assert.equal(timers.size, 1);
  doc.hidden = false;
  shimmer.playState = "idle";
  tick();
  assert.equal(timers.size, 0, "the ticker stops once its shimmer is cancelled");
  start("cx-shimmer", element());
  assert.equal(timers.size, 0, "it restarts only while a shimmer exists");
  const next = element();
  animation("cx-shimmer", next);
  start("cx-shimmer", next);
  assert.equal(timers.size, 1);
  uninstall();
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
});

test("shimmer ticker drops shimmers whose element left the page", () => {
  const { install, doc, timers, element, animation, start } = setup();
  install(doc);
  const kept = element();
  const removed = element();
  const stays = animation("cx-shimmer", kept);
  const gone = animation("cx-shimmer", removed);
  start("cx-shimmer", kept);
  start("cx-shimmer", removed);
  removed.isConnected = false;
  doc.timeline.currentTime = 2000;
  [...timers.values()][0].fn();
  assert.equal(stays.currentTime, 2000);
  assert.equal(gone.currentTime, 1000, "a detached shimmer is no longer stepped");
  kept.isConnected = false;
  [...timers.values()][0].fn();
  assert.equal(timers.size, 0, "the ticker stops when the last shimmer leaves");
});

test("shimmer ticker also steps the deep-dive transcript shimmer", () => {
  const { install, doc, timers, element, animation, start } = setup();
  install(doc);
  const host = element();
  const deep = animation("dsh-shimmer", host);
  start("dsh-shimmer", host);
  assert.equal(timers.size, 1);
  assert.deepEqual([deep.playState, deep.currentTime], ["paused", 1000]);
});

test("shimmer ticker rests while the preload marks a minimized window away", () => {
  const { install, doc, timers, element, animation, start } = setup();
  const away = new Set(["data-window-away"]);
  doc.documentElement = { hasAttribute: (name) => away.has(name) };
  install(doc);
  const host = element();
  const shimmer = animation("cx-shimmer", host);
  start("cx-shimmer", host);
  doc.timeline.currentTime = 4000;
  [...timers.values()][0].fn();
  assert.equal(shimmer.currentTime, 0, "a minimized window still reads visible, but is not stepped");
  away.clear();
  [...timers.values()][0].fn();
  assert.equal(shimmer.currentTime, 4000, "shown again, it steps");
});
