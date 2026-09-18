"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createFiveStackLoopbackProbes } = require("../electron/five-stack-loopback-probes.cjs");

test("loopback probes publish only on fingerprint changes and recover after crashes", async () => {
  const published = [];
  const warnings = [];
  let calls = 0;
  const healthy = {
    stacks: [
      { id: "cpa", listening: true, fallbackUsed: false, statusCode: 401, error: null },
    ],
  };
  const timers = [];
  const probes = createFiveStackLoopbackProbes({
    probeAll: async () => {
      calls += 1;
      if (calls === 2) throw new Error("probe crashed");
      return healthy;
    },
    onChange: (snapshot) => published.push(snapshot),
    logger: { warn: (message) => warnings.push(message) },
    healthyIntervalMs: 5,
    minIntervalMs: 5,
    maxIntervalMs: 20,
    setTimer: (fn, delay) => {
      const timer = { fn, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  probes.start();
  assert.equal(timers.length, 1);
  await timers.shift().fn();
  assert.equal(published.length, 1);
  await timers.shift().fn();
  assert.equal(published.length, 1);
  assert.equal(warnings.length, 1);
  await timers.shift().fn();
  assert.equal(published.length, 1);
  assert.equal(probes.stats().ticks >= 3, true);
  probes.stop();
  assert.equal(timers.length, 0);
});
