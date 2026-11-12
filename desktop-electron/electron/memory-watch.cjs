"use strict";

// Watches the app's own processes for memory that keeps growing (a leak), not for memory that is
// merely high: Chromium renderers grow and shrink with what is on screen, so one high reading says
// little. Every SAMPLE_MS each Electron process's working set is sampled (app.getAppMetrics(), no
// process spawned); a process whose recent median stands GROWTH_MB and GROWTH_RATIO above its median
// at least WINDOW_MS earlier, and that grew in most samples since, is logged once per REPEAT_MS.
// A process past HIGH_MB is also told to the person, once per NOTIFY_AGAIN_MS.
//
// Samples stay in memory (MAX_SAMPLES per process, by pid: a renderer the watchdog recreated is a
// new process with its own history). Nothing is written to disk but the log entries themselves.
//
// An entry names its process: the main process by where its memory is (mainBreakdown), any other by
// what `describe(pid)` says it hosts (main.cjs: the window or page, describeRenderer). 2026-11-12's
// "Tab 55892" entry took several process and DevTools probes to place as the main window.

const SAMPLE_MS = 5 * 60_000;
const MAX_SAMPLES = 36; // three hours
const WINDOW_MS = 60 * 60_000;
const GROWTH_MB = 300;
const GROWTH_RATIO = 1.5;
const HIGH_MB = 3_000;
const REPEAT_MS = 2 * 60 * 60_000;
const NOTIFY_AGAIN_MS = 12 * 60 * 60_000;
const HIGH_LOG_MS = 30 * 60_000;
const MB = 1024 * 1024;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Whether `samples` ({ at, mb }, oldest first) show a leak: the median of the last three stands
 * `growthMb` and `growthRatio` above the median of the (up to three) samples taken at least
 * `windowMs` before them, and at least two thirds of the steps since went up. Returns { fromMb, toMb, minutes } or null.
 */
function growth(samples, { windowMs = WINDOW_MS, growthMb = GROWTH_MB, growthRatio = GROWTH_RATIO } = {}) {
  if (samples.length < 6) return null;
  const recent = samples.slice(-3);
  const start = samples.findLastIndex((sample) => recent[0].at - sample.at >= windowMs);
  if (start < 0) return null;
  const early = samples.slice(Math.max(0, start - 2), start + 1);
  const fromMb = median(early.map((sample) => sample.mb));
  const toMb = median(recent.map((sample) => sample.mb));
  if (toMb - fromMb < growthMb || toMb < fromMb * growthRatio) return null;
  const span = samples.slice(start);
  const rises = span.slice(1).filter((sample, index) => sample.mb >= span[index].mb).length;
  if (rises < (span.length - 1) * (2 / 3)) return null;
  return { fromMb: Math.round(fromMb), toMb: Math.round(toMb), minutes: Math.round((recent.at(-1).at - early.at(-1).at) / 60_000) };
}

/**
 * Where the main process's memory is, for an entry about it: its JS heap, the buffers that heap
 * holds (external, arrayBuffers among them), and the rest of the process (`otherMb`: worker
 * threads, Chromium, native code). 0.8.49's 11.3 GB entry named only "Browser", with a 52 MB heap.
 */
function mainBreakdown(memoryUsage) {
  try {
    const usage = memoryUsage();
    const mb = (bytes) => Math.round(Number(bytes) / MB) || 0;
    const rssMb = mb(usage.rss);
    const heapTotalMb = mb(usage.heapTotal);
    const externalMb = mb(usage.external);
    return { rssMb, heapUsedMb: mb(usage.heapUsed), heapTotalMb, externalMb, arrayBuffersMb: mb(usage.arrayBuffers),
      otherMb: Math.max(0, rssMb - heapTotalMb - externalMb) };
  } catch {
    return null;
  }
}

// A page's origin, or its scheme where it has none (file:, data:, about:): never its path, query
// or fragment, which can name a person, a chat or a token.
function originOf(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    return url.origin !== "null" ? url.origin : url.protocol;
  } catch {
    return null;
  }
}

/**
 * The pages a renderer process hosts, for an entry about it. `contents()` lists the app's pages
 * (webContents: getOSProcessId, getURL, isDestroyed) and `roleOf(page)` names a page's part of the
 * app. One page: `{ role, origin }`. Several (Chromium shares a process between pages of one site
 * and session): `{ pages, roles: { role: count }, origins }`. No page in the process (the GPU or a
 * utility process): {}. Reads nothing but what each page already knows; never throws.
 */
function describeRenderer(pid, { contents, roleOf }) {
  try {
    const pages = [];
    for (const page of contents?.() ?? []) {
      try {
        if (page.isDestroyed?.() || page.getOSProcessId() !== pid) continue;
        let role = null;
        try { role = roleOf?.(page); } catch { /* unnamed, below */ }
        pages.push({ role: typeof role === "string" && role ? role.slice(0, 40) : "page", origin: originOf(page.getURL()) });
      } catch { /* a page closing while it is read */ }
    }
    if (pages.length === 1) return pages[0].origin ? pages[0] : { role: pages[0].role };
    if (!pages.length) return {};
    const roles = {};
    for (const { role } of pages) roles[role] = (roles[role] ?? 0) + 1;
    const origins = [...new Set(pages.map((page) => page.origin).filter(Boolean))].slice(0, 5);
    return { pages: pages.length, roles, ...(origins.length ? { origins } : {}) };
  } catch {
    return {};
  }
}

// What `describe` may not overwrite in an entry, and how much of it is kept.
const ENTRY_FIELDS = new Set(["kind", "pid", "fromMb", "toMb", "minutes", "mb", "totalMb", "main"]);
const MAX_DESCRIBED_FIELDS = 6;

