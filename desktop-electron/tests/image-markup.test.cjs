const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function load(file) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports });
  return exports;
}
const markup = load("image-markup.ts");
const pin = (x, y, text) => ({ kind: "comment", x, y, size: 24, text });

test("the agent reads each pin as Codex writes it: number, centre as a share of the image, comment", () => {
  const marks = [pin(891, 560, "This button should be disabled"), { kind: "ellipse", x1: 0, y1: 0, x2: 10, y2: 10, color: "#dc2626", width: 4 }, pin(0, 1000, "")];
  const lines = markup.markupPrompt(marks, 1000, 800).split("\n\n")[0].split("\n");
  assert.equal(lines[0], "1. (x: 89.1%, y: 70.0%) This button should be disabled");
  assert.equal(lines[1], "2. (x: 0.0%, y: 100.0%)", "clamped to 0-100 %, one decimal, numbered in document order");
  assert.equal(markup.markupReadable(lines.join("\n")), "1. This button should be disabled\n2. (x: 0.0%, y: 100.0%)",
    "a sent message shows the comment without its coordinates (only a line with a comment matches Codex's pattern)");
});

test("the preview's zoom steps through Codex's ramp with the fit value in it", () => {
  assert.equal(markup.zoomStep(51, 51, 1), 67);
  assert.equal(markup.zoomStep(51, 51, -1), 50);
  assert.equal(markup.zoomStep(500, 51, 1), 500, "never past 500 %");
  assert.equal(markup.clampZoom(5, 51), 25);
});

test("Shift draws a circle, not an oval, and snaps an arrow to 45°", () => {
  assert.deepEqual([...markup.constrainShape("ellipse", 0, 0, 30, 10)], [30, 30]);
  const [x, y] = markup.constrainShape("arrow", 0, 0, 10, 9);
  assert.ok(Math.abs(x - y) < 1e-9, "a near-diagonal arrow becomes exactly diagonal");
});
