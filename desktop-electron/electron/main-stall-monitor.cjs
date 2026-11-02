"use strict";

// Logs when the main process's event loop was blocked. While it is, every window freezes and
// every IPC call waits, and nothing else can say so: the renderer watchdog's events come from
// this same loop. A short timer that fires late measures the block after the fact.
//
// cpuMs is the main process's own CPU time during the late gap. About as much CPU as the gap
// means our own JavaScript ran the whole time (a big parse, a sync loop); little CPU means it was
// waiting (synchronous disk I/O on the overloaded drive, or a machine-wide stall).

const TICK_MS = 500;
// A UI that is frozen for 2 s is noticeable; shorter late ticks are ordinary scheduling noise.
const STALL_MS = 2_000;

function createMainStallMonitor({ logger, tickMs = TICK_MS, stallMs = STALL_MS, now = () => performance.now(),
  cpuUsage = () => process.cpuUsage(), memoryUsage = () => process.memoryUsage(),
  setRepeat = setInterval, clearRepeat = clearInterval, blockingCalls = null, clock = () => Date.now(),
  probe = null } = {}) {
  let timer = null;
  let last = 0;
  let lastCpu = null;
  const tick = () => {
    probe?.beat();
    const at = now();
    const cpu = cpuUsage();
    const lateMs = at - last - tickMs;
    if (lateMs >= stallMs) {
      const cpuMs = Math.round(((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / 1000);
      // The synchronous call that held main during the gap, when one did (main-blocking-calls.cjs);
      // none with little CPU means main waited elsewhere, or the whole machine stalled.
      const blockedBy = blockingCalls?.latestSince(clock() - lateMs - tickMs) ?? null;
      logger?.warn?.("launcher.main_stalled", {
        ms: Math.round(lateMs),
        cpuMs,
        heapMb: Math.round(memoryUsage().heapUsed / 1_048_576),
        ...(blockedBy ? { blockedBy } : {}),
      });
    }
    last = at;
    lastCpu = cpu;
  };
  return {
    start() {
      if (timer) return;
      last = now();
      lastCpu = cpuUsage();
      timer = setRepeat(tick, tickMs);
      timer?.unref?.();
    },
    stop() {
      if (timer) clearRepeat(timer);
      timer = null;
    },
    tick,
  };
}

// Names what held main when no wrapped synchronous call did (main-blocking-calls.cjs). A 61 s
// stall on 0.8.48 (2026-11-01 20:11, 187 ms of CPU) had no blockedBy, and probes never caught one
// live. A worker watches a counter main's tick raises; after PROBE_AFTER_MS without a rise it asks
// main, through the inspector, to pause. Main serves that request at its first function call after
// the blocking call returns, which is nearly always inside the code that made it (it uses the
// result); those frames are logged as launcher.main_stall_caller, and main resumes at once. A stack
// with none of our code means main was held outside JavaScript, or the caller returned without
// another call. The debugger is enabled only for that pause.
const PROBE_AFTER_MS = 4_000;
const PROBE_POLL_MS = 500;
const PROBE_FRAMES = 6;

const PROBE_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const inspector = require("node:inspector");
const { beat, probeAfterMs, pollMs, frameCount } = workerData;
const counter = new Int32Array(beat);
let seen = Atomics.load(counter, 0);
let changedAt = Date.now();
let probing = false;
let probedThisHold = false;
let session = null;
const timer = setInterval(() => {
  const value = Atomics.load(counter, 0);
  if (value !== seen) { seen = value; changedAt = Date.now(); probedThisHold = false; return; }
  if (probing || probedThisHold || Date.now() - changedAt < probeAfterMs) return;
  probedThisHold = true;
  probe(changedAt);
}, pollMs);
// CallFrame.url is deprecated and empty in current V8: a frame's file comes from the scriptParsed
// events Debugger.enable replays for every loaded script, kept only while a probe runs.
const scripts = new Map();
const frameUrl = (frame) => frame.url || scripts.get(frame.location.scriptId) || "";
function shortFrame(frame) {
  const file = frameUrl(frame).split(/[\\\\/]/).pop() || "(script)";
  return (frame.functionName || "(anonymous)") + " " + file + ":" + (frame.location.lineNumber + 1);
}
function probe(heldSince) {
  if (!session) {
    try {
      session = new inspector.Session();
      session.connectToMainThread();
    } catch (error) {
      clearInterval(timer);
      parentPort.postMessage({ unavailable: String(error && error.message || error) });
      return;
    }
    session.on("Debugger.scriptParsed", ({ params }) => { if (params.url) scripts.set(params.scriptId, params.url); });
    session.on("Debugger.paused", ({ params }) => {
      const frames = params.callFrames;
      // Node's own frames are noise; a script with no url (eval, -e) is still code that waited.
      const ours = frames.filter(frame => !frameUrl(frame).startsWith("node:"));
      const report = {
        heldMs: Date.now() - heldSince,
        frames: ours.slice(0, frameCount).map(shortFrame),
        top: frames.length ? shortFrame(frames[0]) : null,
      };
      session.post("Debugger.resume", () => session.post("Debugger.disable", () => {
        scripts.clear();
        probing = false;
        parentPort.postMessage(report);
      }));
    });
  }
  probing = true;
  // Both are sent at once: main serves them together when it runs again, so the pause lands at its
  // next statement. Waiting for enable's answer first let main leave the waiting code before it.
  session.post("Debugger.enable");
  session.post("Debugger.pause", (error) => {
    if (error) session.post("Debugger.disable", () => { probing = false; });
  });
}
`;

function createMainStallProbe({
  logger,
  probeAfterMs = PROBE_AFTER_MS,
  pollMs = PROBE_POLL_MS,
  frameCount = PROBE_FRAMES,
  createWorker = (source, options) => new (require("node:worker_threads").Worker)(source, options),
} = {}) {
  const beat = new SharedArrayBuffer(4);
  const counter = new Int32Array(beat);
  let worker = null;
  return {
    beat() { Atomics.add(counter, 0, 1); },
    start() {
      if (worker) return;
      try {
        worker = createWorker(PROBE_WORKER_SOURCE, { eval: true, workerData: { beat, probeAfterMs, pollMs, frameCount } });
      } catch (error) {
        logger?.info?.("launcher.main_stall_probe_unavailable", { message: String(error?.message ?? error) });
        return;
      }
      worker.on("message", (message) => {
        if (message?.unavailable) logger?.info?.("launcher.main_stall_probe_unavailable", { message: message.unavailable });
        else if (message) logger?.warn?.("launcher.main_stall_caller", message);
      });
      // The probe never keeps the app running, and a probe that fails is only a missing diagnostic.
      worker.on("error", (error) => logger?.info?.("launcher.main_stall_probe_unavailable", { message: String(error?.message ?? error) }));
      worker.unref?.();
    },
    stop() {
      const stopping = worker;
      worker = null;
      return stopping?.terminate?.();
    },
  };
}

module.exports = { createMainStallMonitor, createMainStallProbe, PROBE_AFTER_MS, STALL_MS, TICK_MS };
