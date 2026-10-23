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
  setRepeat = setInterval, clearRepeat = clearInterval } = {}) {
  let timer = null;
  let last = 0;
  let lastCpu = null;
  const tick = () => {
    const at = now();
    const cpu = cpuUsage();
    const lateMs = at - last - tickMs;
    if (lateMs >= stallMs) {
      const cpuMs = Math.round(((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / 1000);
      logger?.warn?.("launcher.main_stalled", {
        ms: Math.round(lateMs),
        cpuMs,
        heapMb: Math.round(memoryUsage().heapUsed / 1_048_576),
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

module.exports = { createMainStallMonitor, STALL_MS, TICK_MS };
