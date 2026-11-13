"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { FOCUS_LATE_MS, FOCUS_SETTLE_MS, FOCUS_SLICE_MS, FOCUS_WAIT_MAX_MS, waitForFocus } = require("../electron/focus-settle.cjs");

function fakeTimers() {
  const timers = [];
  let at = 0;
  return {
    timers,
    now: () => at,
    setTimer: (callback, ms) => { const timer = { callback, ms, due: at + ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.cleared = true; },
    /** Runs the pending slice `late` ms after it was due (main held for that long); false when none is left. */
    fire: (late = 0) => {
      const timer = timers.find((item) => !item.cleared);
      if (!timer) return false;
      timer.cleared = true;
      at = timer.due + late;
      timer.callback();
      return true;
    },
  };
}

test("a focused window passes at once, without waiting", async () => {
  const window = new EventEmitter();
  const clock = fakeTimers();
  assert.equal(await waitForFocus({ focused: () => true, emitters: [window], ...clock }), true);
  assert.equal(clock.timers.length, 0);
  assert.equal(window.listenerCount("focus"), 0);
});

test("a send that reached main before the window's focus event passes once that event lands", async () => {
  const window = new EventEmitter(), page = new EventEmitter();
  const state = { window: false, page: false };
  const clock = fakeTimers();
  const waiting = waitForFocus({ focused: () => state.window && state.page, emitters: [window, page], ...clock });
  // The window's focus lands first: the page is still not focused, so it keeps waiting.
  state.window = true; window.emit("focus");
  let settled = false;
  void waiting.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  state.page = true; page.emit("focus");
  assert.equal(await waiting, true);
  assert.equal(clock.timers[0].cleared, true, "the timer is cleared");
  assert.equal(window.listenerCount("focus") + page.listenerCount("focus"), 0, "no listener is left behind");
});

test("with no focus event in time, the check answers as it is then", async () => {
  const window = new EventEmitter();
  const clock = fakeTimers();
  const waiting = waitForFocus({ focused: () => false, emitters: [window], ...clock });
  assert.ok(FOCUS_SETTLE_MS <= 2_000, "a refused send is not held long");
  let slices = 0;
  while (clock.fire()) slices += 1;
  assert.equal(slices, FOCUS_SETTLE_MS / FOCUS_SLICE_MS, "main free for the whole wait: it ends after FOCUS_SETTLE_MS");
  assert.equal(await waiting, false);
  assert.equal(window.listenerCount("focus"), 0);
  window.emit("focus"); // a late event changes nothing
});

// 2026-11-11 07:19:36Z, right after the 0.8.110 relaunch: main was held past the whole 2 s, the
// overdue timer ran before the focus event queued behind the stall, and the send was refused.
test("a main stall during the wait does not use it up: the focus event behind the stall still lands", async () => {
  const window = new EventEmitter();
  const state = { focused: false };
  const clock = fakeTimers();
  const waiting = waitForFocus({ focused: () => state.focused, emitters: [window], ...clock });
  let settled = false;
  void waiting.then(() => { settled = true; });
  clock.fire(5_000); // main held 5 s: this slice is late and does not count
  clock.fire(FOCUS_LATE_MS + 1);
  await Promise.resolve();
  assert.equal(settled, false, "still waiting after a 5 s stall");
  state.focused = true; window.emit("focus"); // dispatched once main is free
  assert.equal(await waiting, true);
  assert.equal(window.listenerCount("focus"), 0);
});

test("a main that stays held still gets an answer within FOCUS_WAIT_MAX_MS", async () => {
  const window = new EventEmitter();
  const clock = fakeTimers();
  const waiting = waitForFocus({ focused: () => false, emitters: [window], ...clock });
  while (clock.fire(1_000)) { /* every slice a second late */ }
  assert.equal(await waiting, false);
  assert.ok(clock.now() >= FOCUS_WAIT_MAX_MS && clock.now() < FOCUS_WAIT_MAX_MS + 1_200, `answered at ${clock.now()} ms`);
  assert.equal(window.listenerCount("focus"), 0);
});

test("a slice late by no more than FOCUS_LATE_MS still counts", async () => {
  const clock = fakeTimers();
  const waiting = waitForFocus({ focused: () => false, emitters: [new EventEmitter()], ...clock });
  let slices = 0;
  while (clock.fire(FOCUS_LATE_MS)) slices += 1;
  assert.equal(slices, FOCUS_SETTLE_MS / FOCUS_SLICE_MS);
  assert.equal(await waiting, false);
});

test("chat sends and other app writes use the settled focus check; hidden and minimized windows are still refused at once", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  const appsCall = main.slice(main.indexOf('handle("coding-tools:apps:call"'), main.indexOf('handle("launcher:browser-bounds"'));
  assert.match(appsCall, /await assertFocusedMainWindowSettled\(event, !passiveAoLayout && !readOnly, backgroundRead\)/);
  assert.doesNotMatch(appsCall, /[^d]assertFocusedMainWindow\(event/, "the unsettled check is not used here");
  const settled = main.slice(main.indexOf("async function assertFocusedMainWindowSettled"), main.indexOf("function launcherSnapshotPayload"));
  assert.match(settled, /write && !valid\(\) && window && window === mainWindow && !window\.isDestroyed\(\) && window\.isVisible\(\) && !window\.isMinimized\(\)/);
  assert.match(settled, /\r?\n  assertFocusedMainWindow\(event, write, backgroundRead\);\r?\n\}/, "the same check decides in the end");
});

