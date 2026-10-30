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

const SAMPLE_MS = 5 * 60_000;
const MAX_SAMPLES = 36; // three hours
const WINDOW_MS = 60 * 60_000;
const GROWTH_MB = 300;
const GROWTH_RATIO = 1.5;
const HIGH_MB = 3_000;
const REPEAT_MS = 2 * 60 * 60_000;
const NOTIFY_AGAIN_MS = 12 * 60 * 60_000;
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

function createMemoryWatch({ appMetrics, memoryUsage, logger, notify, now = () => Date.now(),
  sampleMs = SAMPLE_MS, maxSamples = MAX_SAMPLES, highMb = HIGH_MB, repeatMs = REPEAT_MS, notifyAgainMs = NOTIFY_AGAIN_MS,
  setRepeat = setInterval, clearRepeat = clearInterval, thresholds = {} } = {}) {
  const histories = new Map(); // `${kind}:${pid}` -> { kind, pid, samples: [{ at, mb }] }
  const logged = new Map();
  let notifiedAt = null;
  let timer = null;

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
        logger?.warn?.("launcher.memory_growth", { kind: entry.kind, pid: entry.pid, ...grew });
      }
    }
    // A process that is gone takes its history with it.
    for (const key of histories.keys()) if (!seen.has(key)) { histories.delete(key); logged.delete(key); }
    const total = processes.filter((entry) => !entry.heap).reduce((sum, entry) => sum + entry.mb, 0);
    const largest = processes.filter((entry) => !entry.heap).sort((a, b) => b.mb - a.mb)[0];
    // (null > n is `0 > n`: true for the negative times a fresh clock gives, so the first is checked apart.)
    if (largest && largest.mb >= highMb && (notifiedAt === null || at - notifiedAt >= notifyAgainMs)) {
      notifiedAt = at;
      logger?.warn?.("launcher.memory_high", { kind: largest.kind, pid: largest.pid, mb: Math.round(largest.mb), totalMb: Math.round(total) });
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

module.exports = { createMemoryWatch, growth, readProcesses, SAMPLE_MS };
