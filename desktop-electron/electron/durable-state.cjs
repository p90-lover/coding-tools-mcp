"use strict";
// Small state files the app cannot do without: its settings, the external services' configuration,
// the mail connection and the keys that decrypt saved secrets. Each is written flushed to disk with
// a second copy beside it (<file>.bak), and read back from that copy when the file itself is torn.
//
// Before, a torn file (NUL bytes after a power cut, unreadable sectors on a failing disk) read as
// "no file": the settings went back to defaults and the next save wrote over the damaged file, and
// a torn key file was replaced by a new key, leaving every secret encrypted with the old one
// unreadable. Both were seen on this app's disk (launcher-supervisor.json all NULs, 2026-10-23;
// paging errors and lost $Mft writes on the G:/H: drive, 2026-10-30).

const fs = require("node:fs");
const { writePrivateFileAtomic, writePrivateFileAtomicAsync } = require("./atomic-file.cjs");

const BACKUP_SUFFIX = ".bak";

/**
 * Writes `content` to `filePath` flushed to disk, then the same content to `<filePath>.bak`. The
 * second copy is best effort and not flushed: it only matters once the first is damaged later.
 */
function writeStateFile(filePath, content, options = {}) {
  writePrivateFileAtomic(filePath, content, { ...options, durable: true });
  try { writePrivateFileAtomic(`${filePath}${BACKUP_SUFFIX}`, content, options); } catch { /* the main copy is in place */ }
}

/**
 * writeStateFile for a file saved as the app is used (a chat queue change, a scored round): the
 * flush waits on a pool thread, not the main one. Synchronously it held every window 0.5-2.4 s on
 * the hard disk (2026-10-31). A burst of saves is one write plus at most one more with the latest
 * content; `saved()` resolves once everything asked for so far is on disk. A failed write leaves
 * the old file and calls `onError`.
 */
function createStateFileWriter(filePath, { onError = null, ...options } = {}) {
  let saving = null;
  let next = null;
  const write = (content) => writePrivateFileAtomicAsync(filePath, content, { ...options, durable: true })
    .then(() => writePrivateFileAtomicAsync(`${filePath}${BACKUP_SUFFIX}`, content, options).catch(() => { /* the main copy is in place */ }))
    .catch((error) => { onError?.(error); /* the old file stays; the next change saves everything again */ });
  const run = (content) => {
    saving = write(content).finally(() => {
      saving = null;
      if (next !== null) { const latest = next; next = null; run(latest); }
    });
  };
  return {
    save(content) {
      if (saving) next = content;
      else run(content);
    },
    async saved() { while (saving) await saving; },
  };
}

/** Removes a state file and its copy. */
function removeStateFile(filePath) {
  fs.rmSync(filePath, { force: true });
  fs.rmSync(`${filePath}${BACKUP_SUFFIX}`, { force: true });
}

function attempt(file, parse) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { error, missing: error?.code === "ENOENT" };
  }
  try {
    return { value: parse(text) };
  } catch (error) {
    return { error, missing: false };
  }
}

/**
 * Reads a file written by writeStateFile. `parse(text)` returns the value, or throws for content it
 * cannot use (JSON.parse throws on NUL bytes and on a cut-off file). Returns `{ value, source }`:
 * - "file": the file itself;
 * - "backup": the file was missing or unusable and its copy was used;
 * - "none": there is neither (a first start); `value` is undefined;
 * - "unreadable": the file is unusable and so is its copy; `value` is undefined.
 * An unusable file is renamed to `<filePath>.corrupt-<time>` (`setAside`) before anything is
 * written over it, so its bytes stay for recovery by hand. `error` says why the file was unusable.
 * `preserveUnreadable` leaves it in place so a later credential read can retry a transient failure.
 */
function readStateFile(filePath, parse, { now = Date.now, preserveUnreadable = false } = {}) {
  const main = attempt(filePath, parse);
  if (!main.error) return { value: main.value, source: "file", error: null, setAside: null };
  let setAside = null;
  if (!main.missing && !preserveUnreadable) {
    // A second torn copy set aside in the same millisecond gets its own name: a rename onto the
    // first would replace it.
    const stamp = `${filePath}.corrupt-${now()}`;
    let target = stamp;
    for (let n = 1; fs.existsSync(target); n += 1) target = `${stamp}-${n}`;
    try {
      fs.renameSync(filePath, target);
      setAside = target;
    } catch { /* left in place; the next write replaces it */ }
  }
  const backup = attempt(`${filePath}${BACKUP_SUFFIX}`, parse);
  const error = main.missing ? null : main.error;
  if (!backup.error) return { value: backup.value, source: "backup", error, setAside };
  return { value: undefined, source: main.missing && backup.missing ? "none" : "unreadable", error, setAside };
}

module.exports = { BACKUP_SUFFIX, createStateFileWriter, readStateFile, removeStateFile, writeStateFile };
