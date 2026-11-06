const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const load = (file, imports = {}) => {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => imports[name] ?? (name === "react/jsx-runtime" ? require(name) : {}) });
  return exports;
};
const usage = load("cpa-usage.ts");
function render(report, active = true, zh = false) {
  const states = ["7d", report];
  let cursor = 0;
  const react = { useState: () => [states[cursor++], () => {}], useEffect() {} };
  const preview = load("CpaPreviewSpend.tsx", { react, "./cpa-usage": usage, "./page-visibility": { useSurfaceHidden: () => () => false } });
  return renderToStaticMarkup(preview.CpaPreviewSpend({ active, zh }));
}

test("CPA preview shows dollars from its usage totals with an honest price source", () => {
  const html = render({ available: true, range: "7d", totals: { cost: 12.34, costSource: "estimate", costPartial: false } });
  assert.match(html, /~\$12\.34/);
  assert.match(html, /API-price estimate/);
  assert.match(html, /built-in list-price table/);
  assert.match(html, /Not subscription charges or remaining credit/);
  assert.match(html, /aria-label="Cost period"/);
});

test("partial pricing is visibly marked and unknown pricing is not zero dollars", () => {
  assert.match(render({ available: true, totals: { cost: 2, costSource: "mixed", costPartial: true } }), /~\$2\.00\+/);
  for (const report of [{ available: false }, { available: true, totals: { cost: null } }, { available: true, totals: { cost: Infinity } }]) {
    const html = render(report);
    assert.match(html, /<strong[^>]*>Null<\/strong>/);
    assert.doesNotMatch(html, /\$0\.00/);
  }
});

test("an actual recorded zero differs from loading, offline and unknown cost", () => {
  assert.match(render({ available: true, totals: { cost: 0, costSource: null, costPartial: false } }), /\$0\.00/);
  assert.match(render(null), /Loading…/);
  assert.match(render(null, false), /Offline/);
  assert.match(render({ available: false }, true, true), /<strong[^>]*>Null<\/strong>/);
});

test("CPA preview cost stays outside the plugin frame and only on CPA", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/OriginalUiSurface.tsx"), "utf8");
  assert.match(source, /toolId === "cpa" \? <CpaPreviewSpend active=\{ready\}/);
  assert.ok(source.indexOf("<CpaPreviewSpend") < source.indexOf('<div className="original-ui-frame-shell">'));
});
