"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createMainStallMonitor } = require("../electron/main-stall-monitor.cjs");

function fixture() {
  const clock = { ms: 1_000, cpuUs: 0 };
  const logged = [];
  const monitor = createMainStallMonitor({
    logger: { warn: (event, detail) => logged.push([event, detail]) },
    now: () => clock.ms,
    cpuUsage: () => ({ user: clock.cpuUs, system: 0 }),
    memoryUsage: () => ({ heapUsed: 300 * 1_048_576 }),
    setRepeat: () => ({ unref() {} }),
    clearRepeat() {},
  });
  monitor.start();
  return { clock, logged, monitor };
}

test("a main event loop blocked for seconds is logged with its length and the CPU it used", () => {
  const { clock, logged, monitor } = fixture();
  clock.ms += 500;
  monitor.tick();
  assert.deepEqual(logged, [], "an on-time tick is not a stall");
  clock.ms += 1_900;
  monitor.tick();
  assert.deepEqual(logged, [], "1.4 s late is scheduling noise");
  // Blocked waiting (sync disk I/O on the hard disk): 9 s late, 40 ms of CPU.
  clock.ms += 9_500;
  clock.cpuUs += 40_000;
  monitor.tick();
  // Blocked running our own code: 3 s late, 3 s of CPU.
  clock.ms += 3_500;
  clock.cpuUs += 3_000_000;
  monitor.tick();
  assert.deepEqual(logged, [
    ["launcher.main_stalled", { ms: 9_000, cpuMs: 40, heapMb: 300 }],
    ["launcher.main_stalled", { ms: 3_000, cpuMs: 3_000, heapMb: 300 }],
  ]);
});

test("the monitor's timer never keeps the app from quitting", () => {
  let unrefCalled = false;
  const monitor = createMainStallMonitor({ setRepeat: () => ({ unref() { unrefCalled = true; } }), clearRepeat() {} });
  monitor.start();
  monitor.start();
  monitor.stop();
  assert.equal(unrefCalled, true);
});
