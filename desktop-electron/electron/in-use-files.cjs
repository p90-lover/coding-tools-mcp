"use strict";
// Agents keep running across an update. Each AO chat card runs in a detached chat host started
// from the installed ao-daemon.exe (and a Claude card in the packaged Node runtime), so those
// images are in use and the installer cannot overwrite them. Windows refuses to delete or rewrite
// a running image but does allow renaming it: the running agent keeps its mapped copy under the
// new name, and the installer writes the new version at the original path. Leftovers are deleted
// on a later start, once nothing runs them.
//
// An app update (app-update-worker.cjs) keeps its old copies under the same `.old-<stamp>` names,
// and its rollback puts them back. update.cjs copies this file on its own for the installer's
// worker, so it names the update's files here rather than requiring that module.
const fs = require("node:fs");
const path = require("node:path");

const IMAGE = /\.(exe|dll|node)$/i;
const SET_ASIDE = /\.old-\d+$/;
const APP_UPDATE_JOURNAL = path.join("_update", "journal.json");
const APP_UPDATE_MARKER = path.join("_update", "applying.json");

/**
 * Whether an app update owns `.old-<stamp>` copies in the install now: it is journaled (its rollback
 * or commit still needs them), or its worker is alive and about to swap or swapping (the marker
 * names it). Asynchronous: start-up's main thread asks.
 */
async function appUpdateInFlight(installRoot) {
  if (await fs.promises.access(path.join(installRoot, APP_UPDATE_JOURNAL)).then(() => true, () => false)) return true;
  let marker = null;
  try { marker = JSON.parse(await fs.promises.readFile(path.join(installRoot, APP_UPDATE_MARKER), "utf8")); } catch {}
  if (!Number.isInteger(marker?.pid)) return false;
  try {
    process.kill(marker.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function* images(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* images(full);
    else if (entry.isFile() && IMAGE.test(entry.name)) yield full;
  }
}

/** Whether a file is mapped by a running process: it cannot be opened for writing. */
function inUse(file) {
  try {
    fs.closeSync(fs.openSync(file, "r+"));
    return false;
  } catch (error) {
    return error?.code === "EBUSY" || error?.code === "EPERM";
  }
}

/** Renames every in-use image under `roots` out of the installer's way; returns the renamed paths. */
function setAsideInUse(roots, { now = Date.now, log = () => {} } = {}) {
  const moved = [];
  for (const root of roots) {
    for (const file of images(root)) {
      if (!inUse(file)) continue;
      const aside = `${file}.old-${now()}`;
      try { fs.renameSync(file, aside); moved.push(aside); }
      catch (error) { log(`could not set aside ${file}: ${error?.code || error}`); }
    }
  }
  return moved;
}

/**
 * Deletes set-aside images nothing runs any more; ones still in use stay for a later start. It runs
 * at every start, so it walks asynchronously: synchronously, the walk of acp-runtime's node_modules
 * held the main process (every window) 1.15 s on the busy hard disk (2026-10-30).
 */
async function sweepSetAside(roots, { installRoot = null } = {}) {
  // Not while an app update owns its old copies. On 2026-11-13 an app started during a swap deleted
  // them here: the rollback then left ten files missing, ao-daemon.exe among them, and no chat
  // could start.
  if (installRoot && await appUpdateInFlight(installRoot)) return 0;
  let removed = 0;
  const walk = async (dir) => {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (SET_ASIDE.test(entry.name)) {
        try { await fs.promises.rm(full); removed += 1; } catch { /* still running; a later start removes it */ }
      }
    }
  };
  for (const root of roots) await walk(root);
  return removed;
}

/** The install's agent runtime folders: the AO daemon and the packaged Node runtime. */
function agentRuntimeRoots(resourcesDir) {
  return [path.join(resourcesDir, "agent-orchestrator"), path.join(resourcesDir, "acp-runtime")];
}

module.exports = { setAsideInUse, sweepSetAside, agentRuntimeRoots, appUpdateInFlight, inUse };
