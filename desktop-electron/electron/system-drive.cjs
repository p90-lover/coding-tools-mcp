"use strict";

// Coding Tools keeps its writes off the system drive (on the machine it was built for, C: is the SSD
// and everything else lives on hard disks). Its data root already sits wherever the person put it,
// but two things it and everything it starts still wrote to C: through Windows' defaults:
// - the temporary folder (TEMP/TMP): the scratch files of every agent it runs (Claude Code's own
//   %TEMP%\claude, command output, package managers' downloads) and of Chromium's helpers. Codex's
//   Windows sandbox grants a sandboxed command the TEMP it inherits, so agents keep a writable one.
//   (The app's own updates never used it: they stage beside the install, app-update.cjs.)
// - rtk's history database (%LOCALAPPDATA%\rtk\history.db), written on every command an agent runs
//   through RTK's hook.
// systemDriveRedirects points both at the data root before anything is started, so every child
// (AO and its agents, CPA, the bridge, Chromium's helpers) inherits them. A value the
// person set off the system drive is kept, and nothing changes when the data root is itself on the
// system drive or off Windows. pruneTemp then clears old leftovers there, since Windows' Storage
// Sense only cleans the system temporary folder.

const fs = require("node:fs");
const path = require("node:path");

const DAY_MS = 24 * 60 * 60 * 1000;

/** The drive letter of an absolute Windows path ("G:\\x" -> "G"), or "" for anything else. */
function driveOf(value) {
  const match = /^([A-Za-z]):/.exec(String(value ?? "").trim());
  return match ? match[1].toUpperCase() : "";
}

/**
 * The variables to set so temporary files and rtk's history land under `dataRoot`, and the folders
 * they name. `env` is read, never changed. An unset variable counts as the system drive: Windows'
 * default for each is under the user's profile there.
 */
function systemDriveRedirects({ env = process.env, dataRoot, platform = process.platform } = {}) {
  const result = { env: {}, tempDir: null, rtkDir: null };
  if (platform !== "win32" || typeof dataRoot !== "string" || !path.win32.isAbsolute(dataRoot)) return result;
  const system = driveOf(env.SystemDrive ?? env.SYSTEMDRIVE) || "C";
  const data = driveOf(dataRoot);
  if (!data || data === system) return result;
  const onSystem = (value) => !String(value ?? "").trim() || driveOf(value) === system;

  const explicit = String(env.CODING_TOOLS_TEMP_DIR ?? "").trim();
  if (explicit && path.win32.isAbsolute(explicit)) result.tempDir = explicit;
  else if (onSystem(env.TEMP) || onSystem(env.TMP)) result.tempDir = path.win32.join(dataRoot, "tmp");
  if (result.tempDir) Object.assign(result.env, { TEMP: result.tempDir, TMP: result.tempDir, TMPDIR: result.tempDir });

  // rtk reads RTK_DB_PATH before its config and its default (tracking.rs, get_db_path).
  if (!String(env.RTK_DB_PATH ?? "").trim() && onSystem(env.LOCALAPPDATA)) {
    result.rtkDir = path.win32.join(dataRoot, "rtk");
    result.env.RTK_DB_PATH = path.win32.join(result.rtkDir, "history.db");
  }
  return result;
}

/** When a file was last written or made: an update's freshly extracted files keep old mtimes. */
const touchedAt = (stat) => Math.max(stat.mtimeMs, stat.birthtimeMs);

/** The newest `timeOf` under `entry`, or Infinity once more than `budget` entries were seen. */
async function newestUnder(entry, budget, timeOf) {
  let newest = 0;
  let seen = 0;
  const pending = [entry];
  while (pending.length) {
    const current = pending.pop();
    const stat = await fs.promises.lstat(current);
    newest = Math.max(newest, timeOf(stat));
    if (++seen > budget) return Infinity;
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    for (const name of await fs.promises.readdir(current)) pending.push(path.join(current, name));
  }
  return newest;
}

/**
 * Removes what in `dir` nothing has touched for `maxAgeMs`: a top-level file or folder goes only when
 * everything inside it is that old (a running agent's folder keeps its fresh files), links are never
 * followed or removed, and anything in use or unreadable is left for next time. Resolves to the
 * names removed.
 */
async function pruneTemp(dir, { maxAgeMs = 7 * DAY_MS, now = Date.now(), budget = 2000, maxEntries = 200, timeOf = touchedAt } = {}) {
  if (typeof dir !== "string" || !dir) return [];
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return []; }
  // A bounded pass on a busy hard disk, oldest entries first: the rest waits for the next start.
  const entries = [];
  for (const name of names) {
    try {
      const stat = await fs.promises.lstat(path.join(dir, name));
      if (!stat.isSymbolicLink() && now - timeOf(stat) >= maxAgeMs) entries.push({ name, at: timeOf(stat) });
    } catch { /* gone already */ }
  }
  entries.sort((left, right) => left.at - right.at);
  const removed = [];
  for (const { name } of entries.slice(0, maxEntries)) {
    const entry = path.join(dir, name);
    try {
      if (now - (await newestUnder(entry, budget, timeOf)) < maxAgeMs) continue;
      await fs.promises.rm(entry, { recursive: true, force: true });
      removed.push(name);
    } catch { /* in use, or gone already */ }
  }
  return removed;
}

module.exports = { driveOf, systemDriveRedirects, pruneTemp, DAY_MS };
