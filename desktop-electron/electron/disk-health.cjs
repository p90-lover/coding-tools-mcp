"use strict";

// Warns when a disk the app lives on is failing or nearly full. Both break the app long before
// anything else says so: a failing disk loses writes (torn settings, a database that will not
// open) and stalls every synchronous read; a full one fails saves, chat starts and updates.
// On 2026-10-30 the G:/H: drive logged thousands of paging errors and lost $Mft writes for hours
// while the app only looked slow and broken; Windows itself still called the drive "Healthy".
//
// Every check reads the free space of each volume the app uses and, on Windows, the disk and NTFS
// errors Windows logged since the last check. A problem is notified once per NOTIFY_AGAIN_MS, or
// sooner when it gets worse; nothing is written to disk.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const FIRST_CHECK_MS = 3 * 60_000;
const CHECK_MS = 30 * 60_000;
const NOTIFY_AGAIN_MS = 12 * 60 * 60_000;
const GIB = 1024 ** 3;

// disk: 7 bad block, 51 error during a paging operation, 153 I/O retried.
// NTFS: 50 delayed write lost ("Ntfs"), 55 file system structure corrupt, 98 volume needs repair,
// 140 failed to flush data ("Microsoft-Windows-Ntfs").
const DISK_EVENT_IDS = [7, 51, 153];
const NTFS_EVENT_IDS = [50, 55, 98, 140];

function eventQuery(lookbackMs) {
  const ids = (list) => list.map((id) => `EventID=${id}`).join(" or ");
  return `*[System[((Provider[@Name='disk'] and (${ids(DISK_EVENT_IDS)}))`
    + ` or ((Provider[@Name='Ntfs'] or Provider[@Name='Microsoft-Windows-Ntfs']) and (${ids(NTFS_EVENT_IDS)})))`
    + ` and TimeCreated[timediff(@SystemTime) <= ${Math.max(1, Math.round(lookbackMs))}]]]`;
}

/** Parses `wevtutil qe /f:xml` output into `{ provider, id, at, drives }`; `drives` are the letters named in the event's data (NTFS names the file it lost). */
function parseEvents(xml) {
  const events = [];
  for (const [block] of String(xml).matchAll(/<Event[\s>][\s\S]*?<\/Event>/g)) {
    const provider = /<Provider\s+Name=['"]([^'"]+)['"]/.exec(block)?.[1] ?? "";
    const id = Number(/<EventID[^>]*>(\d+)<\/EventID>/.exec(block)?.[1]);
    const at = /<TimeCreated\s+SystemTime=['"]([^'"]+)['"]/.exec(block)?.[1] ?? null;
    const data = (/<EventData>([\s\S]*?)<\/EventData>/.exec(block)?.[1] ?? "");
    const drives = [...new Set([...data.matchAll(/\b([A-Za-z]):\\/g)].map((m) => `${m[1].toUpperCase()}:`))];
    if (Number.isInteger(id)) events.push({ provider, id, at, drives });
  }
  return events;
}

function readWindowsDiskEvents({ lookbackMs, run = execFile }) {
  return new Promise((resolve, reject) => {
    run("wevtutil", ["qe", "System", `/q:${eventQuery(lookbackMs)}`, "/c:500", "/rd:true", "/f:xml"],
      { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(parseEvents(stdout))));
  });
}

/** The distinct volumes under `paths`, with their free and total bytes; a path that cannot be read is skipped. */
async function readVolumes(paths, statfs = fs.promises.statfs) {
  const roots = new Map();
  for (const target of paths.filter(Boolean)) {
    const root = path.parse(path.resolve(target)).root.toUpperCase();
    if (!roots.has(root)) roots.set(root, target);
  }
  const volumes = [];
  for (const [root, target] of roots) {
    try {
      const stats = await statfs(target);
      volumes.push({ root, freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize) });
    } catch { /* gone or unreadable: the next check tries again */ }
  }
  return volumes;
}

/**
 * How short of space `volume` ({ root, freeBytes, totalBytes }) is: "critical", "low", or null
 * when it has room. "critical" is where saves and chat starts are about to fail; "low" is a
 * heads-up while there is still time to clean up.
 */
function spaceSeverity(volume) {
  // Fixed sizes, not a share of the drive: what fails is a write of a known size whatever the drive
  // (an update unpacks ~1.4 GB; AO's database and its WAL grow by hundreds of MB), and 5% of a
  // 2 TB drive is still 100 GB of room. Builds and test runs filled G: to 0 before (2026-10).
  const free = Number(volume?.freeBytes);
  if (!Number.isFinite(free)) return null;
  if (free < 1.5 * GIB) return "critical";
  if (free < 5 * GIB) return "low";
  return null;
}

