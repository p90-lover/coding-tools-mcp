"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BACKOFF_CAP_MS,
  CPA_LOGS_MAX_TOTAL_SIZE_MB,
  HEALTH_POLL_MS,
  WEEK_MS,
  attachCpaCodexLongRun,
  classifyObservation,
  cpaLongRunYamlLines,
  nextBackoffMs,
  shouldAbandonLongRun,
  trimJournal,
} = require("../electron/cpa-codex-long-run.cjs");
const { runtimeConfiguration } = require("../electron/cpa-managed.cjs");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeClock() {
  let current = 1_000;
  const timers = [];
  return {
    now: () => current,
    setTimeoutFn(fn, ms) {
      const timer = { fn, due: current + Number(ms || 0), cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      if (timer) timer.cleared = true;
    },
    async flush(ms = 0) {
      current += ms;
      const due = timers.filter((timer) => !timer.cleared && timer.due <= current);
      for (const timer of due) {
        timer.cleared = true;
        await timer.fn();
      }
    },
  };
}

test("week-long backoff caps at five minutes and never abandons a desired run", () => {
  const delays = [];
  for (let attempt = 0; attempt < 24; attempt += 1) {
    delays.push(nextBackoffMs(attempt, { random: () => 0 }));
  }
  assert.equal(delays[0], 1_000);
  assert.equal(delays[1], 2_000);
  assert.equal(delays.at(-1), BACKOFF_CAP_MS);
  assert.ok(delays.every((delay) => delay <= BACKOFF_CAP_MS));
  assert.equal(shouldAbandonLongRun({ elapsedMs: WEEK_MS, consecutiveCrashes: 10_000 }), false);
  assert.equal(HEALTH_POLL_MS, 45_000);
});

test("a live PID health flap is a reconnectable blip, not a crash restart", () => {
  assert.equal(classifyObservation({ desiredRunning: true, pid: 8317, status: "starting" }), "blip");
  assert.equal(classifyObservation({ desiredRunning: true, pid: 8317, status: "error" }), "blip");
  assert.equal(classifyObservation({ desiredRunning: true, pid: null, status: "offline" }), "crash");
  assert.equal(classifyObservation({ desiredRunning: true, pid: 91, status: "ready" }), "healthy");
  assert.equal(classifyObservation({ desiredRunning: false, pid: null, status: "offline" }), "idle");
});

test("journal rotation stays bounded so a seven-day run cannot fill disk", () => {
  const events = Array.from({ length: 400 }, (_, index) => ({ index, pad: "x".repeat(200) }));
  const trimmed = trimJournal(events, { maxEvents: 80, maxBytes: 8_192 });
  assert.ok(trimmed.length <= 80);
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed), "utf8") <= 8_192);
  assert.equal(trimmed.at(-1).index, 399);
});

test("CPA managed config keeps the original panel and turns on long-run keep-alive plus log caps", () => {
  const directory = temporaryDirectory("coding-tools-cpa-long-run-");
  const yaml = runtimeConfiguration(directory, "m".repeat(36), "p".repeat(36));
  assert.match(yaml, /disable-control-panel: false/);
  assert.match(yaml, /disable-auto-update-panel: true/);
  assert.match(yaml, /allow-remote: false/);
  assert.match(yaml, /host: "127\.0\.0\.1"/);
  assert.match(yaml, /streaming:\n {2}keepalive-seconds: 15/);
  assert.match(yaml, /nonstream-keepalive-interval: 30/);
  assert.match(yaml, /request-retry: 5/);
  assert.match(yaml, new RegExp(`logs-max-total-size-mb: ${CPA_LOGS_MAX_TOTAL_SIZE_MB}`));
  assert.match(yaml, /request-log: false/);
  assert.equal(cpaLongRunYamlLines().includes("debug: false"), false);
});

