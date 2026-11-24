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

  // Package-manager, build and model caches the agents' commands fill. Each defaults to the
  // profile on the system drive; started empty under the data root they only cost a re-download.
  for (const [name, folder] of Object.entries(CACHE_VARIABLES)) {
    if (onSystem(env[name])) result.env[name] = path.win32.join(dataRoot, "cache", folder);
  }
  if (result.tempDir && onSystem(env.GOTMPDIR)) result.env.GOTMPDIR = result.tempDir;
  return result;
}

/**
 * Cache variables moved off the system drive, and the folder each gets under `<data root>\cache`.
 * Left out on purpose: PLAYWRIGHT_BROWSERS_PATH and CARGO_HOME (installed programs, not caches),
 * CODEX_HOME and CLAUDE_CONFIG_DIR (sign-ins and history; moving them is the person's call).
 */
const CACHE_VARIABLES = Object.freeze({
  npm_config_cache: "npm",
  PIP_CACHE_DIR: "pip",
  UV_CACHE_DIR: "uv",
  BUN_INSTALL_CACHE_DIR: "bun",
  YARN_CACHE_FOLDER: "yarn",
  GOCACHE: "go-build",
  GOMODCACHE: "go-mod",
  HF_HOME: "huggingface",
  XDG_CACHE_HOME: "xdg",
});

const systemDriveOf = (env) => driveOf(env.SystemDrive ?? env.SYSTEMDRIVE) || "C";

/**
 * The drive a path really lands on. The nearest folder that exists is resolved through junctions
 * and links first, so `C:\Users\a\.ao` linked to `G:\AppData\.ao` counts as G:. A UNC path is "".
 */
function physicalDriveOf(target, { realpath = fs.realpathSync.native } = {}) {
  let current = path.win32.resolve(String(target));
  for (;;) {
    try { return driveOf(realpath(current)); } catch { /* not there yet, or unreadable */ }
    const parent = path.win32.dirname(current);
    if (parent === current) return driveOf(current);
    current = parent;
  }
}

class SystemDriveWriteError extends Error {
  constructor(target) {
    super(`Coding Tools does not write to the system drive: ${target}`);
    this.name = "SystemDriveWriteError";
    this.code = "SYSTEM_DRIVE_WRITE";
    this.target = target;
  }
}

/**
 * Where a write meant for `target` goes: `target` itself when it really lands off the system drive,
 * otherwise `fallback` (a folder under the data root) when that is off it. With neither, it throws
 * SystemDriveWriteError: refusing beats a silent write to the system drive. Off Windows it is a no-op.
 */
function guardWritePath(target, { env = process.env, fallback, platform = process.platform, realpath, exists } = {}) {
  if (platform !== "win32") return target;
  const system = systemDriveOf(env);
  if (physicalDriveOf(target, { realpath }) !== system) return target;
  if (fallback && physicalDriveOf(fallback, { realpath }) !== system) return fallback;
  if (systemDriveAllowed({ env, exists })) return target;
  throw new SystemDriveWriteError(target);
}

/** The opt-outs: the person's CODING_TOOLS_ALLOW_SYSTEM_DRIVE=1, CI runners, or a PC with no other drive. */
function systemDriveAllowed({ env = process.env, exists } = {}) {
  return env.CODING_TOOLS_ALLOW_SYSTEM_DRIVE === "1" || env.GITHUB_ACTIONS === "true" || otherDrives({ env, exists }).length === 0;
}

/** Drive letters D..Z other than the system one that exist here (A:/B: are skipped: floppy probes stall). */
function otherDrives({ env = process.env, exists = fs.existsSync } = {}) {
  const system = systemDriveOf(env);
  const found = [];
  for (let code = 68; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    if (letter !== system && exists(`${letter}:\\`)) found.push(letter);
  }
  return found;
}

/**
 * The startup check on the data root, everything else's parent. It refuses (ok: false) when the root
 * really lands on the system drive while another drive exists to hold it. A PC with only a system
 * drive keeps working with a warning; CODING_TOOLS_ALLOW_SYSTEM_DRIVE=1 and CI runners opt out.
 */
function checkDataRoot(dataRoot, { env = process.env, platform = process.platform, realpath, exists } = {}) {
  if (platform !== "win32" || typeof dataRoot !== "string" || !path.win32.isAbsolute(dataRoot)) return { ok: true };
  if (physicalDriveOf(dataRoot, { realpath }) !== systemDriveOf(env)) return { ok: true };
  if (systemDriveAllowed({ env, exists })) {
    return { ok: true, warning: `Coding Tools' data is on the system drive (${dataRoot}).` };
  }
  const drives = otherDrives({ env, exists });
  return {
    ok: false,
    drives,
    message: `Coding Tools keeps its data off the system drive, but its data folder is ${dataRoot}.\n\n`
      + `Set CODING_TOOLS_LAUNCHER_DATA_DIR to a folder on ${drives.map((d) => `${d}:`).join(" or ")} and start it again. `
      + "On a PC that must use the system drive, set CODING_TOOLS_ALLOW_SYSTEM_DRIVE=1.",
  };
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

module.exports = {
  driveOf, systemDriveRedirects, pruneTemp, DAY_MS,
  CACHE_VARIABLES, physicalDriveOf, guardWritePath, SystemDriveWriteError, otherDrives, systemDriveAllowed, checkDataRoot,
};
