"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

/**
 * Gives back the space of an AO database that is mostly empty pages. AO's janitors delete old
 * streaming chunks, but SQLite only reuses freed pages, never returns them: ao.db stayed at 1.4 GB
 * with 73% of it empty (about 1 GB). The launcher calls this just before it starts the daemon, while
 * nothing else has the database open; a database in use (another daemon, a stray process) fails to
 * lock within a moment, and AO starts as before.
 *
 * The first time, a mostly empty database is rewritten once (VACUUM) and switched to incremental
 * auto-vacuum; after that a start frees what accumulated, at most incrementalMaxBytes of it
 * (incremental_vacuum(N)), so a start never waits on a large rewrite. VACUUM is
 * synchronous and takes tens of seconds on a hard disk, so it runs in a separate process.
 */
const DEFAULTS = Object.freeze({
  // A full rewrite only for a file that is at least this much, and at least half, empty.
  minFreeBytes: 256 * 1024 * 1024,
  minFreeRatio: 0.5,
  // The rewrite is built in memory (no temp file on the system drive); larger data is left alone.
  maxUsedBytes: 1024 * 1024 * 1024,
  // Once incremental, free pages are given back when at least this much has accumulated.
  incrementalMinBytes: 64 * 1024 * 1024,
  // ...and at most this much per start. AO waits for it, and an uncapped incremental_vacuum moved
  // 443 MB through the write-ahead log at under 1 MB/s on a busy hard disk: AO stayed down for
  // over ten minutes and the disk froze the app. Free pages are reused anyway; the rest of the
  // space comes back over the next starts.
  incrementalMaxBytes: 32 * 1024 * 1024,
  // AO starts only after this; past the limit the maintenance is stopped and AO starts without it.
  timeoutMs: 90_000,
});

// Runs in its own process: its input in AO_DB_MAINTENANCE_INPUT, its result one JSON line on stdout.
const SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const report = (result) => process.stdout.write(JSON.stringify(result) + "\\n");
(() => {
  const { file, minFreeBytes, minFreeRatio, maxUsedBytes, incrementalMinBytes, incrementalMaxBytes, diskFreeBytes } = JSON.parse(process.env.AO_DB_MAINTENANCE_INPUT);
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
      if (freeBytes >= incrementalMinBytes) {
        db.exec("PRAGMA incremental_vacuum(" + Math.max(1, Math.floor(incrementalMaxBytes / pageSize)) + ")");
        action = "incremental";
      }
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
    report({ action, ...(reason ? { reason } : {}), beforeBytes, afterBytes: fs.statSync(file).size, freeBytes, usedBytes, ms: Date.now() - started });
  } catch (error) {
    try { db?.close(); } catch {}
    report({ action: "failed", error: String(error?.message || error).slice(0, 300) });
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
  const input = JSON.stringify({ file, diskFreeBytes, minFreeBytes: settings.minFreeBytes, minFreeRatio: settings.minFreeRatio,
    maxUsedBytes: settings.maxUsedBytes, incrementalMinBytes: settings.incrementalMinBytes, incrementalMaxBytes: settings.incrementalMaxBytes });
  return new Promise((resolve) => {
    let settled = false, timer = null, timedOut = null, output = "";
    const done = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    let child;
    try {
      // In its own process, not a worker thread: AO starts only once this is done, and a run that
      // never finished kept AO from starting at all (seen 2026-10-22: "starting" for over 10 minutes
      // after an update, every chat stuck in "checking"). A worker cannot be stopped inside a native
      // SQLite call such as VACUUM, so it went on holding the write lock after giving up on it; a
      // killed process lets go of its locks, and SQLite drops the unfinished rewrite. In Electron the
      // app's own executable runs as plain Node. scriptSource: tests only.
      child = spawn(process.execPath, ["-e", settings.scriptSource ?? SCRIPT], {
        windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AO_DB_MAINTENANCE_INPUT: input },
      });
    } catch (error) {
      done({ action: "failed", error: String(error?.message || error).slice(0, 300) });
      return;
    }
    child.stdout.on("data", (chunk) => { output = (output + chunk.toString()).slice(-4096); });
    child.once("error", (error) => done({ action: "failed", error: String(error?.message || error).slice(0, 300) }));
    child.once("exit", () => {
      // Past the limit, AO starts only once the process is gone and its locks with it.
      if (timedOut) { done(timedOut); return; }
      const line = output.trim().split("\n").pop();
      try { done(JSON.parse(line)); } catch { done({ action: "failed", error: "the maintenance process stopped" }); }
    });
    timer = setTimeout(() => {
      timedOut = { action: "failed", error: `timed out after ${Math.round(settings.timeoutMs / 1000)} s; AO starts without it` };
      child.kill();
    }, settings.timeoutMs);
    timer.unref?.();
  });
}

module.exports = { compactAoDatabase, AO_DB_MAINTENANCE_DEFAULTS: DEFAULTS };
