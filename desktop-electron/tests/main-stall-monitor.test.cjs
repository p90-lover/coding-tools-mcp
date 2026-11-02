"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createMainStallMonitor, createMainStallProbe } = require("../electron/main-stall-monitor.cjs");

function fixture() {
  const clock = { ms: 1_000, cpuUs: 0, mainCpuUs: 0 };
  const logged = [];
  const monitor = createMainStallMonitor({
    logger: { warn: (event, detail) => logged.push([event, detail]) },
    now: () => clock.ms,
    cpuUsage: () => ({ user: clock.cpuUs, system: 0 }),
    threadCpuUsage: () => ({ user: clock.mainCpuUs, system: 0 }),
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
  clock.mainCpuUs += 30_000;
  monitor.tick();
  // Blocked running our own code: 3 s late, 3 s of CPU, all of it on main's thread.
  clock.ms += 3_500;
  clock.cpuUs += 3_000_000;
  clock.mainCpuUs += 2_900_000;
  monitor.tick();
  // Seen live 2026-11-02: the process spent more CPU than the gap (other threads busy) while main
  // itself waited. Only mainCpuMs tells the two apart.
  clock.ms += 4_500;
  clock.cpuUs += 4_600_000;
  clock.mainCpuUs += 200_000;
  monitor.tick();
  assert.deepEqual(logged, [
    ["launcher.main_stalled", { ms: 9_000, cpuMs: 40, mainCpuMs: 30, heapMb: 300 }],
    ["launcher.main_stalled", { ms: 3_000, cpuMs: 3_000, mainCpuMs: 2_900, heapMb: 300 }],
    ["launcher.main_stalled", { ms: 4_000, cpuMs: 4_600, mainCpuMs: 200, heapMb: 300 }],
  ]);
});

test("without the thread CPU counter (an older runtime) a stall is logged with the process's CPU only", () => {
  const logged = [];
  let ms = 0;
  const monitor = createMainStallMonitor({ logger: { warn: (event, detail) => logged.push([event, detail]) },
    now: () => ms, cpuUsage: () => ({ user: 0, system: 0 }), threadCpuUsage: () => null,
    memoryUsage: () => ({ heapUsed: 0 }), setRepeat: () => ({ unref() {} }), clearRepeat() {} });
  monitor.start();
  ms += 3_000;
  monitor.tick();
  assert.deepEqual(logged, [["launcher.main_stalled", { ms: 2_500, cpuMs: 0, heapMb: 0 }]]);
});

test("the monitor's timer never keeps the app from quitting", () => {
  let unrefCalled = false;
  const monitor = createMainStallMonitor({ setRepeat: () => ({ unref() { unrefCalled = true; } }), clearRepeat() {} });
  monitor.start();
  monitor.start();
  monitor.stop();
  assert.equal(unrefCalled, true);
});

test("each monitor tick beats the stall probe, so a probe sees main is alive", () => {
  let beats = 0;
  const monitor = createMainStallMonitor({
    logger: { warn() {} },
    now: () => 0,
    cpuUsage: () => ({ user: 0, system: 0 }),
    setRepeat: () => ({ unref() {} }),
    clearRepeat() {},
    probe: { beat: () => { beats += 1; } },
  });
  monitor.start();
  monitor.tick();
  monitor.tick();
  assert.equal(beats, 2);
});

// Runs a real probe in a child process whose main thread either stays healthy or is held by a
// native call (spawnSync of a sleeping child), once or twice with main running in between, and
// returns what the probe logged; `.holds` says how long each hold really took.
function probeChild(holdMs, secondHoldMs = 0) {
  const { spawnSync } = require("node:child_process");
  const modulePath = require.resolve("../electron/main-stall-monitor.cjs");
  const script = `
    const { createMainStallProbe } = require(${JSON.stringify(modulePath)});
    const { spawnSync } = require("node:child_process");
    const logged = [];
    const holds = [];
    const logger = { warn: (event, detail) => logged.push([event, detail]), info: (event, detail) => logged.push([event, detail]) };
    const probe = createMainStallProbe({ logger, probeAfterMs: 300, pollMs: 50 });
    probe.start();
    const beat = setInterval(() => probe.beat(), 50);
    const done = () => setTimeout(() => { clearInterval(beat); probe.stop(); process.stdout.write(JSON.stringify({ logged, holds })); }, 2000);
    // Like a real caller, it uses the result: main's next function call is where the pause lands.
    const describe = (result) => ({ status: result.status });
    function heldByTestCall(ms) {
      const started = Date.now();
      const result = spawnSync(process.execPath, ["-e", "setTimeout(() => {}, " + ms + ")"]);
      holds.push(Date.now() - started);
      return describe(result);
    }
    setTimeout(() => {
      if (${holdMs} <= 0) return done();
      heldByTestCall(${holdMs});
      if (${secondHoldMs} <= 0) return done();
      setTimeout(() => { heldByTestCall(${secondHoldMs}); done(); }, 1500);
    }, 200);
  `;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const { logged, holds } = JSON.parse(result.stdout);
  return Object.defineProperty(logged, "holds", { value: holds }); // not enumerable: deepEqual still compares the events
}

test("a stall no wrapped call explains is logged with the function that was waiting", () => {
  // Seen live 2026-11-01 20:11: main held 61 s with 187 ms of CPU and no blockedBy.
  const logged = probeChild(1_500);
  const callers = logged.filter(([event]) => event === "launcher.main_stall_caller");
  assert.equal(callers.length, 1, JSON.stringify(logged));
  const [, detail] = callers[0];
  assert.ok(detail.heldMs >= 1_000, `held ${detail.heldMs} ms`);
  // The file comes from the scripts the debugger reported ("[eval]" for a -e script); Node's own
  // frames (the timer that called it) are left out.
  assert.ok(detail.frames.some(frame => frame.startsWith("heldByTestCall [eval]:")), JSON.stringify(detail));
  assert.ok(detail.frames.every(frame => !frame.includes("timers")), JSON.stringify(detail));
});

test("each stall's probe reports how long that stall held main, not the time since the first one", () => {
  // Seen live 2026-11-02: every launcher.main_stall_caller after the app's first said heldMs ≈ 6.4 M.
  const logged = probeChild(1_000, 1_000);
  const held = logged.filter(([event]) => event === "launcher.main_stall_caller").map(([, detail]) => detail.heldMs);
  assert.equal(held.length, 2, JSON.stringify(logged));
  assert.ok(held[1] >= 300 && held[1] <= logged.holds[1] + 500, `the second hold took ${logged.holds[1]} ms; reported ${held[1]} ms`);
});

test("a healthy main is never paused by the probe", () => {
  assert.deepEqual(probeChild(0), []);
});

test("a probe whose worker cannot start says so once and does not throw", () => {
  const logged = [];
  const probe = createMainStallProbe({
    logger: { info: (event, detail) => logged.push([event, detail]), warn: (event, detail) => logged.push([event, detail]) },
    createWorker: () => { throw new Error("workers unavailable"); },
  });
  probe.start();
  probe.beat();
  probe.stop();
  assert.deepEqual(logged, [["launcher.main_stall_probe_unavailable", { message: "workers unavailable" }]]);
});
