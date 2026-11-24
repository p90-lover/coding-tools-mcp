"use strict";

// The local auto-review plugin (G:\Projects\auto-review-plugin) running in a worker thread of the
// main process (auto-review-host.cjs). The plugin's own work is ~50 µs a decision, but it saves its
// state with synchronous writes (a debounced flush every 5 s) and runs a background learning pass of
// up to 250 ms: here neither ever holds the Electron main thread, where a synchronous write on the
// busy hard disk froze every window before (chat preferences, 2026-11-09).
//
// Only the calls an agent's review needs and the read-only stats are served. The plugin's admin
// calls (editBlocklist, editRule, reset, setEnabled) are never reachable from here: they are the
// person's, in the plugin's own settings.

const { parentPort, workerData } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");

const SERVED = new Set(["review", "answerQuestion", "recordOutcome", "recordOverride", "getStats", "setHostState"]);
const STATS_DEBOUNCE_MS = Number.isFinite(workerData?.statsDebounceMs) ? workerData.statsDebounceMs : 1000;

async function start() {
  let reviewer;
  try {
    const plugin = await import(pathToFileURL(workerData.entry).href);
    reviewer = new plugin.AutoReview(workerData.dataDir ? { dataDir: workerData.dataDir } : {});
    // Embedded, the plugin's "idle priority during a background pass" would lower the whole app
    // (its main process and every window it serves), not just the plugin (its DECISIONS.md 24).
    // Set on the running scheduler rather than passed as config, which the plugin saves into the
    // config.json it shares with the other apps that use it.
    if (reviewer.scheduler?.opts) reviewer.scheduler.opts.lowerPriority = false;
  } catch (error) {
    parentPort.postMessage({ type: "failed", message: String(error?.message || error).slice(0, 500) });
    return;
  }
  // The plugin's stats event fires on every decision; the app hears at most one summary a second.
  let statsTimer = null;
  reviewer.on("stats", () => {
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      try { parentPort.postMessage({ type: "stats", stats: reviewer.getStats() }); } catch { /* the next decision tries again */ }
    }, STATS_DEBOUNCE_MS);
  });
  reviewer.on("error", () => { /* a failed save keeps the old files; the next flush tries again */ });
  parentPort.on("message", (message) => {
    if (message?.type === "close") {
      try { reviewer.close(); } catch { /* exiting anyway */ }
      parentPort.postMessage({ type: "closed" });
      return;
    }
    const { id, method, input } = message ?? {};
    if (!SERVED.has(method)) {
      parentPort.postMessage({ type: "reply", id, error: "not served" });
      return;
    }
    try {
      const result = method === "getStats" ? reviewer.getStats() : reviewer[method](input);
      parentPort.postMessage({ type: "reply", id, result });
    } catch (error) {
      parentPort.postMessage({ type: "reply", id, error: String(error?.message || error).slice(0, 500) });
    }
  });
  parentPort.postMessage({ type: "ready", stats: reviewer.getStats() });
}

void start();
