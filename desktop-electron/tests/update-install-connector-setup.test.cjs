"use strict";

// Update goes ahead of the background connector setup (main.cjs launcher:update-install and
// prepareBrowserForUpdate). On 0.8.104 (2026-11-10) 35 Update clicks in two minutes were each refused
// at once with "Wait for MCP connector creation to finish before quitting Coding Tools" while the
// automatic account MCP setup worked through the accounts, holding the browser 15-45 s each.
// Since 2026-11-17 the click also stops that setup instead of waiting for it, and the button reads
// "Updating" from the click on: a setup whose connector creation was timing out held the browser
// for minutes, so each click waited a minute with nothing on screen and was then refused.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");

function slice(startText, close) {
  const start = source.indexOf(startText);
  assert.ok(start > 0, `${startText} is in main.cjs`);
  close.lastIndex = start;
  const match = close.exec(source);
  assert.ok(match, `${startText} ends`);
  return source.slice(start, match.index + match[0].length);
}

// The handler is one line since 2026-11-13; the install it runs is installAppUpdate (also App plugins').
const HANDLER = slice('  handle("launcher:update-install",', /\);\r?\n/g);
const INSTALL = slice("function installAppUpdate()", /\r?\n\}\r?\n/g);
const SHOWN = slice("function shownUpdateState()", /\r?\n\}\r?\n/g);
const PREPARE = slice("async function prepareBrowserForUpdate()", /\r?\n\}\r?\n/g);

function harness({ install = async ({ beforeAppInstall }) => { await beforeAppInstall(); return true; }, stop = async () => true,
  state = { status: "available", kind: "app", version: "9.9.9" } } = {}) {
  const order = [];
  const shown = [];
  let handler;
  const context = {
    MANUAL_MCP_CONNECT_WAIT_MS: 60_000,
    updateInstallInFlight: null,
    updatePreparing: false,
    Promise,
    browserHost: { manualOperation: "MCP connector creation", stopOperationFor: (action) => { order.push(`stop for ${action}`); return stop(); } },
    automaticAccountMcp: { hold: () => { order.push("hold"); return () => order.push("release"); } },
    waitForManualOperation: async (host, timeoutMs) => { order.push(`wait ${timeoutMs}`); assert.equal(host, context.browserHost); },
    stopBrowserTurnsForUpdate: async () => order.push("turns"),
    send: (channel, value) => { assert.equal(channel, "launcher:update-state"); shown.push(JSON.parse(JSON.stringify(value))); },
    updateController: { getState: () => context.state, beginInstall: async (options) => { order.push("install"); return install(options, order, context); } },
    state,
    handle: (channel, fn) => { assert.equal(channel, "launcher:update-install"); handler = fn; },
  };
  vm.runInNewContext(`${PREPARE}\n${SHOWN}\n${INSTALL}\n${HANDLER}`, context);
  return { order, shown, context, click: () => handler({}) };
}

test("an Update click holds the background setup, stops the one running, then installs and lets go", async () => {
  const { order, click } = harness();
  assert.equal(await click(), true);
  assert.deepEqual(order, ["hold", "install", "stop for the app update", "wait 60000", "turns", "release"]);
});

test("the button reads Updating from the click on, and what the install says once it has ended", async () => {
  let finish;
  const { shown, context, click } = harness({ install: () => new Promise((resolve) => { finish = resolve; }) });
  const clicked = click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(shown, [{ status: "downloading", kind: "app", version: "9.9.9", progress: 0 }],
    "shown at once, before the browser is free and anything downloads");
  // The install's own progress replaces it as soon as there is some.
  context.state = { status: "downloading", kind: "app", version: "9.9.9", progress: 0.4 };
  assert.equal(vm.runInContext("shownUpdateState()", vm.createContext(context)).progress, 0.4);
  context.state = { status: "installing", kind: "app", version: "9.9.9" };
  finish(true);
  assert.equal(await clicked, true);
  assert.deepEqual(shown.at(-1), { status: "installing", kind: "app", version: "9.9.9" });
});

test("a refused install puts the button back, releases the setup, and the next click tries again", async () => {
  let attempts = 0;
  const { order, shown, click } = harness({
    install: async ({ beforeAppInstall }) => {
      attempts += 1;
      await beforeAppInstall();
      if (attempts === 1) throw new Error("Wait for ChatGPT login to finish before quitting Coding Tools");
      return true;
    },
  });
  await assert.rejects(click(), /ChatGPT login/);
  assert.deepEqual(order, ["hold", "install", "stop for the app update", "wait 60000", "turns", "release"]);
  assert.deepEqual(shown.map((state) => state.status), ["downloading", "available"], "Updating, then Update to v… again");
  order.length = 0;
  assert.equal(await click(), true);
  assert.deepEqual(order, ["hold", "install", "stop for the app update", "wait 60000", "turns", "release"]);
});

test("a setup that does not stop in time is still waited for, and the install decides", async () => {
  const { order, click } = harness({ stop: async () => { throw new Error("MCP connector creation did not stop in time. Try again in a moment."); } });
  assert.equal(await click(), true);
  assert.deepEqual(order, ["hold", "install", "stop for the app update", "wait 60000", "turns", "release"]);
});

test("clicks while the install is prepared join it instead of asking again", async () => {
  let finish;
  const { order, context, click } = harness({ install: () => new Promise((resolve) => { finish = resolve; }) });
  const first = click();
  const again = [click(), click(), click()];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["hold", "install"], "one hold and one install for four clicks");
  finish(true);
  assert.deepEqual(await Promise.all([first, ...again]), [true, true, true, true]);
  assert.deepEqual(order, ["hold", "install", "release"]);
  assert.equal(context.updateInstallInFlight, null, "the next click starts a new attempt");
  assert.equal(context.updatePreparing, false);
});

test("a renderer-only update still holds and releases but stops and waits for nothing", async () => {
  const { order, click } = harness({ install: async () => "reloaded" });
  assert.equal(await click(), "reloaded");
  assert.deepEqual(order, ["hold", "install", "release"]);
});
