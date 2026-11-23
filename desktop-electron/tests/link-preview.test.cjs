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
}).outputText, { exports: output, URL, require: () => ({}) });
const REST = output.LINK_PREVIEW_REST_MS;

function events() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, fn) { assert.ok(!listeners.has(name)); listeners.set(name, fn); },
    removeEventListener(name, fn) { assert.equal(listeners.get(name), fn); listeners.delete(name); },
    fire(name, event = {}) { listeners.get(name)?.(event); },
  };
}

/** Just enough of an element for the card: children, text, classes, data, style and images. */
function element(tag, counters) {
  const own = new Map();
  const node = {
    tagName: tag.toUpperCase(), className: "", hidden: false, dir: "", children: [], parent: null, dataset: {},
    textValue: "", attributes: {}, offsetWidth: 340, offsetHeight: 120, naturalWidth: 1200, naturalHeight: 600,
    style: { props: new Map(), setProperty(name, value) { this.props.set(name, value); }, removeProperty(name) { this.props.delete(name); } },
    get textContent() { return this.textValue + this.children.map((child) => child.textContent).join(""); },
    set textContent(value) { this.textValue = value; this.children = []; },
    setAttribute(name, value) { this.attributes[name] = value; },
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } },
    replaceChildren(...items) { counters.renders += 1; this.children = []; this.append(...items); },
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
    addEventListener(name, fn) { own.set(name, fn); },
    emit(name) { own.get(name)?.(); },
  };
  return node;
}

function find(root, className) {
  if (root.className.split(" ").includes(className)) return root;
  for (const child of root.children) { const hit = find(child, className); if (hit) return hit; }
  return null;
}

