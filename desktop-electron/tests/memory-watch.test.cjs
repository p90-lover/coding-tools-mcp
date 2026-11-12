const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryWatch, describeRenderer, growth, readProcesses } = require("../electron/memory-watch.cjs");

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

test("a high main process is logged with where its memory is, every half hour while it lasts", () => {
  // 0.8.49 logged "Browser 11313 MB" once, with nothing to say whether JS, buffers or a worker held it.
  let clock = 0;
  const warnings = [];
  const notices = [];
  const MB = 1024 * 1024;
  const watch = createMemoryWatch({
    appMetrics: () => [{ pid: 40, type: "Browser", memory: { workingSetSize: 11_000 * 1024 } }],
    memoryUsage: () => ({ rss: 11_000 * MB, heapTotal: 80 * MB, heapUsed: 52 * MB, external: 9_000 * MB, arrayBuffers: 8_990 * MB }),
    logger: { warn: (event, detail) => warnings.push({ event, detail }) },
    notify: (notice) => notices.push(notice),
    now: () => clock,
    mainPid: 40,
  });
  const high = () => warnings.filter((entry) => entry.event === "launcher.memory_high");
  watch.sample();
  assert.deepEqual(high()[0].detail, { kind: "Browser", pid: 40, mb: 11_000, totalMb: 11_000,
    main: { rssMb: 11_000, heapUsedMb: 52, heapTotalMb: 80, externalMb: 9_000, arrayBuffersMb: 8_990, otherMb: 1_920 } });
  clock += 5 * MIN;
  watch.sample();
  assert.equal(high().length, 1, "logged again within half an hour");
  clock += 25 * MIN;
  watch.sample();
  assert.equal(high().length, 2);
  assert.equal(notices.length, 1, "the person is still told only once");
});

// A renderer that grows 150 MB every five minutes past the high mark, beside a quiet main process,
// sampled until both warnings are written. 2026-11-12: "Tab 55892", 330 -> 713 MB, was the main window.
function watchRenderer(options = {}) {
  let clock = 0;
  const warnings = [];
  const calls = [];
  const renderer = { pid: 55, kb: 1_000 * 1024 };
  const { describe, ...rest } = options;
  const watch = createMemoryWatch({
    appMetrics: () => [
      { pid: 50, type: "Browser", memory: { workingSetSize: 300 * 1024 } },
      { pid: renderer.pid, type: "Tab", memory: { workingSetSize: renderer.kb } },
    ],
    memoryUsage: () => ({ rss: 300 * 1024 * 1024, heapTotal: 80 * 1024 * 1024, heapUsed: 52 * 1024 * 1024, external: 10 * 1024 * 1024, arrayBuffers: 1 }),
    logger: { warn: (event, detail) => warnings.push({ event, detail }) },
    now: () => clock,
    mainPid: 50,
    highMb: 3_000,
    ...(describe === undefined ? {} : { describe: (pid) => { calls.push(pid); return describe(pid); } }),
    ...rest,
  });
  watch.sample();
  for (let i = 0; i < 14; i += 1) { renderer.kb += 150 * 1024; clock += 5 * MIN; watch.sample(); }
  const of = (event) => warnings.filter((entry) => entry.event === event).map((entry) => entry.detail);
  return { growth: of("launcher.memory_growth"), high: of("launcher.memory_high"), calls };
}

test("a renderer's warnings carry what describe says it hosts, and cannot lose their own fields to it", () => {
  const { growth: grew, high, calls } = watchRenderer({
    describe: (pid) => (pid === 55 ? { role: "main window", origin: "file:", kind: "overwritten", pid: 0, mb: -1 } : { role: "never asked" }),
  });
  assert.equal(grew.length, 1);
  assert.deepEqual(grew[0], { kind: "Tab", pid: 55, fromMb: 1_000, toMb: 2_950, minutes: 70, role: "main window", origin: "file:" });
  assert.equal(high.length, 1);
  assert.deepEqual(high[0], { kind: "Tab", pid: 55, mb: 3_100, totalMb: 3_400, role: "main window", origin: "file:" });
  assert.ok(calls.length >= 2 && calls.every((pid) => pid === 55), "describe is asked only about the renderer, only when a warning is written");
});

