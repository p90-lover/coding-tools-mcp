"use strict";

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
const PREPARE = slice("async function prepareBrowserForUpdate()", /\r?\n\}\r?\n/g);

function harness({ install = async ({ beforeAppInstall }) => { await beforeAppInstall(); return true; } } = {}) {
  const order = [];
  let handler;
  const context = {
    MANUAL_MCP_CONNECT_WAIT_MS: 60_000,
    updateInstallInFlight: null,
    browserHost: { manualOperation: "MCP connector creation" },
    waitForManualOperation: async (host, timeoutMs) => { order.push(`wait ${timeoutMs}`); assert.equal(host, context.browserHost); },
    stopBrowserTurnsForUpdate: async () => order.push("turns"),
    updateController: { beginInstall: async (options) => { order.push("install"); return install(options, order); } },
    handle: (channel, fn) => { assert.equal(channel, "launcher:update-install"); handler = fn; },
  };
  vm.runInNewContext(`${PREPARE}\n${INSTALL}\n${HANDLER}`, context);
  return { order, context, click: () => handler({}) };
}

test("an Update click waits for a manual browser operation before installing", async () => {
  const { order, click } = harness();
  assert.equal(await click(), true);
  assert.deepEqual(order, ["install", "wait 60000", "turns"]);
});

test("clicks while the install is prepared join it instead of asking again", async () => {
  let finish;
  const { order, context, click } = harness({ install: () => new Promise((resolve) => { finish = resolve; }) });
  const first = click();
  const again = [click(), click(), click()];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["install"], "one install for four clicks");
  finish(true);
  assert.deepEqual(await Promise.all([first, ...again]), [true, true, true, true]);
  assert.deepEqual(order, ["install"]);
  assert.equal(context.updateInstallInFlight, null, "the next click starts a new attempt");
});

test("a refused install allows the next click to try again", async () => {
  let attempts = 0;
  const { order, click } = harness({
    install: async ({ beforeAppInstall }) => {
      attempts += 1;
      await beforeAppInstall();
      if (attempts === 1) throw new Error("Wait for MCP connector creation to finish before quitting Coding Tools");
      return true;
    },
  });
  await assert.rejects(click(), /MCP connector creation/);
  assert.deepEqual(order, ["install", "wait 60000", "turns"]);
  order.length = 0;
  assert.equal(await click(), true);
  assert.deepEqual(order, ["install", "wait 60000", "turns"]);
});

test("a renderer-only update waits for no browser operation", async () => {
  const { order, click } = harness({ install: async () => "reloaded" });
  assert.equal(await click(), "reloaded");
  assert.deepEqual(order, ["install"]);
});
