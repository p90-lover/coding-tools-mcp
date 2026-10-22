"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

/**
 * Gives back the space of an AO database that is mostly empty pages. AO's janitors delete old
 * streaming chunks, but SQLite only reuses freed pages, never returns them: ao.db stayed at 1.4 GB
 * with 73% of it empty (about 1 GB). The launcher calls this just before it starts the daemon, while
 * nothing else has the database open; a database in use (another daemon, a stray process) fails to
 * lock within a moment, and AO starts as before.
 *
 * The first time, a mostly empty database is rewritten once (VACUUM) and switched to incremental
 * auto-vacuum; after that a start only frees what accumulated (incremental_vacuum). VACUUM is
 * synchronous and takes tens of seconds on a hard disk, so it runs in a worker thread.
 */
const DEFAULTS = Object.freeze({
  // A full rewrite only for a file that is at least this much, and at least half, empty.
  minFreeBytes: 256 * 1024 * 1024,
  minFreeRatio: 0.5,
  // The rewrite is built in memory (no temp file on the system drive); larger data is left alone.
  maxUsedBytes: 1024 * 1024 * 1024,
  // Once incremental, free pages are given back when at least this much has accumulated.
  incrementalMinBytes: 64 * 1024 * 1024,
  // AO starts only after this; past the limit the worker is stopped and AO starts without it.
  timeoutMs: 90_000,
});

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
(() => {
  const { file, minFreeBytes, minFreeRatio, maxUsedBytes, incrementalMinBytes, diskFreeBytes } = workerData;
  let db = null;
  try {
    db = new DatabaseSync(file, { timeout: 2000 });
    const one = (sql) => Number(Object.values(db.prepare(sql).get() ?? {})[0]);
    const pageSize = one("PRAGMA page_size"), pages = one("PRAGMA page_count"), free = one("PRAGMA freelist_count");
    const mode = one("PRAGMA auto_vacuum");
    const freeBytes = free * pageSize, usedBytes = (pages - free) * pageSize;
    const beforeBytes = fs.statSync(file).size, started = Date.now();
    let action = "none", reason = "";
    if (mode === 2) {
      if (freeBytes >= incrementalMinBytes) { db.exec("PRAGMA incremental_vacuum"); action = "incremental"; }
    } else if (mode === 0 && freeBytes >= minFreeBytes && pages && free / pages >= minFreeRatio) {
      // The write-ahead log takes about the data's size again while the copy is written back.
      if (usedBytes > maxUsedBytes) reason = "too much data to rewrite at start";
      else if (diskFreeBytes !== null && diskFreeBytes < usedBytes * 2) reason = "not enough free disk space";
      else {
        db.exec("PRAGMA temp_store = MEMORY");
        db.exec("PRAGMA auto_vacuum = INCREMENTAL");
        db.exec("VACUUM");
        action = "vacuum";
      }
    }
    if (action !== "none") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    db = null;
    parentPort.postMessage({ action, ...(reason ? { reason } : {}), beforeBytes, afterBytes: fs.statSync(file).size, freeBytes, usedBytes, ms: Date.now() - started });
  } catch (error) {
    try { db?.close(); } catch {}
    parentPort.postMessage({ action: "failed", error: String(error?.message || error).slice(0, 300) });
  }
})();
`;

/** Compacts `<dataRoot>/ao.db` if it is worth it; resolves to what was done, never rejects. */
function compactAoDatabase(dataRoot, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const file = path.join(dataRoot, "ao.db");
  if (!fs.existsSync(file)) return Promise.resolve({ action: "none", reason: "no database yet" });
  let diskFreeBytes = null;
  try { const stats = fs.statfsSync(dataRoot); diskFreeBytes = Number(stats.bavail) * Number(stats.bsize); } catch { /* unknown */ }
  return new Promise((resolve) => {
    let settled = false, timer = null;
    const done = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    let worker;
    try {
      // workerSource: tests only.
      worker = new Worker(settings.workerSource ?? WORKER, { eval: true, workerData: { file, diskFreeBytes, minFreeBytes: settings.minFreeBytes, minFreeRatio: settings.minFreeRatio,
        maxUsedBytes: settings.maxUsedBytes, incrementalMinBytes: settings.incrementalMinBytes } });
    } catch (error) {
      done({ action: "failed", error: String(error?.message || error).slice(0, 300) });
      return;
    }
    // AO starts only once this is done. A run that never finished kept AO from starting at all
    // (seen 2026-10-22: "starting" for over 10 minutes after an update, the app idle, every chat
    // stuck in "checking" and no steer reaching its agent). Past the limit the worker is stopped,
    // which leaves an unfinished rewrite uncommitted, and AO starts without it.
    timer = setTimeout(() => {
      done({ action: "failed", error: `timed out after ${Math.round(settings.timeoutMs / 1000)} s; AO starts without it` });
      void worker.terminate().catch(() => {});
    }, settings.timeoutMs);
    timer.unref?.();
    worker.once("message", done);
    worker.once("error", (error) => done({ action: "failed", error: String(error?.message || error).slice(0, 300) }));
    worker.once("exit", () => done({ action: "failed", error: "the maintenance worker stopped" }));
  });
}

module.exports = { compactAoDatabase, AO_DB_MAINTENANCE_DEFAULTS: DEFAULTS };
