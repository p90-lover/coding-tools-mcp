"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const features = path.resolve(__dirname, "../src/features");
const css = fs.readFileSync(path.join(features, "agent-orchestrator.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const controls = fs.readFileSync(path.join(features, "AgentOrchestratorComposerControls.tsx"), "utf8");
function rule(selector) {
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const block = blocks.find(([, selectors]) => selectors.trim() === selector);
  assert.ok(block, `missing style rule: ${selector}`);
  return block[2];
}
test("model picker is slimmer without losing viewport and available-height bounds", () => {
  const popup = rule(".ao-workflow .ao-composer-popover.ao-model-popup");
  assert.match(popup, /width:\s*min\(248px,\s*calc\(100vw - 32px\)\)/);
  assert.match(popup, /max-height:\s*min\(320px,\s*52dvh,\s*var\(--ao-picker-room,\s*100dvh\)\)/);
  assert.match(popup, /padding:\s*6px/);
  assert.match(popup, /gap:\s*4px/);
});
test("model search has compact explicit sizing and never shrinks into the scroller", () => {
  const search = rule(".ao-workflow .ao-model-popup .ao-model-search");
  assert.match(search, /flex:\s*none/);
  assert.match(search, /height:\s*28px/);
  assert.match(search, /min-height:\s*28px/);
  assert.match(search, /padding:\s*0 8px/);
  const list = rule(".ao-workflow .ao-model-options");
  assert.match(list, /min-height:\s*0/);
  assert.match(list, /overflow-y:\s*auto/);
  assert.match(list, /overscroll-behavior:\s*contain/);
});
test("only model rows lose duplicate radio circles and keep accessible selection and logos", () => {
  const option = rule(".ao-workflow .ao-model-popup .ao-picker-option");
  assert.match(option, /margin:\s*0;/);
  assert.match(option, /min-height:\s*24px/);
  assert.match(option, /padding:\s*4px 6px/);
  assert.match(option, /font-size:\s*12px/);
  assert.match(rule(".ao-workflow .ao-model-popup .ao-option-radio"), /display:\s*none/);
  assert.match(controls, /role="radio" aria-checked=\{picked\}/);
  assert.match(controls, /picked \? <Icon name="check"/);
  assert.match(controls, /<ModelLogo model=\{model\}/);
});
test("slim rows give long names the remaining width and preserve full-name tooltips", () => {
  const row = rule(".ao-workflow .ao-model-popup .ao-model-row");
  assert.match(row, /display:\s*flex/);
  assert.match(row, /gap:\s*6px/);
  assert.match(rule(".ao-workflow .ao-model-row > span:last-child"), /text-overflow:\s*ellipsis/);
  assert.match(controls, /title=\{\[modelLabel\(model, viaPool\(model\)\), model, full, held\[model\]\]/);
  assert.match(rule(".ao-workflow .ao-model-popup .ao-model-group > h4"), /margin:\s*4px 6px 2px/);
});
