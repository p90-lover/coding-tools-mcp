"use strict";

/**
 * The local auto-review plugin (G:\Projects\auto-review-plugin, its README and DECISIONS.md) for
 * "Approve for me": a reviewer with no model and no quota that approves or declines an agent's
 * shell command from fixed rules and what it learned from earlier outcomes and the person's own
 * answers, and answers routine agent questions.
 *
 * In-process, not its MCP stdio server: the plugin is plain TypeScript the main process's Node can
 * load (type stripping), about 50 µs a decision, so a child process and a JSON-RPC client would only
 * add a process and a failure mode. It runs in a worker thread (auto-review-worker.cjs), not on the
 * main thread itself: the plugin saves with synchronous writes and learns in passes of up to 250 ms,
 * and neither may hold the windows.
 *
 * Missing plugin (CODING_TOOLS_AUTO_REVIEW_PATH, default G:\Projects\auto-review-plugin), a plugin
 * that fails to load, crashes or does not answer within callTimeoutMs: every call answers null and
 * the app behaves exactly as without it. Only the review calls and read-only stats are offered; the
 * plugin's admin calls (blocklist, rules, reset, its own off switch) are never reachable from here.
 */

const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

const DEFAULT_PLUGIN_PATH = "G:\\Projects\\auto-review-plugin";
const CALL_TIMEOUT_MS = 2_000;
const RESTART_DELAY_MS = 60_000;

function createAutoReviewHost({
  pluginPath = process.env.CODING_TOOLS_AUTO_REVIEW_PATH || DEFAULT_PLUGIN_PATH,
  dataDir = undefined,
  logger = null,
  WorkerImpl = Worker,
  callTimeoutMs = CALL_TIMEOUT_MS,
  restartDelayMs = RESTART_DELAY_MS,
  statsDebounceMs = 1_000,
  now = Date.now,
} = {}) {
  const entry = path.join(pluginPath, "src", "index.ts");
  let worker = null;
  let ready = null; // Promise<boolean> while starting or started
  let failedAt = -Infinity;
  let closed = false;
  let nextId = 1;
  let latest = null;
  const waiting = new Map(); // id -> { resolve, timer }
  const listeners = new Set();

  // Both asynchronous: this module runs on Electron main, where a synchronous stat or read holds
  // every window (tests/main-sync-calls.test.cjs).
  const present = () => fs.promises.stat(entry).then((stat) => stat.isFile(), () => false);
  let workerSource = null; // Promise<string>, read once
  const readWorkerSource = () => {
    workerSource ??= fs.promises.readFile(path.join(__dirname, "auto-review-worker.cjs"), "utf8")
      .catch((error) => { workerSource = null; throw error; });
    return workerSource;
  };
  function settleAll() {
    for (const [id, call] of waiting) { clearTimeout(call.timer); call.resolve(null); waiting.delete(id); }
  }
  function publish(stats) {
    latest = stats;
    for (const listener of listeners) {
      try { listener(stats); } catch { /* one listener never stops the others */ }
    }
  }
  function fail(reason) {
    failedAt = now();
    logger?.warn?.("auto_review.unavailable", { reason: String(reason).slice(0, 300) });
    const was = worker;
    worker = null;
    ready = null;
    settleAll();
    if (was) void Promise.resolve().then(() => was.terminate?.()).catch(() => undefined);
  }
  function start() {
    if (closed || now() - failedAt < restartDelayMs) return Promise.resolve(false);
    if (ready) return ready;
    ready = new Promise((resolve) => void (async () => {
      let own;
      try {
        if (!await present() || closed) { ready = null; resolve(false); return; }
        // Started from its source text, as the app's other workers are (off-thread-run.cjs): a
        // worker cannot load a script file from inside the packaged app.asar.
        const source = await readWorkerSource();
        if (closed) { ready = null; resolve(false); return; }
        own = new WorkerImpl(source, { eval: true, workerData: { entry, dataDir, statsDebounceMs } });
      } catch (error) {
        fail(error?.message || error);
        resolve(false);
        return;
      }
      worker = own;
      // The plugin's timers are unref'd; the worker must not hold the app open either.
      own.unref?.();
      own.on("message", (message) => {
        if (own !== worker) return;
        if (message?.type === "ready") {
          publish(message.stats ?? null);
          resolve(true);
        } else if (message?.type === "failed") {
          fail(message.message);
          resolve(false);
        } else if (message?.type === "stats") {
          publish(message.stats ?? null);
        } else if (message?.type === "reply") {
          const call = waiting.get(message.id);
          if (!call) return;
          waiting.delete(message.id);
          clearTimeout(call.timer);
          if (message.error) logger?.warn?.("auto_review.call_failed", { reason: String(message.error).slice(0, 300) });
          call.resolve(message.error ? null : message.result ?? null);
        }
      });
      own.on("error", (error) => { if (own === worker) { fail(error?.message || error); resolve(false); } });
      own.on("exit", (code) => { if (own === worker) { fail(`the auto-review worker exited (${code})`); resolve(false); } });
    })());
    return ready;
  }
  /** One call to the plugin; null when it is absent, failed or slower than callTimeoutMs. */
  async function call(method, input) {
    if (!await start() || !worker) return null;
    const own = worker;
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        logger?.warn?.("auto_review.call_timeout", { method });
        resolve(null);
      }, callTimeoutMs);
      timer.unref?.();
      waiting.set(id, { resolve, timer });
      try { own.postMessage({ id, method, input }); } catch (error) {
        waiting.delete(id);
        clearTimeout(timer);
        fail(error?.message || error);
        resolve(null);
      }
    });
  }
  return {
    pluginPath,
    /** Resolves whether the plugin is installed where it is looked for (not whether it loaded yet). */
    available: async () => !closed && await present(),
    call,
    review: (input) => call("review", input),
    answerQuestion: (input) => call("answerQuestion", input),
    recordOutcome: (input) => call("recordOutcome", input),
    recordOverride: (input) => call("recordOverride", input),
    setHostState: (input) => call("setHostState", input),
    getStats: () => call("getStats"),
    /** The last stats the plugin sent (its stats event), without asking it again. */
    latestStats: () => latest,
    /** Called with the plugin's stats after its decisions change them (at most once a second). */
    onStats(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      const own = worker;
      worker = null;
      ready = null;
      settleAll();
      if (!own) return;
      // Saves what the plugin still holds (its 5 s debounced flush), then stops the thread.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
        own.on?.("message", (message) => { if (message?.type === "closed") { clearTimeout(timer); resolve(); } });
        own.on?.("exit", () => { clearTimeout(timer); resolve(); });
        try { own.postMessage({ type: "close" }); } catch { clearTimeout(timer); resolve(); }
      });
      await Promise.resolve(own.terminate?.()).catch(() => undefined);
    },
  };
}

module.exports = { createAutoReviewHost, DEFAULT_PLUGIN_PATH };
