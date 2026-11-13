const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/link-preview.ts"), "utf8");
const output = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
}).outputText, { exports: output, URL });

function events() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, fn) { assert.ok(!listeners.has(name)); listeners.set(name, fn); },
    removeEventListener(name, fn) { assert.equal(listeners.get(name), fn); listeners.delete(name); },
    fire(name, event = {}) { listeners.get(name)?.(event); },
  };
}
function fixture() {
  let paletteReads = 0;
  const win = { ...events(), getComputedStyle(link) { paletteReads++; return { getPropertyValue: name => link.palette[name] || "" }; } };
  const body = [], styles = new Map();
  let writes = 0, value = "";
  const preview = { hidden: false, setAttribute(name, value) { this[name] = value; }, remove() { body.splice(body.indexOf(this), 1); },
    style: { setProperty: (name, value) => styles.set(name, value), removeProperty: name => styles.delete(name) },
    get textContent() { return value; }, set textContent(next) { writes++; value = next; } };
  const doc = { ...events(), baseURI: "https://app.example.test/chat/", hidden: false, defaultView: win,
    createElement(name) { assert.equal(name, "div"); return preview; }, body: { append(element) { body.push(element); } } };
  const dispose = output.installLinkPreview(doc);
  const anchor = (href, keyboard = false) => {
    const link = { palette: { "--color-background-elevated": "#fff", "--color-text-secondary": "#73726c" }, getAttribute(name) { return name === "href" ? href : null; }, matches(selector) { assert.equal(selector, ":focus-visible"); return keyboard; }, closest(selector) { assert.equal(selector, "a[href]"); return this; } };
    return link;
  };
  return { doc, win, body, preview, dispose, anchor, styles, writes: () => writes, paletteReads: () => paletteReads };
}

test("nested link hover shows the actual destination and follows links without layout or click handlers", () => {
  const f = fixture();
  assert.equal(f.preview.hidden, true);
  const first = f.anchor("https://example.test/releases?x=1&y=2");
  const child = { closest: () => first };
  f.doc.fire("pointerover", { target: child, pointerType: "mouse" });
  assert.equal(f.preview.textContent, "https://example.test/releases?x=1&y=2");
  assert.equal(f.preview.hidden, false);
  assert.equal(f.preview["aria-hidden"], "true");
  assert.equal(f.styles.get("--color-background-elevated"), "#fff", "body-level strip uses the light chat's scoped palette");
  assert.equal(f.styles.get("--color-text-secondary"), "#73726c");
  const reads = f.paletteReads();
  const writes = f.writes();
  f.doc.fire("pointerover", { target: first, pointerType: "mouse" });
  f.doc.fire("pointerout", { relatedTarget: child, pointerType: "mouse" });
  assert.equal(f.writes(), writes, "moving between children does not rewrite the URL");
  assert.equal(f.paletteReads(), reads, "moving inside one anchor does not read styles again");
  const next = f.anchor("../download");
  next.palette = { "--color-background-elevated": "#30302e" };
  f.doc.fire("pointerout", { relatedTarget: next, pointerType: "mouse" });
  assert.equal(f.preview.textContent, "https://app.example.test/download");
  assert.equal(f.styles.get("--color-background-elevated"), "#30302e", "next pane's dark palette replaces the old one");
  assert.equal(f.styles.has("--color-text-secondary"), false, "missing tokens do not retain the previous pane's palette");
  f.doc.fire("pointerout", { relatedTarget: null });
  assert.equal(f.preview.hidden, true);
  assert.equal(f.body.length, 1);
  assert.ok(!f.doc.listeners.has("click"), "does not intercept navigation");
});

test("keyboard focus is previewed, mouse focus and touch do not leave a sticky status", () => {
  const f = fixture();
  const keyboard = f.anchor("https://example.test/keyboard", true);
  f.doc.fire("focusin", { target: keyboard });
  assert.equal(f.preview.textContent, "https://example.test/keyboard");
  const hover = f.anchor("https://example.test/mouse");
  f.doc.fire("pointerover", { target: hover, pointerType: "mouse" });
  assert.equal(f.preview.textContent, "https://example.test/mouse");
  f.doc.fire("pointerout", { relatedTarget: null });
  assert.equal(f.preview.textContent, "https://example.test/keyboard");
  f.doc.fire("focusout");
  assert.equal(f.preview.hidden, true);
  f.doc.fire("focusin", { target: hover });
  f.doc.fire("pointerover", { target: hover, pointerType: "touch" });
  assert.equal(f.preview.hidden, true);
});

test("leave, Escape, scroll, window blur and hiding dismiss the destination", () => {
  const f = fixture();
  const show = () => f.doc.fire("pointerover", { target: f.anchor("https://example.test/path"), pointerType: "mouse" });
  for (const dismiss of [() => f.doc.fire("pointerover", { target: {} }), () => f.doc.fire("keydown", { key: "Escape" }), () => f.doc.fire("scroll"), () => f.win.fire("blur"), () => { f.doc.hidden = true; f.doc.fire("visibilitychange"); }]) {
    show(); assert.equal(f.preview.hidden, false);
    dismiss(); assert.equal(f.preview.hidden, true);
  }
  f.doc.hidden = false;
  f.doc.fire("pointerover", { target: f.anchor("") });
  assert.equal(f.preview.hidden, true);
  f.dispose();
  assert.equal(f.doc.listeners.size, 0);
  assert.equal(f.win.listeners.size, 0);
  assert.equal(f.body.length, 0);
});

test("the slim themed strip is non-interactive, viewport-bounded and installed once at bootstrap", () => {
  const css = fs.readFileSync(path.join(__dirname, "../src/features/link-preview.css"), "utf8");
  assert.match(css, /position:\s*fixed/);
  assert.match(css, /max-width:\s*min\(560px, calc\(100vw - 16px\)\)/);
  assert.match(css, /pointer-events:\s*none/);
  assert.match(css, /white-space:\s*nowrap/);
  assert.match(css, /text-overflow:\s*ellipsis/);
  assert.match(css, /var\(--color-background-elevated\)/);
  const main = fs.readFileSync(path.join(__dirname, "../src/main.tsx"), "utf8");
  assert.equal((main.match(/installLinkPreview\(\)/g) ?? []).length, 1);
  assert.match(main, /import "\.\/features\/link-preview\.css"/);
  assert.doesNotMatch(source, /innerHTML|fetch\(|setInterval|querySelectorAll|requestAnimationFrame/);
});
