"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  BROWSER_HIDE_CHANNEL,
  BROWSER_SHOW_CHANNEL,
  BROWSER_SURFACE_ACTIVE_CHANNEL,
  createBrowserSurfaceActiveInvoker,
} = require("../electron/browser-surface-ipc.cjs");

test("browser surface uses the dedicated IPC handler when main and renderer versions match", async () => {
  const calls = [];
  const invoke = createBrowserSurfaceActiveInvoker({
    invoke: async (...args) => {
      calls.push(args);
      return { surfaceActive: args[1] };
    },
  });

  assert.deepEqual(await invoke(false), { surfaceActive: false });
  assert.deepEqual(await invoke(true), { surfaceActive: true });
  assert.deepEqual(calls, [
    [BROWSER_SURFACE_ACTIVE_CHANNEL, false],
    [BROWSER_SURFACE_ACTIVE_CHANNEL, true],
  ]);
});

test("stale main process falls back to hide and restore instead of leaving ChatGPT over other tabs", async () => {
  const calls = [];
  const invoke = createBrowserSurfaceActiveInvoker({
    invoke: async (channel, value) => {
      calls.push([channel, value]);
      if (channel === BROWSER_SURFACE_ACTIVE_CHANNEL) {
        throw new Error(
          `Error invoking remote method '${channel}': Error: No handler registered for '${channel}'`,
        );
      }
      return { channel };
    },
  });

  assert.deepEqual(await invoke(false), { channel: BROWSER_HIDE_CHANNEL });
  assert.deepEqual(await invoke(true), { channel: BROWSER_SHOW_CHANNEL });
  assert.deepEqual(calls, [
    [BROWSER_SURFACE_ACTIVE_CHANNEL, false],
    [BROWSER_HIDE_CHANNEL, undefined],
    [BROWSER_SURFACE_ACTIVE_CHANNEL, true],
    [BROWSER_SHOW_CHANNEL, undefined],
  ]);
});

test("surface compatibility is narrowly scoped and remains wired through preload plus main", async () => {
  const invoke = createBrowserSurfaceActiveInvoker({
    invoke: async () => {
      throw new Error("Browser host failed for an unrelated reason");
    },
  });
  await assert.rejects(invoke(false), /unrelated reason/);

  const electronRoot = path.resolve(__dirname, "../electron");
  const preload = fs.readFileSync(path.join(electronRoot, "preload.cjs"), "utf8");
  const main = fs.readFileSync(path.join(electronRoot, "main.cjs"), "utf8");
  assert.match(preload, /createBrowserSurfaceActiveInvoker/);
  assert.match(main, /handle\("launcher:browser-surface-active"/);
});