const SEVERITY_RANK = { low: 1, critical: 2 };
const driveName = (root) => root.replace(/\\$/, "");
const formatGib = (bytes) => `${(bytes / GIB).toFixed(bytes < 10 * GIB ? 1 : 0)} GB`;

/** The problems a check found, each `{ key, severity, title, body }`. */
function assessDiskHealth({ volumes = [], events = [], lookbackMs = CHECK_MS }) {
  const problems = [];
  if (events.length) {
    const drives = [...new Set(events.flatMap((event) => event.drives))].sort();
    const lost = events.filter((event) => event.id === 50 || event.id === 140).length;
    // Any NTFS event means the file system itself took damage (lost writes, a volume to repair);
    // disk events alone may still be retries that succeeded.
    const damaged = events.some((event) => /ntfs/i.test(event.provider));
    const minutes = Math.max(1, Math.round(lookbackMs / 60_000));
    problems.push({
      key: "disk-errors",
      severity: damaged ? "critical" : "low",
      count: events.length,
      drives,
      title: "A disk is reporting errors",
      body: `Windows logged ${events.length} disk error${events.length === 1 ? "" : "s"} in the last ${minutes} minutes`
        + `${drives.length ? ` on ${drives.join(", ")}` : ""}${lost ? `, and ${lost} write${lost === 1 ? " was" : "s were"} lost` : ""}.`
        + " Back up your work and check the drive and its cable; Coding Tools may lose data or freeze until it is fixed.",
    });
  }
  for (const volume of volumes) {
    const severity = spaceSeverity(volume);
    if (!severity) continue;
    const drive = driveName(volume.root);
    problems.push({
      key: `space:${drive}`,
      severity,
      freeBytes: volume.freeBytes,
      title: `${drive} is ${severity === "critical" ? "almost" : "getting"} full`,
      body: `Only ${formatGib(volume.freeBytes)} is left on ${drive}, which Coding Tools uses.`
        + " Free some space so chats, saves and updates keep working.",
    });
  }
  return problems;
}

function createDiskHealthMonitor({ paths, logger, notify, platform = process.platform,
  readEvents = readWindowsDiskEvents, statfs = fs.promises.statfs, now = () => Date.now(),
  firstCheckMs = FIRST_CHECK_MS, checkMs = CHECK_MS, notifyAgainMs = NOTIFY_AGAIN_MS,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  let running = null;
  let lastCheckAt = null;
  let latest = { checkedAt: null, problems: [] };
  const notified = new Map();

  const check = () => {
    if (running) return running;
    running = (async () => {
      const at = now();
      // Since the last check, so no event is missed between checks or counted twice.
      const lookbackMs = lastCheckAt === null ? checkMs : Math.max(60_000, at - lastCheckAt);
      lastCheckAt = at;
      const volumes = await readVolumes(paths, statfs);
      let events = [];
      if (platform === "win32") {
        try {
          events = await readEvents({ lookbackMs });
        } catch (error) {
          logger?.warn?.("launcher.disk_health_events_failed", { message: error instanceof Error ? error.message : String(error) });
        }
      }
      const problems = assessDiskHealth({ volumes, events, lookbackMs });
      latest = { checkedAt: new Date(at).toISOString(), problems };
      for (const problem of problems) {
        const previous = notified.get(problem.key);
        const worse = previous && SEVERITY_RANK[problem.severity] > SEVERITY_RANK[previous.severity];
        if (previous && !worse && at - previous.at < notifyAgainMs) continue;
        notified.set(problem.key, { at, severity: problem.severity });
        const { title, body, ...detail } = problem;
        logger?.warn?.("launcher.disk_health", detail);
        try { notify?.({ title, body }); } catch { /* notifications are best effort */ }
      }
      return latest;
    })().finally(() => { running = null; });
    return running;
  };

  const schedule = (delay) => {
    timer = setTimer(() => {
      void check().catch(() => {}).finally(() => { if (timer) schedule(checkMs); });
    }, delay);
    timer?.unref?.();
  };

  return {
    start() {
      if (!timer) schedule(firstCheckMs);
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
    check,
    /** The last check's time and problems, for diagnostics. */
    status: () => structuredClone(latest),
  };
}

module.exports = {
  CHECK_MS,
  assessDiskHealth,
  createDiskHealthMonitor,
  eventQuery,
  parseEvents,
  readVolumes,
  spaceSeverity,
};
