"use strict";
// Agents keep running across an update. Each AO chat card runs in a detached chat host started
// from the installed ao-daemon.exe (and a Claude card in the packaged Node runtime), so those
// images are in use and the installer cannot overwrite them. Windows refuses to delete or rewrite
// a running image but does allow renaming it: the running agent keeps its mapped copy under the
// new name, and the installer writes the new version at the original path. Leftovers are deleted
// on a later start, once nothing runs them.
const fs = require("node:fs");
const path = require("node:path");

const IMAGE = /\.(exe|dll|node)$/i;
const SET_ASIDE = /\.old-\d+$/;

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

/** Deletes set-aside images nothing runs any more; ones still in use stay for a later start. */
function sweepSetAside(roots) {
  let removed = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SET_ASIDE.test(entry.name)) {
        try { fs.rmSync(full); removed += 1; } catch { /* still running; a later start removes it */ }
      }
    }
  };
  for (const root of roots) walk(root);
  return removed;
}

/** The install's agent runtime folders: the AO daemon and the packaged Node runtime. */
function agentRuntimeRoots(resourcesDir) {
  return [path.join(resourcesDir, "agent-orchestrator"), path.join(resourcesDir, "acp-runtime")];
}

module.exports = { setAsideInUse, sweepSetAside, agentRuntimeRoots, inUse };
