"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BACKOFF_CAP_MS,
  CPA_LOGS_MAX_TOTAL_SIZE_MB,
  EXECUTION_TIMEOUT_MS,
  HEALTH_POLL_MS,
  LITELLM_REQUEST_TIMEOUT_SECONDS,
  WEEK_MS,
  applyLongRunLiteLlmTimeout,
  attachCpaCodexLongRun,
  classifyObservation,
  cpaLongRunYamlLines,
  nextBackoffMs,
  routerLongRunEnvironment,
  shouldAbandonLongRun,
  trimJournal,
} = require("../electron/cpa-codex-long-run.cjs");
const { createOriginalUiController } = require("../electron/original-ui.cjs");
const { runtimeConfiguration } = require("../electron/cpa-managed.cjs");
const { environment } = require("../electron/codex-router-managed.cjs");

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
  assert.ok(EXECUTION_TIMEOUT_MS > WEEK_MS);
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

test("Codex Router long-run environment outlasts a seven-day task instead of the 24h default", () => {
  const env = routerLongRunEnvironment();
  assert.equal(env.MODEL_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS, String(EXECUTION_TIMEOUT_MS));
  assert.equal(env.CODEX_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS, String(EXECUTION_TIMEOUT_MS));
  assert.equal(Number(env.CODEX_ROUTER_GATEWAY_RESTARTS) > 5, true);
  const home = temporaryDirectory("coding-tools-router-home-");
  const state = temporaryDirectory("coding-tools-router-state-");
  const launched = environment(home, state);
  assert.equal(launched.MODEL_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS, String(EXECUTION_TIMEOUT_MS));
  assert.equal(launched.CODEX_ROUTER_GROK_STREAM_STALL_MS, String(2 * 60 * 60_000));
  assert.equal(launched.CODING_TOOLS_CPA_URL, "http://127.0.0.1:8317");
  assert.equal(launched.CODING_TOOLS_CPA_OPENAI_BASE_URL, "http://127.0.0.1:8317/v1");
  assert.equal(launched.CODING_TOOLS_CODEX_ROUTER_URL, "http://127.0.0.1:4202");
});

test("prepare patches LiteLLM's 10-minute request_timeout so streams can last a week", () => {
  const home = temporaryDirectory("coding-tools-litellm-");
  const filePath = path.join(home, "src", "litellm-config.mjs");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "litellm_settings:\n request_timeout: 600\n");
  assert.equal(applyLongRunLiteLlmTimeout(home), true);
  assert.match(fs.readFileSync(filePath, "utf8"), new RegExp(`request_timeout: ${LITELLM_REQUEST_TIMEOUT_SECONDS}`));
  assert.equal(applyLongRunLiteLlmTimeout(home), false);
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

test("original UI controller keeps CPA and Codex Router chrome and wires the long-run supervisor", async () => {
  const controller = createOriginalUiController({
    longRun: false,
    sleep: async () => {},
    externalServices: {
      snapshot: () => ({
        services: [{
          id: "cpa",
          endpoint: "http://127.0.0.1:8317/",
          status: "ready",
          pid: 1,
          home: "/tmp/cpa",
          managedInstall: { state: "installed" },
        }],
      }),
      inspect: async () => {},
      cpaConnection: () => ({ managementKey: "k".repeat(36), proxyApiKey: "p".repeat(36) }),
    },
  });
  const opened = await controller.openEmbedded("cpa", "logs");
  assert.equal(opened.embedded, true);
  assert.equal(opened.originalWindow, false);
  assert.equal(opened.url, "http://127.0.0.1:8317/management.html#/logs");
  assert.equal(opened.tool.originalChrome, true);
  controller.dispose();

  const main = read("electron/main.cjs");
  const surface = read("src/features/OriginalUiSurface.tsx");
  const pack = JSON.parse(read("package.json"));
  assert.match(main, /cpa-codex-long-run\.json/);
  assert.match(main, /powerSaveBlocker/);
  assert.match(surface, /reconnectGeneration/);
  assert.match(surface, /searchParams\.set\("lr"/);
  assert.ok(pack.build.asarUnpack.includes("electron/cpa-codex-long-run.cjs"));
  assert.doesNotMatch(read("src/features/ExternalServicesSurface.tsx"), /CPA Provider Hub/);
});
