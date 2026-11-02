const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const app = fs.readFileSync(path.resolve(__dirname, "../src/App.tsx"), "utf8").replace(/\r\n/g, "\n");

function loadFormatTime() {
  const start = app.indexOf("const timeFormats = ");
  const end = app.indexOf("\n}\n", app.indexOf("function formatTime(")) + 3;
  assert.ok(start > 0 && end > start, "formatTime and its cache are in App.tsx");
  const context = { Intl, Date, Map };
  vm.runInNewContext(ts.transpileModule(`${app.slice(start, end)}\nglobalThis.formatTime = formatTime;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.formatTime;
}

test("activity times read as before, from one cached formatter per language", () => {
  const formatTime = loadFormatTime();
  const at = "2026-10-26T09:41:07.000Z";
  for (const [language, locale] of [["en", "en"], ["ja", "ja-JP"], ["zh-TW", "zh-TW"], ["zh-CN", "zh-CN"]]) {
    assert.equal(formatTime(at, language), new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  }
  assert.equal(formatTime("not a time", "en"), "not a time");
  const original = Intl.DateTimeFormat;
  let built = 0;
  Intl.DateTimeFormat = function (...args) { built += 1; return new original(...args); };
  try {
    const fresh = loadFormatTime();
    for (let i = 0; i < 50; i += 1) fresh(at, "en");
    assert.equal(built, 1, "300 rows must not build 300 formatters");
  } finally { Intl.DateTimeFormat = original; }
});

test("each activity row renders once per record, not once per new log line", () => {
  assert.match(app, /const ActivityRow = memo\(function ActivityRow\(\{ record, language \}/);
  assert.match(app, /\.map\(\(record\) => <ActivityRow key=\{logKey\(record\)\} record=\{record\} language=\{language\} \/>\)/);
});

function loadLogStore() {
  const visibilityListeners = new Set();
  let away = false, notifications = 0, snapshot, cleanup, subscribed, memoized, dependencies;
  const document = {
    visibilityState: "visible",
    documentElement: { hasAttribute: (name) => name === "data-window-away" && away },
    addEventListener: (name, listener) => { assert.equal(name, "visibilitychange"); visibilityListeners.add(listener); },
    removeEventListener: (name, listener) => { assert.equal(name, "visibilitychange"); visibilityListeners.delete(listener); },
  };
  const react = {
    createContext: (value) => ({ value }),
    useContext: (context) => context.value,
    useCallback: (callback, next) => {
      if (!dependencies || next.some((value, index) => value !== dependencies[index])) {
        memoized = callback; dependencies = next;
      }
      return memoized;
    },
    useSyncExternalStore: (subscribe, read) => {
      if (subscribed !== subscribe) {
        cleanup?.(); subscribed = subscribe;
        cleanup = subscribe(() => { notifications++; snapshot = read(); });
      }
      snapshot = read();
      return snapshot;
    },
  };
  function load(relative, imports) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, relative), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports, document, require: (name) => {
      assert.ok(Object.hasOwn(imports, name), name);
      return imports[name];
    } });
    return exports;
  }
  const visibility = load("../src/features/page-visibility.ts", { react });
  const store = load("../src/log-store.ts", { react, "./features/page-visibility": visibility });
  return {
    store, notifications: () => notifications, snapshot: () => snapshot,
    listeners: () => visibilityListeners.size,
    render: (hidden = false) => { visibility.SurfaceHiddenContext.value = hidden; return store.useLogs(); },
    show: (state, windowAway = false) => {
      document.visibilityState = state; away = windowAway;
      for (const listener of visibilityListeners) listener();
    },
    stop: () => { cleanup?.(); },
  };
}

test("Activity stops log callbacks behind another surface and catches up on return", () => {
  const view = loadLogStore();
  view.render(); view.store.appendLog({ event: "visible" });
  assert.equal(view.notifications(), 1, "the visible subscriber is actually connected");
  view.render(true);
  for (let index = 0; index < 20; index++) view.store.appendLog({ event: `hidden-${index}` });
  assert.equal(view.notifications(), 1, "20 hidden appends must deliver zero callbacks");
  assert.equal(view.listeners(), 0, "another surface needs no visibility listener");
  const current = view.render();
  assert.equal(current.length, 21);
  assert.equal(current.at(-1).event, "hidden-19", "return reads the retained newest history immediately");
  view.store.appendLog({ event: "visible-again" });
  assert.equal(view.notifications(), 2);
  view.stop();
  view.store.appendLog({ event: "after-cleanup" });
  assert.equal(view.notifications(), 2);
  assert.equal(view.listeners(), 0);
});

for (const hiddenBy of ["page", "minimized-window"]) {
  test(`Activity detaches for a ${hiddenBy} and catches up without another log`, () => {
    const view = loadLogStore();
    view.render(); view.store.appendLog({ event: "before-hide" });
    assert.equal(view.notifications(), 1);
    view.show(hiddenBy === "page" ? "hidden" : "visible", hiddenBy === "minimized-window");
    for (let index = 0; index < 20; index++) view.store.appendLog({ event: `away-${index}` });
    assert.equal(view.notifications(), 1, "20 away appends must deliver zero callbacks");
    assert.equal(view.snapshot().at(-1).event, "before-hide");
    view.show("visible");
    assert.equal(view.notifications(), 2, "being shown itself notifies once, without waiting for a new log");
    assert.equal(view.snapshot().at(-1).event, "away-19");
    view.store.appendLog({ event: "after-show" });
    assert.equal(view.notifications(), 3, "one record listener resumes, without duplicates");
    view.stop();
    assert.equal(view.listeners(), 0);
    view.show("hidden"); view.show("visible"); view.store.appendLog({ event: "after-cleanup" });
    assert.equal(view.notifications(), 3);
  });
}

test("hidden Activity still retains only the newest 300 records and stable row keys", () => {
  const view = loadLogStore();
  view.render(true);
  const records = Array.from({ length: 310 }, (_, index) => ({ event: `record-${index}` }));
  view.store.replaceLogs(records);
  assert.equal(view.notifications(), 0);
  const current = view.render();
  assert.equal(current.length, 300);
  assert.equal(current[0], records[10]);
  const key = view.store.logKey(records[20]);
  view.store.appendLog({ event: "newest" });
  assert.equal(view.snapshot().length, 300);
  assert.equal(view.snapshot()[0], records[11]);
  assert.equal(view.snapshot().at(-1).event, "newest");
  assert.equal(view.store.logKey(records[20]), key);
  view.stop();
});
