const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryWatch, growth, readProcesses } = require("../electron/memory-watch.cjs");

const MIN = 60_000;
const series = (values, stepMs = 5 * MIN) => values.map((mb, index) => ({ at: index * stepMs, mb }));

test("steady growth over an hour is a leak; a spike, a plateau or a short climb is not", () => {
  // 400 MB climbing to ~1 GB over 75 minutes, a step up almost every sample.
  const leak = series([400, 420, 450, 470, 500, 540, 580, 620, 660, 700, 760, 820, 880, 940, 1000, 1060]);
  assert.deepEqual(growth(leak), { fromMb: 410, toMb: 1000, minutes: 70 });
  // One big chat opened: a jump, then flat at the new size.
  const spike = series([400, 400, 410, 400, 1200, 1210, 1205, 1200, 1210, 1200, 1205, 1210, 1200, 1205, 1210, 1200]);
  assert.equal(growth(spike), null, "a single jump then flat is not steady growth");
  // Big but not growing.
  assert.equal(growth(series(Array(16).fill(2500))), null);
  // Climbing fast, but for less than the window.
  assert.equal(growth(series([400, 600, 800, 1000, 1200, 1400, 1600])), null);
  // Growth too small to matter.
  assert.equal(growth(series([100, 105, 110, 115, 120, 125, 130, 135, 140, 145, 150, 155, 160, 165, 170, 175])), null);
});

test("processes are read from Electron's metrics plus the main JS heap", () => {
  const processes = readProcesses({
    appMetrics: () => [{ pid: 10, type: "Browser", memory: { workingSetSize: 204_800 } }, { pid: 11, type: "Tab", name: "Coding Tools", memory: { workingSetSize: 512_000 } }, { pid: 12, type: "GPU" }],
    memoryUsage: () => ({ heapUsed: 64 * 1024 * 1024 }),
  });
  assert.deepEqual(processes.map(({ kind, mb }) => [kind, mb]), [["Browser", 200], ["Coding Tools", 500], ["Main JS heap", 64]]);
});

test("a growing process is logged once per repeat period, and a recreated renderer starts a new history", () => {
  let clock = 0;
  let renderer = { pid: 20, kb: 400 * 1024 };
  const warnings = [];
  const watch = createMemoryWatch({
    appMetrics: () => [{ pid: renderer.pid, type: "Tab", name: "Coding Tools", memory: { workingSetSize: renderer.kb } }],
    memoryUsage: () => ({ heapUsed: 50 * 1024 * 1024 }),
    logger: { warn: (event, detail) => warnings.push({ event, detail }) },
    now: () => clock,
    repeatMs: 60 * MIN,
  });
  const step = (addMb) => { renderer.kb += addMb * 1024; clock += 5 * MIN; return watch.sample(); };
  watch.sample();
  for (let i = 0; i < 14; i += 1) step(50);
  const growthWarnings = () => warnings.filter((entry) => entry.event === "launcher.memory_growth");
  assert.equal(growthWarnings().length, 1);
  assert.equal(growthWarnings()[0].detail.kind, "Coding Tools");
  for (let i = 0; i < 3; i += 1) step(50);
  assert.equal(growthWarnings().length, 1, "not repeated within the repeat period");
  for (let i = 0; i < 12; i += 1) step(50);
  assert.equal(growthWarnings().length, 2, "repeated after it");
  // The watchdog recreated the renderer: a new pid, low again, with no inherited history.
  renderer = { pid: 21, kb: 300 * 1024 };
  step(0);
  assert.deepEqual(watch.status().map(({ pid, samples }) => [pid, samples]).filter(([pid]) => pid !== process.pid), [[21, 1]]);
});

test("a process past the high mark is told to the person once per quiet period", () => {
  let clock = 0;
  const notices = [];
  const watch = createMemoryWatch({
    appMetrics: () => [{ pid: 30, type: "Tab", name: "Coding Tools", memory: { workingSetSize: 3200 * 1024 } }, { pid: 31, type: "GPU", memory: { workingSetSize: 300 * 1024 } }],
    memoryUsage: () => ({ heapUsed: 1 }),
    notify: (notice) => notices.push(notice),
    now: () => clock,
    notifyAgainMs: 10 * MIN,
  });
  watch.sample();
  clock += 5 * MIN;
  watch.sample();
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /Coding Tools uses 3\.1 GB \(the app 3\.4 GB\)/);
  clock += 10 * MIN;
  watch.sample();
  assert.equal(notices.length, 2);
});

test("the watch samples at start and on a timer until stopped; a failed read is logged, not thrown", () => {
  const timers = [];
  const warnings = [];
  const watch = createMemoryWatch({
    appMetrics: () => { throw new Error("no metrics yet"); },
    logger: { warn: (event) => warnings.push(event) },
    setRepeat: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearRepeat: (timer) => { timer.cleared = true; },
  });
  watch.start();
  watch.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5 * MIN);
  assert.deepEqual(warnings, ["launcher.memory_sample_failed"]);
  watch.stop();
  assert.equal(timers[0].cleared, true);
});
