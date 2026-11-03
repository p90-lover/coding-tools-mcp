"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const runtime = require("react/jsx-runtime");

const key = "coding-tools:render-error-reloads";
const source = fs.readFileSync(path.resolve(__dirname, "../src/AppErrorBoundary.tsx"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;

function storage() {
  const data = new Map();
  return { data, failGet: false, failSet: false,
    getItem(name) { if (this.failGet) throw new Error("fixture SecurityError"); return data.get(name) ?? null; },
    setItem(name, value) { if (this.failSet) throw new Error("fixture QuotaExceededError"); data.set(name, value); },
  };
}

function page(store, now = 1_000_000) {
  const timers = new Map(), exports = {};
  let sequence = 0, reloads = 0;
  class Clock extends Date { static now() { return now; } }
  // Each page has a fresh module/class. Only session storage survives a reload.
  vm.runInNewContext(compiled, { exports, Error, Date: Clock, sessionStorage: store, console: { error() {} },
    window: { setTimeout(fn, ms) { timers.set(++sequence, { fn, ms }); return sequence; },
      clearTimeout(id) { timers.delete(id); }, location: { reload() { reloads++; } } },
    require(name) { if (name === "react") return React; if (name === "react/jsx-runtime") return runtime; throw new Error(name); },
  });
  const boundary = new exports.AppErrorBoundary({ children: "fixture child" });
  boundary.setState = next => Object.assign(boundary.state, next);
  const elements = node => !node || typeof node !== "object" ? []
    : [node, ...[node.props?.children].flat(Infinity).flatMap(elements)];
  return {
    catchError() {
      const error = new Error("persistent fixture render failure");
      Object.assign(boundary.state, exports.AppErrorBoundary.getDerivedStateFromError(error));
      boundary.componentDidCatch(error, { componentStack: "fixture" });
    },
    fire() { const [id, timer] = [...timers][0] ?? []; assert(timer, "automatic timer exists"); timers.delete(id); now += timer.ms; timer.fn(); },
    manual() { const button = elements(boundary.render()).find(node => node.type === "button" && node.props.children === "Reload now");
      assert(button, "manual recovery stays available"); button.props.onClick(); },
    text() { return elements(boundary.render()).flatMap(node => [node.props?.children].flat(Infinity)).filter(value => typeof value === "string").join(" "); },
    unmount() { boundary.componentWillUnmount(); },
    get pending() { return timers.size; }, get reloading() { return boundary.state.reloading; }, get reloads() { return reloads; },
  };
}

test("healthy render recovery allows three reloads across fresh pages, then manual recovery", () => {
  const store = storage(); let automatic = 0, current;
  for (let index = 0; index < 4; index++) {
    current = page(store, 1_000_000 + index * 2_000); current.catchError();
    if (current.pending) { current.fire(); automatic += current.reloads; }
    current.unmount();
  }
  assert.equal(automatic, 3); assert.equal(current.pending, 0); assert.equal(current.reloading, false);
  current.manual(); assert.equal(current.reloads, 1);
});

for (const failure of ["failGet", "failSet"]) test(`render recovery never auto-reloads when storage ${failure} fails`, () => {
  const store = storage(); store[failure] = true;
  for (let index = 0; index < 5; index++) {
    const current = page(store); current.catchError();
    try {
      assert.equal(current.pending, 0); assert.equal(current.reloading, false);
      assert.doesNotMatch(current.text(), /reloaded 3 times/);
      current.manual(); assert.equal(current.reloads, 1, "manual reload is not blocked by storage");
    } finally { current.unmount(); }
  }
});

for (const failure of ["failGet", "failSet"]) test(`scheduled render recovery stops if storage ${failure} fails before recording`, () => {
  const store = storage(), current = page(store); current.catchError();
  assert.equal(current.pending, 1); store[failure] = true; current.fire();
  assert.equal(current.reloads, 0); assert.equal(current.reloading, false); assert.equal(current.pending, 0);
  assert.doesNotMatch(current.text(), /reloaded 3 times/);
  current.manual(); assert.equal(current.reloads, 1); current.unmount();
});

test("expired reload history allows recovery and records only the new attempt", () => {
  const store = storage(); store.data.set(key, JSON.stringify([879_997, 879_998, 879_999]));
  const current = page(store); current.catchError(); assert.equal(current.pending, 1); current.fire();
  assert.equal(current.reloads, 1); assert.deepEqual(JSON.parse(store.data.get(key)), [1_001_500]); current.unmount();
});

test("unmount cancels scheduled automatic recovery", () => {
  const current = page(storage()); current.catchError(); assert.equal(current.pending, 1);
  current.unmount(); assert.equal(current.pending, 0); assert.equal(current.reloads, 0);
});

test("manual reload cancels a scheduled automatic attempt", () => {
  const current = page(storage()); current.catchError(); current.manual();
  assert.equal(current.reloads, 1); assert.equal(current.pending, 0); current.unmount();
});
