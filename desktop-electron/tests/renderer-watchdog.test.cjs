"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createRendererWatchdog, GRACE_MS, UNRESPONSIVE_MS, LOAD_MS } = require("../electron/renderer-watchdog.cjs");

/** A fake window whose page reports `rootChildren` for #root, with manual timers. */
function world({ rootChildren = 3 } = {}) {
  const contents = new EventEmitter();
  const window = new EventEmitter();
  const state = { rootChildren, crashed: 0, recovered: [], logs: [] };
  contents.isDestroyed = () => false;
  contents.isLoading = () => false;
  contents.getURL = () => "file:///app/dist/index.html";
  contents.executeJavaScript = async () => state.rootChildren;
  contents.forcefullyCrashRenderer = () => { state.crashed += 1; };
  window.webContents = contents;
  window.isDestroyed = () => false;
  const timers = new Map(); let next = 0;
  const repeats = new Map();
  const watchdog = createRendererWatchdog({
    window, recover: (reason) => state.recovered.push(reason),
    logger: { warn: (event, detail) => state.logs.push([event, detail]), info() {} },
    setTimer: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; }, clearTimer: (id) => timers.delete(id),
    setRepeat: (fn, ms) => { const id = ++next; repeats.set(id, { fn, ms }); return id; }, clearRepeat: (id) => repeats.delete(id),
    now: () => 0,
  });
  const fire = async (ms) => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } await new Promise(setImmediate); };
  const tick = async () => { for (const repeat of [...repeats.values()]) repeat.fn(); await new Promise(setImmediate); await new Promise(setImmediate); };
  return { window, contents, state, watchdog, fire, tick, repeats };
}

test("a page whose React tree unmounted (empty #root) twice in a row is reloaded; a drawn page never is", async () => {
  const { contents, state, fire, tick, repeats } = world({ rootChildren: 3 });
  contents.emit("did-finish-load");
  assert.equal(repeats.size, 0, "no checks during the grace after a load");
  await fire(GRACE_MS);
  await tick(); await tick();
  assert.deepEqual(state.recovered, [], "a drawn page is left alone");
  state.rootChildren = 0;
  await tick();
  assert.deepEqual(state.recovered, [], "one empty check could be a re-render in progress");
  await tick();
  assert.deepEqual(state.recovered, ["blank"]);
  assert.equal(state.logs.at(-1)[0], "launcher.renderer_blank");
  assert.equal(repeats.size, 0, "checks stop until the reloaded page has loaded");
});

test("a page that is not the app's (no #root) is never treated as blank", async () => {
  const { contents, state, fire, tick } = world({ rootChildren: -1 });
  contents.emit("did-finish-load");
  await fire(GRACE_MS);
  await tick(); await tick(); await tick();
  assert.deepEqual(state.recovered, []);
});

test("a renderer hung past the limit is crashed on purpose (the crash path reloads it); one that recovers is left alone", async () => {
  const { window, state, fire } = world();
  window.emit("unresponsive");
  window.emit("responsive");
  await fire(UNRESPONSIVE_MS);
  assert.equal(state.crashed, 0, "it answered again in time");
  window.emit("unresponsive");
  await fire(UNRESPONSIVE_MS);
  assert.equal(state.crashed, 1);
  assert.ok(state.logs.some(([event]) => event === "launcher.renderer_hung"));
});

test("a load that never finishes is reloaded, then the app restarts; a load that ends in time is left alone", async () => {
  // Seen after a Windows restart: every page sat on about:blank for 20+ minutes and the window,
  // waiting for ready-to-show, never appeared.
  const { contents, state, fire } = world();
  let loading = true;
  contents.isLoading = () => loading;
  contents.emit("did-start-loading");
  contents.emit("did-stop-loading");
  loading = false;
  await fire(LOAD_MS);
  assert.deepEqual(state.recovered, [], "it finished in time");
  loading = true;
  contents.emit("did-start-loading");
  await fire(LOAD_MS);
  assert.deepEqual(state.recovered, ["stalled"], "first a reload");
  assert.equal(state.logs.at(-1)[0], "launcher.renderer_load_stalled");
  contents.emit("did-start-loading");
  await fire(LOAD_MS);
  assert.deepEqual(state.recovered, ["stalled", "stalled-again"], "stuck again: the whole app restarts");
  // A page that loads resets the count.
  contents.emit("did-finish-load");
  contents.emit("did-start-loading");
  await fire(LOAD_MS);
  assert.equal(state.recovered.at(-1), "stalled");
});

test("console errors from the page are logged, a few a minute, so a blank window says why", () => {
  const { contents, state } = world();
  contents.emit("console-message", { level: "error", message: "TypeError: x is undefined", lineNumber: 12, sourceId: "file:///app/dist/assets/index.js" });
  contents.emit("console-message", { level: "info", message: "fine" });
  for (let index = 0; index < 30; index += 1) contents.emit("console-message", { level: "error", message: `again ${index}` });
  const errors = state.logs.filter(([event]) => event === "launcher.renderer_console_error");
  assert.equal(errors.length, 20, "rate limited");
  assert.deepEqual(errors[0][1], { message: "TypeError: x is undefined", source: "index.js:12" });
});