function fixture({ load, width = 1000, height = 800, baseURI = "https://app.example.test/chat/" } = {}) {
  let clock = 0, nextTimer = 1, paletteReads = 0;
  const timers = new Map();
  const counters = { renders: 0 };
  const win = {
    ...events(), innerWidth: width, innerHeight: height,
    getComputedStyle(item) {
      if (!item.palette) return { backgroundColor: item.style.props.get("--color-background-elevated") === "#30302e" ? "rgb(48, 48, 46)" : "rgb(255, 255, 255)" };
      paletteReads++;
      return { getPropertyValue: (name) => item.palette[name] || "" };
    },
    setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const advance = (ms) => {
    clock += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
  };
  const body = { children: [], append(item) { item.parent = this; this.children.push(item); } };
  const doc = { ...events(), baseURI, hidden: false, defaultView: win, body, createElement: (tag) => element(tag, counters) };
  const dispose = output.installLinkPreview(doc, load ? { load } : undefined);
  const card = body.children[0];
  const anchor = (href, { keyboard = false, rects = [{ left: 100, top: 200, right: 180, bottom: 216 }] } = {}) => ({
    palette: { "--color-background-elevated": "#fff", "--color-text-secondary": "#73726c" },
    getAttribute(name) { return name === "href" ? href : null; },
    matches(selector) { assert.equal(selector, ":focus-visible"); return keyboard; },
    closest(selector) { assert.equal(selector, "a[href]"); return this; },
    getClientRects() { return rects; },
    getBoundingClientRect() { return rects[0]; },
  });
  const hover = (link, at = { clientX: 120, clientY: 208 }) => doc.fire("pointerover", { target: link, pointerType: "mouse", ...at });
  const text = (className) => find(card, className)?.textContent;
  return { doc, win, body, card, dispose, anchor, hover, advance, text, timers, counters, paletteReads: () => paletteReads };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const PAGE = {
  ok: true, kind: "page", url: "https://github.com/p90-lover/coding-tools-mcp/pull/1326", host: "github.com",
  title: "fix(cpa): brace capture groups · Pull Request #1326", description: "Go's regexp.Expand reads $1x as a group named 1x.",
  siteName: "GitHub", icon: "data:image/png;base64,AAAA", image: "data:image/png;base64,BBBB",
};

test("a rested pointer opens the page's card under the link; moving inside the link changes nothing", async () => {
  const asked = [];
  let answer;
  const f = fixture({ load: (url) => { asked.push(url); return new Promise((resolve) => { answer = resolve; }); } });
  assert.equal(f.card.hidden, true);
  assert.equal(f.card.attributes["aria-hidden"], "true");
  const link = f.anchor("https://github.com/p90-lover/coding-tools-mcp/pull/1326#discussion");
  f.hover({ closest: () => link });
  f.advance(REST - 1);
  assert.equal(f.card.hidden, true, "passing over a link opens nothing");
  f.advance(1);
  assert.equal(f.card.hidden, false);
  assert.equal(f.card.dataset.state, "loading");
  assert.equal(f.text("cx-link-preview-site"), "github.com");
  assert.equal(f.text("cx-link-preview-note"), "Loading preview…");
  assert.equal(f.text("cx-link-preview-url"), "https://github.com/p90-lover/coding-tools-mcp/pull/1326#discussion");
  assert.equal(f.card.style.left, "100px");
  assert.equal(f.card.style.top, "222px", "6 px under the link");
  assert.equal(f.card.style.props.get("--color-background-elevated"), "#fff", "the hovered chat's palette");
  await flush();
  assert.deepEqual(asked, ["https://github.com/p90-lover/coding-tools-mcp/pull/1326"], "read once, without the fragment");

  answer(PAGE);
  await flush();
  assert.equal(f.card.dataset.state, "page");
  assert.equal(f.text("cx-link-preview-site"), "GitHub");
  assert.equal(find(f.card, "cx-link-preview-icon").src, PAGE.icon);
  assert.equal(f.text("cx-link-preview-title"), PAGE.title);
  assert.equal(f.text("cx-link-preview-description"), PAGE.description);
  assert.equal(find(f.card, "cx-link-preview-note"), null);
  const image = find(f.card, "cx-link-preview-image");
  assert.equal(image.src, PAGE.image);
  image.emit("load");
  assert.equal(f.card.dataset.image, "wide", "a 2:1 share image runs across the top");

  const renders = f.counters.renders, reads = f.paletteReads();
  f.hover(link);
  f.doc.fire("pointerout", { relatedTarget: { closest: () => link }, pointerType: "mouse" });
  assert.equal(f.counters.renders, renders, "moving between the link's children does not redraw");
  assert.equal(f.paletteReads(), reads);
  assert.equal(f.card.dataset.tone, "light");
  f.doc.fire("pointerout", { relatedTarget: null, pointerType: "mouse" });
  assert.equal(f.card.hidden, true);
  assert.equal(f.body.children.length, 1);
  assert.ok(!f.doc.listeners.has("click"), "does not intercept navigation");

  const dark = f.anchor("https://example.test/dark");
  dark.palette = { "--color-background-elevated": "#30302e" };
  f.hover(dark); f.advance(REST);
  assert.equal(f.card.style.props.get("--color-background-elevated"), "#30302e", "the next chat's dark palette replaces the old one");
  assert.equal(f.card.style.props.has("--color-text-secondary"), false, "a missing token keeps nothing of the previous chat's");
  assert.equal(f.card.dataset.tone, "dark", "a dark card puts favicons on a light chip");
});

test("the card flips above a link near the bottom, stays inside the window and follows the hovered line", () => {
  const f = fixture({ width: 600, height: 400 });
  f.hover(f.anchor("https://example.test/a", { rects: [{ left: 500, top: 360, right: 590, bottom: 376 }] }), { clientX: 550, clientY: 370 });
  f.advance(REST);
  assert.equal(f.card.style.top, `${360 - 6 - 120}px`);
  assert.equal(f.card.style.left, `${600 - 340 - 8}px`);
  f.doc.fire("pointerout", { relatedTarget: null, pointerType: "mouse" });
  // A link wrapped over two lines: the card hangs from the line under the pointer.
  const wrapped = f.anchor("https://example.test/b", { rects: [{ left: 300, top: 100, right: 560, bottom: 116 }, { left: 20, top: 118, right: 90, bottom: 134 }] });
  f.hover(wrapped, { clientX: 40, clientY: 125 });
  f.advance(REST);
  assert.equal(f.card.style.left, "20px");
  assert.equal(f.card.style.top, "140px");
});

test("answers are reused, a failed read is asked again, and a late answer for another link is dropped", async () => {
  const asked = [];
  const answers = new Map();
  const f = fixture({ load: (url) => { asked.push(url); return new Promise((resolve, reject) => answers.set(url, { resolve, reject })); } });
  const a = f.anchor("https://a.test/"), b = f.anchor("https://b.test/");
  f.hover(a); f.advance(REST); await flush();
  f.doc.fire("pointerout", { relatedTarget: null, pointerType: "mouse" });
  f.hover(b); f.advance(REST); await flush();
  answers.get("https://a.test/").resolve({ ...PAGE, title: "A's title" });
  await flush();
  assert.equal(f.card.dataset.state, "loading", "A's answer does not land on B's card");
  assert.equal(f.text("cx-link-preview-url"), "https://b.test/");
  answers.get("https://b.test/").reject(new Error("IPC_TRANSPORT_FAILED"));
  await flush();
  assert.equal(f.card.dataset.state, "link", "a failed read leaves the address");
  assert.equal(f.text("cx-link-preview-site"), "b.test");
  f.doc.fire("pointerout", { relatedTarget: null, pointerType: "mouse" });
  f.hover(a); f.advance(REST); await flush();
  assert.equal(f.text("cx-link-preview-title"), "A's title");
  f.doc.fire("pointerout", { relatedTarget: null, pointerType: "mouse" });
  f.hover(b); f.advance(REST); await flush();
  assert.deepEqual(asked, ["https://a.test/", "https://b.test/", "https://b.test/"], "A was read once; B is read again after failing");
});

test("refusals, files and non-web links say what they are", async () => {
  const answers = {
    "http://127.0.0.1:8317/": { ok: false, url: "http://127.0.0.1:8317/", host: "127.0.0.1", reason: "private" },
    "https://gone.test/": { ok: false, url: "https://gone.test/", host: "gone.test", reason: "http-404" },
    "https://files.test/paper.pdf": { ok: true, kind: "file", url: "https://files.test/paper.pdf", host: "files.test", contentType: "application/pdf", size: 1258291 },
  };
  const asked = [];
  const f = fixture({ load: async (url) => { asked.push(url); return answers[url]; } });
  const open = async (href) => {
    f.doc.fire("pointerout", { relatedTarget: null, pointerType: "mouse" });
    f.hover(f.anchor(href)); f.advance(REST); await flush();
  };
  await open("http://127.0.0.1:8317/");
  assert.equal(f.card.dataset.state, "error");
  assert.equal(f.text("cx-link-preview-note"), "Local address: not previewed");
  await open("https://gone.test/");
  assert.equal(f.text("cx-link-preview-note"), "Page not found (404)");
  await open("https://files.test/paper.pdf");
  assert.equal(f.card.dataset.state, "file");
  assert.equal(f.text("cx-link-preview-title"), "PDF · 1.2 MB");
  await open("file:///G:/aiTemp/orchestrator-handler/CHECKPOINT.md");
  assert.equal(f.card.dataset.state, "link");
  assert.equal(find(f.card, "cx-link-preview-site"), null);
  assert.equal(f.text("cx-link-preview-url"), "file:///G:/aiTemp/orchestrator-handler/CHECKPOINT.md");
  assert.equal(asked.includes("file:///G:/aiTemp/orchestrator-handler/CHECKPOINT.md"), false, "only web pages are read");
  assert.equal(output.previewReason("http-403"), "The site needs a sign-in (403)");
  assert.equal(output.previewReason("timeout"), "The site took too long to answer");
  assert.equal(output.fileLabel("image/png", 900), "Image · 900 B");
});

test("keyboard focus opens at once, a move between open links needs no rest, and touch never opens one", () => {
  const f = fixture();
  const keyboard = f.anchor("https://example.test/keyboard", { keyboard: true });
  f.doc.fire("focusin", { target: keyboard });
  assert.equal(f.card.hidden, false);
  assert.equal(f.text("cx-link-preview-url"), "https://example.test/keyboard");
  const mouse = f.anchor("https://example.test/mouse");
  f.hover(mouse);
  assert.equal(f.text("cx-link-preview-url"), "https://example.test/mouse", "the open card follows the pointer at once");
  f.doc.fire("pointerout", { relatedTarget: null, pointerType: "mouse" });
  assert.equal(f.text("cx-link-preview-url"), "https://example.test/keyboard");
  f.doc.fire("focusout");
  assert.equal(f.card.hidden, true);
  f.doc.fire("focusin", { target: mouse });
  f.doc.fire("pointerover", { target: mouse, pointerType: "touch" });
  f.advance(REST);
  assert.equal(f.card.hidden, true);
});

test("leave, Escape, scroll, resize, window blur and hiding dismiss the card; disposal leaves nothing", () => {
  const f = fixture();
  const show = () => { f.hover(f.anchor("https://example.test/path")); f.advance(REST); };
  for (const dismiss of [
    () => f.doc.fire("pointerover", { target: {} }),
    () => f.doc.fire("keydown", { key: "Escape" }),
    () => f.doc.fire("scroll"),
    () => f.win.fire("resize"),
    () => f.win.fire("blur"),
    () => { f.doc.hidden = true; f.doc.fire("visibilitychange"); },
  ]) {
    show(); assert.equal(f.card.hidden, false);
    dismiss(); assert.equal(f.card.hidden, true);
  }
  f.doc.hidden = false;
  for (const href of ["", "#section", "javascript:void(0)"]) {
    f.hover(f.anchor(href)); f.advance(REST);
    assert.equal(f.card.hidden, true, `no card for ${JSON.stringify(href)}`);
  }
  f.hover(f.anchor("https://example.test/pending"));
  assert.equal(f.timers.size, 1);
  f.dispose();
  assert.equal(f.timers.size, 0, "a pending open is cancelled");
  assert.equal(f.doc.listeners.size, 0);
  assert.equal(f.win.listeners.size, 0);
  assert.equal(f.body.children.length, 0);
});

test("the card is inert, themed, bounded and installed once at bootstrap with the main process's reader", () => {
  const css = fs.readFileSync(path.join(__dirname, "../src/features/link-preview.css"), "utf8");
  assert.match(css, /position:\s*fixed/);
  assert.match(css, /width:\s*min\(340px, calc\(100vw - 16px\)\)/);
  assert.match(css, /pointer-events:\s*none/);
  assert.match(css, /-webkit-line-clamp:\s*2/);
  assert.match(css, /text-overflow:\s*ellipsis/);
  assert.match(css, /var\(--color-background-elevated\)/);
  assert.match(css, /prefers-reduced-motion/);
  const main = fs.readFileSync(path.join(__dirname, "../src/main.tsx"), "utf8");
  assert.equal((main.match(/installLinkPreview\(/g) ?? []).length, 1);
  assert.match(main, /links\.preview\(\{ url \}\)/);
  assert.match(main, /import "\.\/features\/link-preview\.css"/);
  // Untrusted page text goes in as text, the page is read by the main process, and nothing polls.
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|fetch\(|setInterval|querySelectorAll|requestAnimationFrame/);
});
