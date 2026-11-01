const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function load(document) {
  const exports = {};
  const react = { createContext: (value) => ({ value }), useCallback: (fn) => fn, useContext: (context) => context.value, useRef: (current) => ({ current }) };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features/page-visibility.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, document, require: (name) => { if (name !== "react") throw new Error(name); return react; } });
  return exports;
}

test("pageHidden is true for a hidden page and for a minimized window the preload marked away", () => {
  const away = new Set();
  const document = { visibilityState: "visible", documentElement: { hasAttribute: (name) => away.has(name) } };
  const { pageHidden } = load(document);
  assert.equal(pageHidden(), false);
  away.add("data-window-away");
  assert.equal(pageHidden(), true, "minimized: the page still reads visible");
  away.clear();
  document.visibilityState = "hidden";
  assert.equal(pageHidden(), true);
});
