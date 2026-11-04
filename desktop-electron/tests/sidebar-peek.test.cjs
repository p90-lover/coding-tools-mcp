const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "../src/sidebar-peek.ts"), "utf8");
const api = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: api });

function target() {
  const handlers = new Map();
  return {
    handlers,
    addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
    removeEventListener(name, fn) { handlers.get(name)?.delete(fn); },
    emit(name, event = {}) { for (const fn of handlers.get(name) ?? []) fn(event); },
    count() { return [...handlers.values()].reduce((sum, values) => sum + values.size, 0); },
  };
}
function fixture() {
  let now = 0, next = 0, hit = null, reads = 0;
  const tasks = new Map(), changes = [];
  const win = Object.assign(target(), {
    setTimeout(fn, ms) { const id = ++next; tasks.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { tasks.delete(id); },
  });
  const doc = Object.assign(target(), { defaultView: win, documentElement: target(), hidden: false, elementFromPoint: () => hit });
  const child = { matches: () => false };
  const box = { left: 0, top: 36, right: 52, bottom: 800 };
  const panel = Object.assign(target(), { ownerDocument: doc, getBoundingClientRect: () => { reads++; return box; }, contains: node => node === panel || node === child });
  hit = child;
  const control = api.bindSidebarPeek(panel, open => { changes.push(open); box.right = open ? 252 : 52; });
  const advance = ms => {
    const end = now + ms;
    for (;;) {
      const entry = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      now = entry[1].at; tasks.delete(entry[0]); entry[1].fn();
    }
    now = end;
  };
  const pointer = (x = 20, y = 100, pointerType = "mouse") => ({ clientX: x, clientY: y, pointerType });
  const enter = () => { panel.emit("pointerenter", pointer()); advance(api.SIDEBAR_PEEK_DELAY_MS); };
  return { panel, win, doc, child, box, tasks, changes, advance, pointer, enter, control, reads: () => reads, hit: value => { hit = value; } };
}

test("proximity, title-bar coordinates and covered rail pixels cannot open the panel", () => {
  const f = fixture();
  f.win.emit("pointermove", f.pointer(20, 10));
  f.panel.emit("pointerenter", f.pointer(20, 10));
  f.panel.emit("pointerenter", f.pointer(53));
  f.hit({});
  f.panel.emit("pointerenter", f.pointer());
  f.advance(1000);
  assert.deepEqual(f.changes, []);
});

test("a closed sidebar does no layout reads on ordinary window pointer movement", () => {
  const f = fixture();
  for (let i = 0; i < 1000; i++) f.win.emit("pointermove", f.pointer(500, 200));
  assert.equal(f.reads(), 0);
  assert.equal(f.tasks.size, 0);
});

test("hovering the actual visible rail opens once after a short intent delay", () => {
  const f = fixture();
  f.panel.emit("pointerenter", f.pointer());
  f.advance(api.SIDEBAR_PEEK_DELAY_MS - 1);
  assert.deepEqual(f.changes, []);
  f.advance(1);
  assert.deepEqual(f.changes, [true]);
  f.win.emit("pointermove", f.pointer(200));
  f.advance(1000);
  assert.deepEqual(f.changes, [true]);
});

test("leaving closes even when a navigation click left mouse focus inside", () => {
  const f = fixture(); f.enter();
  f.panel.emit("focusin", { target: f.child });
  f.panel.emit("pointerleave");
  f.advance(api.SIDEBAR_LEAVE_DELAY_MS);
  assert.deepEqual(f.changes, [true, false]);
});

test("one pixel past the panel closes it without the old 16-pixel sticky zone", () => {
  const f = fixture(); f.enter();
  f.hit(null);
  f.win.emit("pointermove", f.pointer(253));
  f.advance(api.SIDEBAR_LEAVE_DELAY_MS);
  assert.deepEqual(f.changes, [true, false]);
});

test("leaving cancels a pending open and returning cancels a pending close", () => {
  const f = fixture();
  f.panel.emit("pointerenter", f.pointer());
  f.panel.emit("pointerleave");
  f.advance(1000);
  assert.deepEqual(f.changes, []);
  f.enter();
  f.panel.emit("pointerleave");
  f.advance(50);
  f.panel.emit("pointerenter", f.pointer(100));
  f.advance(1000);
  assert.deepEqual(f.changes, [true]);
});

for (const event of ["blur", "resize", "window-leave", "hidden", "Escape"]) {
  test(`${event} dismisses immediately and cancels pending callbacks`, () => {
    const f = fixture(); f.enter();
    if (event === "window-leave") f.doc.documentElement.emit("pointerleave");
    else if (event === "hidden") { f.doc.hidden = true; f.doc.emit("visibilitychange"); }
    else if (event === "Escape") f.win.emit("keydown", { key: "Escape" });
    else f.win.emit(event);
    f.advance(1000);
    assert.deepEqual(f.changes, [true, false]);
    assert.equal(f.tasks.size, 0);
  });
}

test("touch does not start hover; keyboard focus still reveals navigation and focus-out closes it", () => {
  const f = fixture();
  f.panel.emit("pointerenter", f.pointer(20, 100, "touch")); f.advance(1000);
  assert.deepEqual(f.changes, []);
  f.child.matches = () => true;
  f.panel.emit("focusin", { target: f.child }); f.advance(0);
  assert.deepEqual(f.changes, [true]);
  f.panel.emit("focusout", { relatedTarget: {} }); f.advance(api.SIDEBAR_LEAVE_DELAY_MS);
  assert.deepEqual(f.changes, [true, false]);
});

test("explicit close and disposal cancel pending opens and release every listener", () => {
  const f = fixture();
  f.panel.emit("pointerenter", f.pointer()); f.control.close(); f.advance(1000);
  assert.deepEqual(f.changes, []);
  f.panel.emit("pointerenter", f.pointer()); f.control.dispose(); f.advance(1000);
  assert.equal(f.panel.count() + f.win.count() + f.doc.count() + f.doc.documentElement.count(), 0);
  assert.equal(f.tasks.size, 0);
  assert.deepEqual(f.changes, []);
});

test("shell binds the visible clip only in rail mode and labels use reversible reduced-motion-aware transitions", () => {
  const app = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../src/styles.css"), "utf8");
  assert.match(app, /if \(!sidebarRail \|\| !sidebarPanel\.current\) return undefined/);
  assert.match(app, /className="sidebar-clip" ref=\{sidebarPanel\}/);
  assert.match(app, /if \(open\) setSidebarExpanded\(true\)/);
  assert.doesNotMatch(app, /event\.clientX > sidebarWidth \+ 16|sidebarPeekState/);
  assert.doesNotMatch(css, /sidebar-names-in/);
  assert.match(css, /transition: opacity 160ms ease-out, transform 220ms/);
  assert.match(css, /@starting-style \{ opacity: 0/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?is-expanded \*[\s\S]*?transition: none/);
});
