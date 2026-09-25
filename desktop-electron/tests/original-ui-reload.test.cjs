"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const filename = path.join(__dirname, "..", "src", "features", "OriginalUiSurface.tsx");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: filename,
});

function mount(toolId) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const opens = [];
  const url = toolId === "cpa"
    ? "http://127.0.0.1:8317/management.html#/dashboard"
    : "file:///codex-router/index.html#dashboard";
  const tool = { id: toolId, name: toolId, status: "ready", pid: 7, sections: ["dashboard"], error: null };
  const api = {
    originalUiSnapshot: async () => ({ tools: [tool] }),
    openOriginalUi: async (id, section) => {
      assert.equal(id, toolId);
      opens.push(section);
      return { tool, section: "dashboard", url, unavailable: false };
    },
  };
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo(compute) { cursor++; return compute(); },
    useEffect(effect) { cursor++; effects.push(effect); },
  };
  const jsx = (type, props, key) => ({ type, props: props || {}, key });
  const component = { exports: {} };
  Function("require", "module", "exports", compiled.outputText)(
    (specifier) => specifier === "react" ? react
      : specifier === "react/jsx-runtime" ? { jsx, jsxs: jsx }
        : {},
    component, component.exports,
  );
  const previousWindow = global.window;
  global.window = {
    codexWebLauncher: api,
    codingTools: { apps: { invoke: async () => ({}) } },
  };
  return {
    render() {
      cursor = 0;
      effects = [];
      return component.exports.OriginalUiSurface({ toolId, language: "en", setError: () => {} });
    },
    mountEffects() { for (const effect of effects) effect(); },
    opens,
    restore() { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; },
  };
}

function find(node, predicate) {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean) || null;
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("Reload visual remounts CPA's same-URL iframe but keeps Codex Router's iframe identity", async () => {
  for (const toolId of ["cpa", "codex-router"]) {
    const surface = mount(toolId);
    try {
      surface.render();
      surface.mountEffects();
      await settle();
      const before = find(surface.render(), (node) => node.type === "iframe");
      assert.ok(before, `${toolId} frame opened`);

      const button = find(surface.render(), (node) => node.type === "button" && node.props.className === "primary");
      button.props.onClick();
      await settle();
      const after = find(surface.render(), (node) => node.type === "iframe");
      assert.equal(after.props.src, before.props.src, "open returned the same URL");
      assert.equal(surface.opens.length, 2, "hostbar invoked open again");
      if (toolId === "cpa") assert.notEqual(after.key, before.key, "CPA frame remounts");
      else assert.equal(after.key, before.key, "Router frame identity stays stable");
    } finally {
      surface.restore();
    }
  }
});
