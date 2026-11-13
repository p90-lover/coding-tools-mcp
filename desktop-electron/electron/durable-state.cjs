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
 * writeStateFile off the main thread, for a change whose caller must know it reached the disk (a
 * chat's deleted message is saved before the chat's record changes, and refused when it can't be).
 * Rejects with the main copy's error; the copy beside it is best effort. Writes to one file run in
 * call order (writePrivateFileAtomicAsync queues them), so the last call's content ends up on disk.
 */
async function writeStateFileAsync(filePath, content, options = {}) {
  await writePrivateFileAtomicAsync(filePath, content, { ...options, durable: true });
  await writePrivateFileAtomicAsync(`${filePath}${BACKUP_SUFFIX}`, content, options).catch(() => { /* the main copy is in place */ });
}

/**
 * writeStateFile for a file saved as the app is used (a chat queue change, a scored round): the
 * flush waits on a pool thread, not the main one. Synchronously it held every window 0.5-2.4 s on
 * the hard disk (2026-10-31). A burst of saves is one write plus at most one more with the latest
 * content; `saved()` resolves once everything asked for so far is on disk. Identical strings are
 * skipped only after both copies succeeded. A failed write leaves the old file and calls `onError`.
 */
function createStateFileWriter(filePath, { onError = null, ...options } = {}) {
  let saving = null;
  let next = null;
  let written = null;
  const unchanged = (content) => typeof content === "string" && content === written;
  const write = (content) => writePrivateFileAtomicAsync(filePath, content, { ...options, durable: true })
    .then(() => writePrivateFileAtomicAsync(`${filePath}${BACKUP_SUFFIX}`, content, options)
      .then(() => { if (typeof content === "string") written = content; })
      .catch(() => { /* the main copy is in place; an identical save retries its missing backup */ }))
    .catch((error) => { onError?.(error); /* the old file stays; the next change saves everything again */ });
  const run = (content) => {
    // A failed primary or backup write must not leave an older value remembered as current.
    written = null;
    saving = write(content).finally(() => {
      saving = null;
      if (next !== null) { const latest = next; next = null; if (!unchanged(latest)) run(latest); }
    });
  };
  return {
    save(content) {
      if (saving) next = content;
      else if (!unchanged(content)) run(content);
    },
    async saved() { while (saving) await saving; },
  };
}

/** Removes a state file and its copy. */
function removeStateFile(filePath) {
  fs.rmSync(filePath, { force: true });
  fs.rmSync(`${filePath}${BACKUP_SUFFIX}`, { force: true });
}

function readTextFromDisk(file) {
  return fs.readFileSync(file, "utf8");
}

function attempt(file, parse, readText = readTextFromDisk) {
  let text;
  try {
    text = readText(file);
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
 * `readText(file)` replaces the disk read: a caller that read the file and its copy ahead with
 * fs.promises answers from memory, so the main thread never waits on the disk.
 */
function readStateFile(filePath, parse, { now = Date.now, preserveUnreadable = false, readText = readTextFromDisk } = {}) {
  const main = attempt(filePath, parse, readText);
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
  const backup = attempt(`${filePath}${BACKUP_SUFFIX}`, parse, readText);
  const error = main.missing ? null : main.error;
  if (!backup.error) return { value: backup.value, source: "backup", error, setAside };
  return { value: undefined, source: main.missing && backup.missing ? "none" : "unreadable", error, setAside };
}

module.exports = { BACKUP_SUFFIX, createStateFileWriter, readStateFile, removeStateFile, writeStateFile, writeStateFileAsync };