/** The app's processes as `{ pid, kind, mb }`: Electron's (getAppMetrics, working set in KB) and the main process's JS heap. */
function readProcesses({ appMetrics, memoryUsage = () => process.memoryUsage() }) {
  const processes = [];
  for (const metric of appMetrics?.() ?? []) {
    const kb = Number(metric?.memory?.workingSetSize);
    if (!Number.isFinite(kb) || !Number.isInteger(metric?.pid)) continue;
    processes.push({ pid: metric.pid, kind: String(metric.name || metric.serviceName || metric.type || "process").slice(0, 60), mb: kb / 1024 });
  }
  const heap = Number(memoryUsage()?.heapUsed);
  if (Number.isFinite(heap)) processes.push({ pid: process.pid, kind: "Main JS heap", mb: heap / MB, heap: true });
  return processes;
}

function createMemoryWatch({ appMetrics, memoryUsage = () => process.memoryUsage(), logger, notify, now = () => Date.now(),
  sampleMs = SAMPLE_MS, maxSamples = MAX_SAMPLES, highMb = HIGH_MB, repeatMs = REPEAT_MS, notifyAgainMs = NOTIFY_AGAIN_MS,
  highLogMs = HIGH_LOG_MS, mainPid = process.pid, describe = null,
  setRepeat = setInterval, clearRepeat = clearInterval, thresholds = {} } = {}) {
  const histories = new Map(); // `${kind}:${pid}` -> { kind, pid, samples: [{ at, mb }] }
  const logged = new Map();
  let notifiedAt = null;
  let highLoggedAt = null;
  let timer = null;
  // What another process hosts, by `describe` (only when an entry is written): a plain object's
  // first few fields, none of the entry's own. A missing, failing or odd describe adds nothing.
  const described = (pid) => {
    if (typeof describe !== "function") return {};
    try {
      const fields = describe(pid);
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
      return Object.fromEntries(Object.entries(fields).filter(([key]) => !ENTRY_FIELDS.has(key)).slice(0, MAX_DESCRIBED_FIELDS));
    } catch {
      return {};
    }
  };
  // An entry about the main process says where in it the memory is; one about another, what it hosts.
  const where = (pid) => (pid === mainPid ? { main: mainBreakdown(memoryUsage) } : described(pid));

  const sample = () => {
    const at = now();
    let processes;
    try {
      processes = readProcesses({ appMetrics, memoryUsage });
    } catch (error) {
      logger?.warn?.("launcher.memory_sample_failed", { message: error instanceof Error ? error.message : String(error) });
      return [];
    }
    const seen = new Set();
    const findings = [];
    for (const entry of processes) {
      const key = `${entry.kind}:${entry.pid}`;
      seen.add(key);
      const history = histories.get(key) ?? { kind: entry.kind, pid: entry.pid, heap: Boolean(entry.heap), samples: [] };
      history.samples.push({ at, mb: entry.mb });
      if (history.samples.length > maxSamples) history.samples.splice(0, history.samples.length - maxSamples);
      histories.set(key, history);
      const grew = growth(history.samples, thresholds);
      if (grew && (!logged.has(key) || at - logged.get(key) >= repeatMs)) {
        logged.set(key, at);
        findings.push({ kind: entry.kind, pid: entry.pid, ...grew });
        logger?.warn?.("launcher.memory_growth", { kind: entry.kind, pid: entry.pid, ...grew, ...(entry.heap ? {} : where(entry.pid)) });
      }
    }
    // A process that is gone takes its history with it.
    for (const key of histories.keys()) if (!seen.has(key)) { histories.delete(key); logged.delete(key); }
    const total = processes.filter((entry) => !entry.heap).reduce((sum, entry) => sum + entry.mb, 0);
    const largest = processes.filter((entry) => !entry.heap).sort((a, b) => b.mb - a.mb)[0];
    // (null > n is `0 > n`: true for the negative times a fresh clock gives, so the first is checked apart.)
    // Logged every highLogMs while it lasts, so the log shows how it grew; told once per notifyAgainMs.
    if (largest && largest.mb >= highMb && (highLoggedAt === null || at - highLoggedAt >= highLogMs)) {
      highLoggedAt = at;
      logger?.warn?.("launcher.memory_high", { kind: largest.kind, pid: largest.pid, mb: Math.round(largest.mb), totalMb: Math.round(total), ...where(largest.pid) });
    }
    if (largest && largest.mb >= highMb && (notifiedAt === null || at - notifiedAt >= notifyAgainMs)) {
      notifiedAt = at;
      try {
        notify?.({ title: "Coding Tools is using a lot of memory",
          body: `${largest.kind} uses ${(largest.mb / 1024).toFixed(1)} GB (the app ${(total / 1024).toFixed(1)} GB). Closing finished chats or restarting the app frees it.` });
      } catch { /* notifications are best effort */ }
    }
    return findings;
  };

  return {
    start() {
      if (timer) return;
      sample();
      timer = setRepeat(sample, sampleMs);
      timer?.unref?.();
    },
    stop() {
      if (timer) clearRepeat(timer);
      timer = null;
    },
    sample,
    /** Each process's latest and earliest kept sample, for diagnostics. */
    status: () => [...histories.values()].map((history) => ({
      kind: history.kind, pid: history.pid, samples: history.samples.length,
      firstMb: Math.round(history.samples[0]?.mb ?? 0), lastMb: Math.round(history.samples.at(-1)?.mb ?? 0),
    })),
  };
}

module.exports = { createMemoryWatch, describeRenderer, growth, readProcesses, SAMPLE_MS };
