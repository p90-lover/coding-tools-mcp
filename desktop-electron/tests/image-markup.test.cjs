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

const shape = (kind, x1, y1, x2, y2) => ({ kind, x1, y1, x2, y2, color: "#dc2626", width: 4 });

test("shape descriptions use the drawn box bounds, including reverse drags and image-edge clamping", () => {
  const marks = [shape("rectangle", 900, 400, 100, 100), shape("ellipse", -100, 550, 1100, -50)];
  const paths = [];
  markup.drawMarks({ save() {}, restore() {}, beginPath() {}, stroke() {},
    rect: (...args) => paths.push(["rectangle", ...args]), ellipse: (...args) => paths.push(["ellipse", ...args]),
  }, marks);
  assert.deepEqual(paths[0], ["rectangle", 100, 100, 800, 300]);
  assert.deepEqual(paths[1], ["ellipse", 500, 250, 600, 300, 0, 0, Math.PI * 2]);
  assert.deepEqual([...markup.shapeLines(marks, 1000, 500)], [
    "Rectangle bounds: (x: 10.0%, y: 20.0%) to (x: 90.0%, y: 80.0%).",
    "Ellipse bounds: (x: 0.0%, y: 0.0%) to (x: 100.0%, y: 100.0%).",
  ]);
});

test("shape descriptions keep arrow direction and line endpoints without duplicating pins or freehand marks", () => {
  const marks = [pin(0, 0, "pin"), shape("arrow", 900, 400, 100, 50),
    { kind: "pen", points: [[0, 0], [5, 5]], color: "#dc2626", width: 4 }, shape("line", 0, 250, 1000, 250)];
  assert.deepEqual([...markup.shapeLines(marks, 1000, 500)], [
    "Arrow from (x: 90.0%, y: 80.0%) to (x: 10.0%, y: 10.0%).",
    "Line from (x: 0.0%, y: 50.0%) to (x: 100.0%, y: 50.0%).",
  ]);
});

// Like the composer callback tests: execute the actual editor handlers, with state setters kept
// outside their render's captured values. No canvas image or installed application is needed.
function editorCallback(name, globals) {
  const file = "ImagePreview.tsx", source = fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const editor = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "MarkupEditor");
  let body;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) body = node.initializer;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) body = node;
    ts.forEachChild(node, visit);
  };
  assert.ok(editor); visit(editor); assert.ok(body, name);
  const exports = {};
  vm.runInNewContext(ts.transpileModule("exports.callback = " + body.getText(tree), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, ...globals });
  return exports.callback;
}

test("a released shape reaches Add to chat as both image input and agent instructions", async () => {
  const live = { current: shape("rectangle", 900, 400, 100, 100) };
  let marks = [], exported, sent;
  editorCallback("up", { live, marks, commit: next => { marks = next; }, redraw() {} })();
  assert.equal(live.current, null);
  assert.equal(marks.length, 1);
  const bytes = new Uint8Array([1, 2, 3]);
  await editorCallback("finish", { image: { current: {} }, busy: false, draft: null, marks, natural: { width: 1000, height: 500 },
    setBusy() {}, setError(message) { assert.equal(message, ""); }, Blob,
    URL: { createObjectURL: () => "blob:marked-image" }, markupPrompt: markup.markupPrompt,
    exportMarkup: async (_image, value) => { exported = value; return bytes; }, onDone: async value => { sent = value; },
  })();
  assert.equal(exported, marks);
  assert.equal(sent.bytes, bytes);
  assert.equal(sent.preview, "blob:marked-image");
  assert.equal(sent.prompt, "Rectangle bounds: (x: 10.0%, y: 20.0%) to (x: 90.0%, y: 80.0%).");
});

for (const scenario of [
  { name: "a new pin", isNew: true, before: "", text: "  latest pin draft  ", expected: "latest pin draft" },
  { name: "an edited pin", isNew: false, before: "before editing", text: "  revised pin draft  ", expected: "revised pin draft" },
  { name: "an empty new pin", isNew: true, before: "", text: "   ", expected: undefined },
]) test(`Add to chat commits ${scenario.name}'s open draft in that same image and prompt`, async () => {
  const marks = [pin(50, 25, scenario.before), shape("arrow", 0, 0, 100, 100)];
  const draft = { index: 0, text: scenario.text, isNew: scenario.isNew };
  let finalMarks = marks, exported, sent;
  const saveDraft = editorCallback("saveDraft", { marks, draft, setMarks: next => { finalMarks = next; }, setHistory() {}, setUndone() {}, setDraft() {} });
  await editorCallback("finish", { image: { current: {} }, busy: false, marks, draft, saveDraft, natural: { width: 100, height: 100 },
    setBusy() {}, setError(message) { assert.equal(message, ""); }, Blob,
    URL: { createObjectURL: () => "blob:marked-image" }, markupPrompt: markup.markupPrompt,
    exportMarkup: async (_image, value) => { exported = value; return new Uint8Array([1]); }, onDone: async value => { sent = value; },
  })();
  assert.equal(finalMarks.find(mark => mark.kind === "comment")?.text, scenario.expected);
  assert.equal(exported.find(mark => mark.kind === "comment")?.text, scenario.expected,
    "the PNG input uses the committed annotation list, not the prior render's marks");
  assert.equal(sent.prompt, markup.markupPrompt(finalMarks, 100, 100));
  if (scenario.expected) assert.ok(sent.prompt.includes(scenario.expected));
  else assert.doesNotMatch(sent.prompt, /^1\./m, "an abandoned empty pin is absent from the submission");
});
