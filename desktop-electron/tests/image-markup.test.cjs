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
function editorCallback(name, globals, editorName = "MarkupEditor") {
  const file = "ImagePreview.tsx", source = fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const editor = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === editorName);
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
  }).outputText, { exports, Error, ...globals });
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

// Asked for 2026-11-03: the preview "exact the same" as Codex's, with its tool bar (Codex 26.1016).
test("the preview's tools carry Codex's instructions verbatim, and its tool bar is Codex's", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/ImagePreview.tsx"), "utf8");
  assert.ok(source.includes('export const REMOVE_BG_PROMPT = "Remove the background from this image. Keep all foreground subjects unchanged and fully intact, with clean, smooth edges. Make the background transparent.";'));
  assert.ok(source.includes('export const ERASE_PROMPT = "Remove the area marked in the second image from the first image";'));
  assert.ok(source.includes("export const resizePrompt = (ratio: string) => `Make the aspect ratio ${ratio}`;"));
  for (const ratio of ['["Square", "1:1"', '["Portrait", "3:4"', '["Story", "9:16"', '["Landscape", "4:3"', '["Widescreen", "16:9"']) assert.ok(source.includes(ratio), ratio);
  const bar = source.slice(source.indexOf('aria-label="Image editing tools"'), source.indexOf("Beside the scroller"));
  assert.deepEqual([...bar.matchAll(/<span>(Markup|Comment|Remove BG|Erase|Resize)<\/span>/g)].map((match) => match[1]), ["Markup", "Comment", "Remove BG", "Erase", "Resize"]);
  assert.ok(bar.includes('aria-label="Move toolbar"'), "a drag handle first");
  for (const label of ['aria-label="Download"', 'aria-label="Close viewer" title="Close viewer"', 'title="Zoom"', "File actions for"]) assert.ok(source.includes(label), label);
  assert.ok(source.includes("const ZOOM_CHOICES = [25, 50, 100, 150, 200];") && source.includes("Zoom to fit"));
});

test("Erase's strokes are round, and a tap leaves a dot", () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (target, key) => key in target ? target[key] : (...args) => calls.push([key, ...args]), set: (target, key, value) => { target[key] = value; calls.push([`=${String(key)}`, value]); return true; } });
  markup.paintStrokes(ctx, [{ points: [[10, 20]], width: 30 }, { points: [[0, 0], [5, 5]], width: 8 }, { points: [], width: 4 }], "#fff");
  assert.deepEqual(calls.filter(([name]) => !name.startsWith("=")), [["beginPath"], ["moveTo", 10, 20], ["lineTo", 10.01, 20], ["stroke"], ["beginPath"], ["moveTo", 0, 0], ["lineTo", 5, 5], ["stroke"]]);
  assert.deepEqual(calls.filter(([name]) => name === "=lineWidth").map(([, value]) => value), [30, 8], "each stroke keeps the brush it was drawn with");
  assert.equal(ctx.lineCap, "round"); assert.equal(ctx.strokeStyle, "#fff");
});

test("image tools release their derived previews when the composer rejects them", async () => {
  for (const tool of ["bg", "resize", "erase", "markup"]) {
    const created = [], revoked = [], errors = [];
    let closed = 0;
    const URL = {
      createObjectURL: () => { const url = `blob:${tool}-${created.length}`; created.push(url); return url; },
      revokeObjectURL: url => revoked.push(url),
    };
    const onMarkup = async () => { throw new Error("Remove an attachment and try again"); };
    const finish = editorCallback("finish", { URL, onMarkup, onClose: () => { closed += 1; } }, "ImagePreviewDialog");
    const globals = {
      URL, Blob, image: { current: {} }, shownImage: { current: {} }, natural: { width: 10, height: 10 },
      busy: false, sending: null, draft: null, marks: [], strokes: [{ points: [[1, 1]], width: 2 }],
      setBusy() {}, setSending() {}, setMenu() {}, setError: value => { if (value) errors.push(value); },
      exportMarkup: async () => new Uint8Array([1]), exportEraseMask: async () => new Uint8Array([2]),
      markupPrompt: () => "Markup instructions", ERASE_PROMPT: "Erase instructions", onDone: finish,
      onMarkup, onClose: () => { closed += 1; }, finish,
    };
    if (tool === "bg" || tool === "resize") await editorCallback("send", globals, "ImagePreviewDialog")(tool, "Instructions", "Image tool");
    else await editorCallback(tool === "erase" ? "send" : "finish", globals, tool === "erase" ? "EraseEditor" : "MarkupEditor")();
    assert.equal(created.length, tool === "erase" ? 2 : 1, tool);
    assert.deepEqual(revoked, created, `${tool}: only newly allocated previews are released`);
    assert.equal(closed, 0, `${tool}: admission failure leaves the viewer open`);
    assert.deepEqual(errors, ["Remove an attachment and try again"], tool);
  }
});

test("image preview adoption transfers URL ownership before closing the viewer", async () => {
  const revoked = [];
  const result = { bytes: new Uint8Array([1]), preview: "blob:derived", prompt: "Instructions", mask: { bytes: new Uint8Array([2]), preview: "blob:mask" } };
  let adopted;
  const finish = editorCallback("finish", {
    URL: { revokeObjectURL: value => revoked.push(value) },
    onMarkup: async value => { adopted = value; }, onClose: () => { throw new Error("Close failed"); },
  }, "ImagePreviewDialog");
  await assert.rejects(finish(result), /Close failed/);
  assert.equal(adopted, result);
  assert.deepEqual(revoked, [], "the composer owns both previews even if closing fails afterward");
});

test("an absent image consumer cannot adopt preview URLs", async () => {
  const revoked = [];
  let closed = false;
  const finish = editorCallback("finish", {
    URL: { revokeObjectURL: value => revoked.push(value) }, onMarkup: undefined, onClose: () => { closed = true; },
  }, "ImagePreviewDialog");
  await assert.rejects(finish({ bytes: new Uint8Array([1]), preview: "blob:derived", prompt: "Instructions" }), /unavailable/);
  assert.deepEqual(revoked, ["blob:derived"]);
  assert.equal(closed, false);
});

test("Erase releases an allocated source preview if mask preview allocation fails", async () => {
  const revoked = [];
  let created = 0, handedOff = false;
  await editorCallback("send", {
    image: { current: {} }, busy: false, strokes: [{ points: [[1, 1]], width: 2 }], natural: { width: 10, height: 10 },
    setBusy() {}, setError() {}, exportMarkup: async () => new Uint8Array([1]), exportEraseMask: async () => new Uint8Array([2]), Blob,
    URL: { createObjectURL: () => { if (created++) throw new Error("Allocation failed"); return "blob:source"; }, revokeObjectURL: value => revoked.push(value) },
    ERASE_PROMPT: "Erase instructions", onDone: async () => { handedOff = true; },
  }, "EraseEditor")();
  assert.equal(handedOff, false);
  assert.deepEqual(revoked, ["blob:source"]);
});