test("supervisor reconnects after a crash, keeps desired run across durable state, and stops when asked", async () => {
  const clock = fakeClock();
  const statePath = path.join(temporaryDirectory("coding-tools-long-run-state-"), "state.json");
  const calls = [];
  let status = "offline";
  let pid = null;
  const inner = {
    snapshot: () => ({ version: 1, tools: [{ id: "cpa", status, pid, originalChrome: true }] }),
    inspect: async (id) => ({ id, status, pid, originalChrome: true }),
    start: async (id) => {
      calls.push(["start", id]);
      status = "ready";
      pid = 8317;
      return { id, status, pid, originalChrome: true };
    },
    stop: async (id) => {
      calls.push(["stop", id]);
      status = "offline";
      pid = null;
      return { id, status, pid, originalChrome: true };
    },
    restart: async () => {
      throw new Error("unused");
    },
    openEmbedded: async (id) => ({
      tool: { id, status, pid, originalChrome: true },
      section: "dashboard",
      url: "http://127.0.0.1:8317/management.html#/dashboard",
      embedded: true,
      originalWindow: false,
    }),
    openExternalTool: async (id) => inner.openEmbedded(id),
    copyCpaManagementKey: () => ({ copied: true, length: 36 }),
    dispose() {},
  };

  const first = attachCpaCodexLongRun(inner, {
    statePath,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    resumeOnCreate: false,
    random: () => 0,
  });
  await first.start("cpa");
  assert.equal(first.snapshot().tools[0].longRun.desiredRunning, true);
  status = "offline";
  pid = null;
  await clock.flush(0);
  await clock.flush(1_000);
  assert.equal(calls.filter((entry) => entry[0] === "start").length, 2);
  first.dispose();

  status = "offline";
  pid = null;
  const resumed = attachCpaCodexLongRun(inner, {
    statePath,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    resumeOnCreate: true,
    random: () => 0,
  });
  await clock.flush(0);
  await clock.flush(BACKOFF_CAP_MS);
  assert.ok(calls.filter((entry) => entry[0] === "start").length >= 3);
  await resumed.stop("cpa");
  const afterStop = calls.filter((entry) => entry[0] === "start").length;
  await clock.flush(HEALTH_POLL_MS);
  assert.equal(calls.filter((entry) => entry[0] === "start").length, afterStop);
  resumed.dispose();
});

test("health blips with a live PID do not kill the process, then a reconnect generation is published", async () => {
  const clock = fakeClock();
  let status = "ready";
  const inner = {
    snapshot: () => ({ version: 1, tools: [{ id: "cpa", status, pid: 9, originalChrome: true }] }),
    inspect: async () => ({ id: "cpa", status, pid: 9, originalChrome: true }),
    start: async () => ({ id: "cpa", status: "ready", pid: 9, originalChrome: true }),
    stop: async () => ({ id: "cpa", status: "offline", pid: null, originalChrome: true }),
    restart: async () => ({ id: "cpa", status: "ready", pid: 9, originalChrome: true }),
    openEmbedded: async () => ({ tool: { id: "cpa", status, pid: 9 }, section: "dashboard", url: "", embedded: true }),
    openExternalTool: async () => ({ tool: { id: "cpa", status, pid: 9 }, section: "dashboard", url: "", embedded: false }),
    copyCpaManagementKey: () => ({ copied: true, length: 36 }),
    dispose() {},
  };
  const starts = [];
  inner.start = async () => {
    starts.push("start");
    status = "ready";
    return { id: "cpa", status, pid: 9, originalChrome: true };
  };
  const controller = attachCpaCodexLongRun(inner, {
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    resumeOnCreate: false,
  });
  await controller.start("cpa");
  status = "starting";
  await clock.flush(0);
  assert.equal(starts.length, 1);
  assert.equal(controller.snapshot().tools[0].longRun.reconnectGeneration, 0);
  status = "ready";
  await clock.flush(HEALTH_POLL_MS);
  assert.equal(starts.length, 1);
  assert.equal(controller.snapshot().tools[0].longRun.reconnectGeneration, 1);
  controller.dispose();
});