test("every window click handler waits for a late focus event too, not only chat sends", () => {
  // 2026-11-12 07:57:49Z: an App plugins Update click was refused ("Click into the Coding Tools window")
  // because its handler used the unsettled check while main caught up after a stall.
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  const plain = [...main.matchAll(/assertFocusedMainWindow\(event, true\)/g)].map((match) => {
    const before = main.slice(0, match.index);
    return before.slice(before.lastIndexOf('handle("') + 8).split('"')[0];
  });
  // The reconnect asks again after its long checks (still the person's click when it acts): that one stays plain.
  assert.deepEqual(plain, ["launcher:mcp-tunnel-reconnect"]);
  const settled = main.match(/await assertFocusedMainWindowSettled\(event, true\)/g) ?? [];
  // 73 until #1276 removed the GPT Browser page and its five write handlers (add, switch, open URL,
  // navigate, remove), each with this check: 68. The plain-check list above is what catches a regression.
  assert.ok(settled.length >= 68, `the write handlers use the settled check (${settled.length})`);
});

// 2026-11-12 08:19:05Z: an Approve on an agent's request passed the settled IPC check, then was
// refused by the confirmation's own focus check after the agent call spanned a 46.5 s stall.
test("an answer to an agent's request waits for a late focus event; a minimized window is refused at once", async () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  const source = main.slice(main.indexOf("const mainWindowFocusSettled = "), main.indexOf("const confirmRecoverable = "));
  assert.doesNotMatch(source, /!mainWindow\.isFocused\(\)\) \{/, "no confirmation keeps the plain focus check");
  const window = Object.assign(new EventEmitter(), {
    focused: false, minimized: false,
    isDestroyed: () => false, isVisible: () => true,
    isMinimized() { return this.minimized; }, isFocused() { return this.focused; },
  });
  const shown = [];
  const dialog = { showMessageBox: async (_parent, options) => { shown.push(options.message); return { response: 1, checkboxChecked: false }; } };
  const { confirmAoAction, confirmToolRequest } = new Function("mainWindow", "waitForFocus", "dialog", "stateStore", "logger",
    `${source}\nreturn { confirmAoAction, confirmToolRequest };`,
  )(window, waitForFocus, dialog, { read: () => ({}), update() {} }, { info() {} });

  const answered = confirmToolRequest({ message: "Run a command?", detail: "" });
  setTimeout(() => { window.focused = true; window.emit("focus"); }, 50);
  assert.equal(await answered, true);
  assert.deepEqual(shown, ["Run a command?"]);

  window.focused = false;
  window.minimized = true;
  const started = Date.now();
  await assert.rejects(confirmAoAction({ message: "Change the workflow?", detail: "" }), /focused Coding Tools window to approve workflow changes/);
  assert.ok(Date.now() - started < FOCUS_SLICE_MS, "a minimized window is not waited for");
  assert.deepEqual(shown, ["Run a command?"], "no dialog without focus");
  assert.equal(window.listenerCount("focus"), 0);
});
