"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { FOCUS_SETTLE_MS, waitForFocus } = require("../electron/focus-settle.cjs");

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer) timer.cleared = true; },
    fire: () => { for (const timer of timers) if (!timer.cleared) { timer.cleared = true; timer.callback(); } },
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
  assert.equal(clock.timers[0].ms, FOCUS_SETTLE_MS);
  assert.ok(FOCUS_SETTLE_MS <= 2_000, "a refused send is not held long");
  clock.fire();
  assert.equal(await waiting, false);
  assert.equal(window.listenerCount("focus"), 0);
  window.emit("focus"); // a late event changes nothing
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
