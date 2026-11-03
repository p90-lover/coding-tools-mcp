const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function setup() {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/entrance-settle.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports });
  const listeners = new Map();
  const away = new Set();
  const animations = [];
  const doc = { hidden: true, walks: 0,
    documentElement: { hasAttribute: (name) => away.has(name) },
    getAnimations() { this.walks += 1; return animations; },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => listeners.get(type) === fn && listeners.delete(type) };
  const animation = (animationName, playState = "running") => {
    const created = { animationName, playState, finish() { this.playState = "finished"; } };
    animations.push(created);
    return created;
  };
  const change = () => listeners.get("visibilitychange")?.();
  return { install: exports.installEntranceSettle, doc, away, listeners, animation, change };
}

test("entrances that waited while the window was hidden finish when it shows", () => {
  const { install, doc, animation, change } = setup();
  install(doc);
  const rise = animation("claude-rise");
  const fade = animation("claude-fade");
  const shimmer = animation("cx-shimmer");
  const paused = animation("claude-rise", "paused");
  change();
  assert.equal(doc.walks, 0, "a hidden window is left alone");
  assert.equal(rise.playState, "running");
  doc.hidden = false;
  change();
  assert.equal(doc.walks, 1, "one walk of the document per return");
  assert.equal(rise.playState, "finished");
  assert.equal(fade.playState, "finished");
  assert.equal(shimmer.playState, "running", "only entrances are finished");
  assert.equal(paused.playState, "paused", "an entrance someone paused stays as it is");
});

test("a minimized window waits until it is restored", () => {
  const { install, doc, away, animation, change } = setup();
  install(doc);
  doc.hidden = false;
  away.add("data-window-away");
  const rise = animation("claude-rise");
  change();
  assert.equal(rise.playState, "running");
  away.delete("data-window-away");
  change();
  assert.equal(rise.playState, "finished");
});

test("uninstalling stops settling", () => {
  const { install, doc, listeners } = setup();
  const uninstall = install(doc);
  assert.ok(listeners.has("visibilitychange"));
  uninstall();
  assert.equal(listeners.has("visibilitychange"), false);
});
