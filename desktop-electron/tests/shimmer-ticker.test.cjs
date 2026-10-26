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
  const doc = { hidden: false, timeline: { currentTime: 1000 }, animations: [],
    getAnimations() { return this.animations; },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => listeners.get(type) === fn && listeners.delete(type) };
  const animation = (animationName) => ({ animationName, playState: "running", currentTime: 0, pause() { this.playState = "paused"; } });
  const start = (animationName) => listeners.get("animationstart")?.({ animationName });
  return { install: exports.installShimmerTicker, doc, timers, listeners, animation, start };
}

test("shimmer ticker pauses shimmers and steps them on one 30 Hz clock", () => {
  const { install, doc, timers, animation, start } = setup();
  install(doc);
  const shimmers = [animation("cx-shimmer"), animation("cx-shimmer")];
  const pulse = animation("cx-pulse");
  doc.animations = [...shimmers, pulse];
  start("cx-pulse");
  assert.equal(timers.size, 0, "other animations never start the ticker");
  start("cx-shimmer");
  assert.equal(timers.size, 1);
  assert.ok(Math.abs([...timers.values()][0].ms - 1000 / 30) < 0.01);
  for (const shimmer of shimmers) assert.deepEqual([shimmer.playState, shimmer.currentTime], ["paused", 1000]);
  assert.equal(pulse.playState, "running", "compositor animations are left alone");
  start("cx-shimmer");
  assert.equal(timers.size, 1, "a second shimmer reuses the running ticker");
  doc.timeline.currentTime = 1033;
  [...timers.values()][0].fn();
  assert.deepEqual(shimmers.map((shimmer) => shimmer.currentTime), [1033, 1033]);
});

test("shimmer ticker skips hidden windows and stops when no shimmer is left", () => {
  const { install, doc, timers, listeners, animation, start } = setup();
  const uninstall = install(doc);
  const shimmer = animation("cx-shimmer");
  doc.animations = [shimmer];
  start("cx-shimmer");
  const tick = [...timers.values()][0].fn;
  doc.hidden = true;
  doc.timeline.currentTime = 5000;
  tick();
  assert.equal(shimmer.currentTime, 1000, "a hidden window does not step");
  assert.equal(timers.size, 1);
  doc.hidden = false;
  doc.animations = [];
  tick();
  assert.equal(timers.size, 0, "the ticker stops with no shimmer on screen");
  start("cx-shimmer");
  assert.equal(timers.size, 0, "it restarts only while a shimmer exists");
  doc.animations = [shimmer];
  start("cx-shimmer");
  assert.equal(timers.size, 1);
  uninstall();
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
});
