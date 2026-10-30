const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assessDiskHealth, createDiskHealthMonitor, eventQuery, parseEvents, readVolumes, spaceSeverity,
} = require("../electron/disk-health.cjs");

const GIB = 1024 ** 3;
// What `wevtutil qe System /f:xml` printed for the G:/H: drive on 2026-10-30, trimmed.
const EVENTS_XML = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='disk'/><EventID Qualifiers='32772'>51</EventID><TimeCreated SystemTime='2026-10-30T00:18:04.1Z'/></System><EventData><Data>\\Device\\Harddisk2\\DR2</Data><Binary>0F01</Binary></EventData></Event>
<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Ntfs' Guid='{dd70bc80}'/><EventID Qualifiers='32772'>50</EventID><TimeCreated SystemTime='2026-10-30T00:19:11.5Z'/></System><EventData><Data></Data><Data>G:\\$Mft</Data><Data>g:\\$LogFile</Data></EventData></Event>`;

const volume = (root, freeGib, totalGib = 465) => ({ root, freeBytes: freeGib * GIB, totalBytes: totalGib * GIB });

test("disk and NTFS errors are read from wevtutil's XML with the drives they name", () => {
  assert.deepEqual(parseEvents(EVENTS_XML), [
    { provider: "disk", id: 51, at: "2026-10-30T00:18:04.1Z", drives: [] },
    { provider: "Ntfs", id: 50, at: "2026-10-30T00:19:11.5Z", drives: ["G:"] },
  ]);
  assert.deepEqual(parseEvents(""), []);
  const query = eventQuery(30 * 60_000);
  assert.match(query, /Provider\[@Name='disk'\] and \(EventID=7 or EventID=51 or EventID=153\)/);
  assert.match(query, /Provider\[@Name='Microsoft-Windows-Ntfs'\]/);
  assert.match(query, /timediff\(@SystemTime\) <= 1800000/);
});

test("disk errors are a problem, and lost writes make it critical", () => {
  const [problem] = assessDiskHealth({ events: parseEvents(EVENTS_XML), lookbackMs: 30 * 60_000 });
  assert.equal(problem.key, "disk-errors");
  assert.equal(problem.severity, "critical");
  assert.deepEqual(problem.drives, ["G:"]);
  assert.match(problem.body, /2 disk errors in the last 30 minutes on G:, and 1 write was lost/);
  const [retried] = assessDiskHealth({ events: [{ provider: "disk", id: 153, at: null, drives: [] }] });
  assert.equal(retried.severity, "low");
  // NTFS names the volume by GUID in event 98; the volume needs repair even with no write lost.
  const [repair] = assessDiskHealth({ events: [{ provider: "Microsoft-Windows-Ntfs", id: 98, at: null, drives: [] }] });
  assert.equal(repair.severity, "critical");
  assert.doesNotMatch(repair.body, /lost/);
  assert.deepEqual(assessDiskHealth({ events: [], volumes: [volume("D:\\", 300)] }), []);
});

test("a nearly full drive is a problem and a roomy one is not", () => {
  assert.equal(spaceSeverity(volume("G:\\", 0.1)), "critical", "100 MB free: saves are about to fail");
  assert.equal(spaceSeverity(volume("H:\\", 300)), null);
  const [problem] = assessDiskHealth({ volumes: [volume("G:\\", 0.1), volume("H:\\", 300)] });
  assert.equal(problem.key, "space:G:");
  assert.match(problem.title, /^G: is almost full$/);
  assert.match(problem.body, /Only 0\.1 GB is left on G:/);
});

test("volumes are read once per drive and an unreadable path is skipped", async () => {
  const asked = [];
  const statfs = async (target) => {
    asked.push(target);
    if (target.startsWith("Z:")) throw new Error("ENOENT");
    return { bavail: 10, bsize: GIB, blocks: 100 };
  };
  const volumes = await readVolumes(["G:\\Coding Tools\\data", "g:\\other", "Z:\\gone", null], statfs);
  assert.deepEqual(asked, ["G:\\Coding Tools\\data", "Z:\\gone"]);
  assert.deepEqual(volumes, [{ root: "G:\\", freeBytes: 10 * GIB, totalBytes: 100 * GIB }]);
});

test("a problem is notified once, again when it gets worse, and again after the quiet period", async () => {
  let clock = 0;
  let events = [{ provider: "disk", id: 153, at: null, drives: [] }];
  const notices = [];
  const warnings = [];
  const monitor = createDiskHealthMonitor({
    paths: ["G:\\data"],
    platform: "win32",
    statfs: async () => ({ bavail: 300, bsize: GIB, blocks: 465 }),
    readEvents: async () => events,
    notify: (notice) => notices.push(notice),
    logger: { warn: (event, detail) => warnings.push({ event, detail }) },
    now: () => clock,
    notifyAgainMs: 1_000_000,
  });
  await monitor.check();
  assert.equal(notices.length, 1);
  assert.equal(warnings[0].event, "launcher.disk_health");
  assert.equal(warnings[0].detail.severity, "low");
  clock += 1_000;
  await monitor.check();
  assert.equal(notices.length, 1, "the same problem is not repeated");
  events = [{ provider: "Ntfs", id: 50, at: null, drives: ["G:"] }];
  clock += 1_000;
  await monitor.check();
  assert.equal(notices.length, 2, "lost writes are worse and are told at once");
  clock += 1_000_000;
  await monitor.check();
  assert.equal(notices.length, 3);
  assert.equal(monitor.status().problems[0].key, "disk-errors");
  events = [];
  clock += 1_000;
  assert.deepEqual((await monitor.check()).problems, []);
});

test("a failed event read is logged and the space check still runs; other systems skip the event log", async () => {
  const warnings = [];
  const monitor = createDiskHealthMonitor({
    paths: ["G:\\data"],
    platform: "win32",
    statfs: async () => ({ bavail: 1, bsize: 100 * 1024 * 1024, blocks: 4650 }),
    readEvents: async () => { throw new Error("wevtutil is missing"); },
    logger: { warn: (event, detail) => warnings.push({ event, detail }) },
  });
  const result = await monitor.check();
  assert.equal(warnings[0].event, "launcher.disk_health_events_failed");
  assert.equal(result.problems[0].key, "space:G:");
  let read = false;
  await createDiskHealthMonitor({ paths: [], platform: "linux", readEvents: async () => { read = true; return []; } }).check();
  assert.equal(read, false);
});

test("the monitor checks after launch settles, then on a repeating timer until stopped", async () => {
  const timers = [];
  let checks = 0;
  const monitor = createDiskHealthMonitor({
    paths: [],
    platform: "linux",
    statfs: async () => { checks += 1; return { bavail: 1, bsize: 1, blocks: 1 }; },
    firstCheckMs: 5,
    checkMs: 50,
    setTimer: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  monitor.start();
  monitor.start();
  assert.deepEqual(timers.map((timer) => timer.delay), [5]);
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(timers.map((timer) => timer.delay), [5, 50]);
  monitor.stop();
  assert.equal(timers[1].cleared, true);
});