test("a missing, failing or odd describe leaves the warnings as they were", () => {
  const plain = watchRenderer();
  assert.deepEqual(plain.growth[0], { kind: "Tab", pid: 55, fromMb: 1_000, toMb: 2_950, minutes: 70 });
  for (const describe of [
    () => { throw new Error("page closed"); },
    () => null,
    () => "main window",
    () => ["main window"],
    "not a function",
  ]) {
    const run = watchRenderer({ describe });
    assert.deepEqual(run.growth, plain.growth);
    assert.deepEqual(run.high, plain.high);
  }
});

test("the main process keeps its memory breakdown and is never described", () => {
  let clock = 0;
  const warnings = [];
  const asked = [];
  const MB = 1024 * 1024;
  const watch = createMemoryWatch({
    appMetrics: () => [{ pid: 40, type: "Browser", memory: { workingSetSize: 11_000 * 1024 } }],
    memoryUsage: () => ({ rss: 11_000 * MB, heapTotal: 80 * MB, heapUsed: 52 * MB, external: 9_000 * MB, arrayBuffers: 8_990 * MB }),
    logger: { warn: (event, detail) => warnings.push({ event, detail }) },
    now: () => clock,
    mainPid: 40,
    describe: (pid) => { asked.push(pid); return { role: "main window" }; },
  });
  watch.sample();
  assert.deepEqual(warnings.find((entry) => entry.event === "launcher.memory_high").detail, { kind: "Browser", pid: 40, mb: 11_000, totalMb: 11_000,
    main: { rssMb: 11_000, heapUsedMb: 52, heapTotalMb: 80, externalMb: 9_000, arrayBuffersMb: 8_990, otherMb: 1_920 } });
  assert.deepEqual(asked, []);
});

test("describeRenderer names a process's page by role and origin only, counts several, and never throws", () => {
  const page = (pid, url, role, extra = {}) => ({ role, getOSProcessId: () => pid, getURL: () => url, isDestroyed: () => false, ...extra });
  const pages = [
    page(4, "file:///C:/Users/someone/AppData/Local/Programs/Coding%20Tools/resources/app.asar/dist/index.html#/chat", "main window"),
    page(7, "https://chatgpt.com/c/0123456789abcdef0123?model=x#top", "browser-host view"),
    page(7, "https://chatgpt.com/g/g-abc/project", "browser-host view"),
    page(7, "https://user:secret@auth.openai.com/log-in", "hidden ChatGPT window"),
    page(9, "http://127.0.0.1:5173/admin?token=abc", "preview"),
    page(4, "https://chatgpt.com/", "closed", { isDestroyed: () => true }),
    page(4, "", "broken", { getOSProcessId: () => { throw new Error("destroyed"); } }),
  ];
  const describe = (pid, roleOf = (contents) => contents.role) => describeRenderer(pid, { contents: () => pages, roleOf });
  // The main window's file path names the person's own folder: only its scheme is kept.
  assert.deepEqual(describe(4), { role: "main window", origin: "file:" });
  assert.deepEqual(describe(9), { role: "preview", origin: "http://127.0.0.1:5173" });
  assert.deepEqual(describe(7), { pages: 3, roles: { "browser-host view": 2, "hidden ChatGPT window": 1 },
    origins: ["https://chatgpt.com", "https://auth.openai.com"] });
  assert.doesNotMatch(JSON.stringify([describe(4), describe(7), describe(9)]), /someone|secret|token|\/c\/|model=|log-in/);
  // The GPU or a utility process hosts no page.
  assert.deepEqual(describe(12), {});
  assert.deepEqual(describe(9, () => { throw new Error("no role"); }), { role: "page", origin: "http://127.0.0.1:5173" });
  assert.deepEqual(describeRenderer(4, { contents: () => { throw new Error("app quitting"); }, roleOf: () => "x" }), {});
  assert.deepEqual(describeRenderer(4, {}), {});
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
