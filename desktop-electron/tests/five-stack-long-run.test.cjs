"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BACKOFF_SECONDS,
  FIVE_STACK_IDS,
  HEARTBEAT_MS,
  MAX_ATTEMPTS,
  STABLE_RESET_MS,
  TARGET_UPTIME_MS,
  createFiveStackLongRun,
} = require("../electron/five-stack-long-run.cjs");

function createHarness() {
  let nowMs = 1_000;
  let stored = "";
  const longRun = createFiveStackLongRun({
    now: () => nowMs,
    readFile: () => stored,
    writeFile: (value) => {
      stored = value;
    },
  });
  return {
    longRun,
    advance(ms) {
      nowMs += ms;
    },
    setNow(value) {
      nowMs = value;
    },
    stored: () => stored,
    reload() {
      return createFiveStackLongRun({
        now: () => nowMs,
        readFile: () => stored,
        writeFile: (value) => {
          stored = value;
        },
      });
    },
  };
}

test("five-stack long-run covers all five stacks with a seven-day target", () => {
  assert.deepEqual(FIVE_STACK_IDS, [
    "cpa",
    "codex-router",
    "commandcode-proxy",
    "paseo",
    "anneal",
  ]);
  assert.equal(TARGET_UPTIME_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(HEARTBEAT_MS, 30_000);
  assert.deepEqual(BACKOFF_SECONDS, [5, 15, 30, 60, 120, 300]);
  assert.equal(MAX_ATTEMPTS, 8);
  assert.equal(STABLE_RESET_MS, 120_000);
});

test("seven days of healthy heartbeats never reconnects or blocks", () => {
  const harness = createHarness();
  for (const id of FIVE_STACK_IDS) harness.longRun.setDesired(id, "running");
  const ticks = TARGET_UPTIME_MS / HEARTBEAT_MS;
  let reconnects = 0;
  let blocks = 0;
  const live = Object.fromEntries(
    FIVE_STACK_IDS.map((id) => [id, { status: "ready", installState: "installed" }]),
  );
  for (let i = 0; i < ticks; i += 1) {
    harness.advance(HEARTBEAT_MS);
    const actions = harness.longRun.planTick(live);
    reconnects += actions.filter((action) => action.action === "reconnect").length;
    blocks += actions.filter((action) => action.action === "block").length;
  }
  assert.equal(reconnects, 0);
  assert.equal(blocks, 0);
  for (const id of FIVE_STACK_IDS) {
    assert.equal(harness.longRun.summary(id, "ready").uiStatus, "ready");
    assert.equal(harness.longRun.summary(id, "ready").reconnectAttempts, 0);
  }
});

test("a child-process crash reconnects with backoff instead of spawning immediately", () => {
  const harness = createHarness();
  harness.longRun.setDesired("cpa", "running");
  harness.longRun.noteHealthy("cpa");
  harness.advance(HEARTBEAT_MS);
  harness.longRun.planTick({ cpa: { status: "ready", installState: "installed" } });
  harness.advance(HEARTBEAT_MS);
  const first = harness.longRun.planTick({ cpa: { status: "offline", installState: "installed" } });
  assert.deepEqual(first, [{ id: "cpa", action: "reconnect" }]);
  assert.equal(harness.longRun.summary("cpa", "offline").uiStatus, "reconnecting");
  const immediate = harness.longRun.planTick({ cpa: { status: "offline", installState: "installed" } });
  assert.equal(immediate.some((action) => action.action === "reconnect"), false);
  harness.advance(5_000);
  const second = harness.longRun.planTick({ cpa: { status: "offline", installState: "installed" } });
  assert.deepEqual(second, [{ id: "cpa", action: "reconnect" }]);
});

test("eight consecutive crashes cap reconnects and require a manual start", () => {
  const harness = createHarness();
  harness.longRun.setDesired("paseo", "running");
  const live = { paseo: { status: "offline", installState: "installed" } };
  const reconnects = [];
  for (let i = 0; i < 12; i += 1) {
    const actions = harness.longRun.planTick(live);
    reconnects.push(...actions.filter((action) => action.action === "reconnect"));
    const waitSeconds = Math.max(harness.longRun.summary("paseo", "offline").retryAfterSeconds, 1);
    harness.advance(waitSeconds * 1000 + 1);
  }
  assert.equal(reconnects.length, MAX_ATTEMPTS);
  assert.equal(harness.longRun.summary("paseo", "offline").uiStatus, "blocked");
  assert.equal(
    harness.longRun.planTick(live).some((action) => action.action === "reconnect"),
    false,
  );
  harness.longRun.setDesired("paseo", "running");
  const resumed = harness.longRun.planTick(live);
  assert.deepEqual(resumed, [{ id: "paseo", action: "reconnect" }]);
});

test("an eight-hour sleep gap is not counted as a crash", () => {
  const harness = createHarness();
  harness.longRun.setDesired("anneal", "running");
  harness.longRun.noteHealthy("anneal");
  harness.advance(HEARTBEAT_MS);
  harness.longRun.planTick({ anneal: { status: "ready", installState: "installed" } });
  harness.advance(8 * 60 * 60 * 1000);
  const slept = harness.longRun.planTick({ anneal: { status: "offline", installState: "installed" } });
  assert.deepEqual(slept, [{ id: "anneal", action: "suspend" }]);
  assert.equal(harness.longRun.summary("anneal", "offline").reconnectAttempts, 0);
  harness.advance(HEARTBEAT_MS);
  const afterWake = harness.longRun.planTick({ anneal: { status: "offline", installState: "installed" } });
  assert.deepEqual(afterWake, [{ id: "anneal", action: "reconnect" }]);
  assert.equal(harness.longRun.summary("anneal", "offline").uiStatus, "reconnecting");
});

test("durable state survives a simulated desktop restart and restores the selected section", () => {
  const harness = createHarness();
  harness.longRun.setDesired("codex-router", "running");
  harness.longRun.setSelectedSection("codex-router", "models");
  harness.longRun.setDesired("commandcode-proxy", "stopped");
  harness.longRun.persist(true);
  const payload = harness.stored();
  assert.match(payload, /"desired": "running"/);
  assert.doesNotMatch(payload, /secret|token|apiKey|managementKey/i);

  const restored = harness.reload();
  assert.equal(restored.desired("codex-router"), "running");
  assert.equal(restored.summary("codex-router").selectedSection, "models");
  assert.equal(restored.desired("commandcode-proxy"), "stopped");
  assert.equal(restored.shouldAutoStart("commandcode-proxy"), false);
});

test("explicit stop keeps the supervisor idle until the user starts again", () => {
  const harness = createHarness();
  harness.longRun.setDesired("cpa", "running");
  harness.longRun.setDesired("cpa", "stopped");
  harness.advance(HEARTBEAT_MS);
  const actions = harness.longRun.planTick({ cpa: { status: "offline", installState: "installed" } });
  assert.deepEqual(actions, []);
  assert.equal(harness.longRun.summary("cpa", "offline").uiStatus, "stopped");
});
