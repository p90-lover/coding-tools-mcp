"use strict";
// Swaps a staged whole-app update into the install once the app has closed (see app-update.cjs).
// Runs under the app's own executable with ELECTRON_RUN_AS_NODE, from the stage folder.
//
// Each replaced file keeps its old copy at <file>.old-<stamp>: a hard link made before the new
// file replaces it in one rename, or, for a file Windows will not replace (a running image), a
// rename aside first. An agent still running from the install keeps its copy. Any failure renames
// everything back, and the previous version starts again.
//
// The swap is written to _update/journal.json before the first rename, so a worker killed midway
// (power loss, logoff) is finished or undone by the app's next start (recoverSwap). The old copies
// stay until the new version reaches whenReady (commit in app-update.cjs); a start that fails
// first puts them back (this file with --restore). Each outcome is kept in _update/last-result.json.
// Started with ELECTRON_NO_ASAR, so app.asar is a plain file to it.
const crypto = require("node:crypto");
const fs = (() => { try { return require("original-fs"); } catch { return require("node:fs"); } })();
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const PARENT_WAIT_MS = 5 * 60_000;
const RENAME_ATTEMPTS = 12;
const JOURNAL = "journal.json";
const MARKER = "applying.json";
const LAST_RESULT = "last-result.json";
const RUNTIME_MANIFEST = "resources/runtime/manifest.json";

function appendLog(job, message) {
  if (!job.logPath) return;
  try {
    fs.mkdirSync(path.dirname(job.logPath), { recursive: true });
    fs.appendFileSync(job.logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForParent(pid, timeoutMs = PARENT_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
  return true;
}

/** Renames, retrying while a scanner or a closing process briefly holds the file. */
async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !["EBUSY", "EPERM", "EACCES"].includes(error?.code)) throw error;
      await sleep(250 * attempt);
    }
  }
}

function target(job, rel) {
  return path.join(job.installRoot, ...rel.split("/"));
}

const isFile = (filePath) => fs.statSync(filePath, { throwIfNoEntry: false })?.isFile() === true;

/**
 * Keeps the old file as a hard link at `aside`, then renames the new one over it: the path always
 * holds a whole file. A swap killed between "rename aside" and "place" left app.asar missing, and
 * an install with no app.asar runs none of this app's code, so nothing could recover it.
 * False when the volume has no hard links or Windows refuses the replace (a running image).
 */
function replaceKeepingOld(destination, aside, staged) {
  try { fs.linkSync(destination, aside); } catch { return false; }
  try {
    fs.renameSync(staged, destination);
    return true;
  } catch {
    try { fs.unlinkSync(aside); } catch {}
    return false;
  }
}

/** app.asar goes last: until it is replaced, the old app's code is whole and can recover the rest. */
function swapOrder(changed) {
  return [...changed].sort((a, b) => Number(a === "resources/app.asar") - Number(b === "resources/app.asar"));
}

async function swapIn(job, stamp) {
  const journal = [];
  try {
    for (const rel of swapOrder(job.changed)) {
      const destination = target(job, rel);
      const staged = path.join(job.filesRoot, ...rel.split("/"));
      if (!isFile(staged)) throw new Error(`Staged file is missing: ${rel}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const entry = { rel, destination, staged, aside: null, placed: false };
      journal.push(entry);
      if (fs.existsSync(destination)) {
        entry.aside = `${destination}.old-${stamp}`;
        if (replaceKeepingOld(destination, entry.aside, staged)) {
          entry.placed = true;
          continue;
        }
        await renameWithRetry(destination, entry.aside);
      }
      await renameWithRetry(staged, destination);
      entry.placed = true;
    }
    for (const rel of job.obsolete) {
      const destination = target(job, rel);
      if (!fs.existsSync(destination)) continue;
      const entry = { rel, destination, staged: null, aside: `${destination}.old-${stamp}`, placed: false };
      journal.push(entry);
      await renameWithRetry(destination, entry.aside);
    }
    return journal;
  } catch (error) {
    for (const entry of journal.reverse()) {
      try {
        // With the same retries as the swap: a restore refused once (antivirus scanning the file
        // just renamed) left a new app.asar beside the old runtime, or a file missing.
        if (entry.placed) await renameWithRetry(entry.destination, entry.staged);
        if (entry.aside && fs.existsSync(entry.aside)) await renameWithRetry(entry.aside, entry.destination);
      } catch (rollback) {
        appendLog(job, `could not restore ${entry.rel}: ${rollback?.code || rollback}`);
      }
    }
    throw error;
  }
}

/** Removes what was set aside; files still running stay listed for the app's next start. */
function sweep(job, journal) {
  const updateRoot = path.join(job.installRoot, "_update");
  const listPath = path.join(updateRoot, "set-aside.json");
  let remaining = [];
  try { remaining = JSON.parse(fs.readFileSync(listPath, "utf8")); } catch {}
  if (!Array.isArray(remaining)) remaining = [];
  for (const entry of journal) {
    if (!entry.aside) continue;
    try { fs.rmSync(entry.aside, { force: true }); }
    catch { remaining.push(path.relative(job.installRoot, entry.aside).split(path.sep).join("/")); }
  }
  try {
    if (remaining.length) fs.writeFileSync(listPath, `${JSON.stringify(remaining)}\n`);
    else fs.rmSync(listPath, { force: true });
  } catch {}
  return remaining.length;
}

function updateFile(installRoot, name) {
  return path.join(installRoot, "_update", name);
}

function readJsonFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

/** Writes JSON so a power cut leaves the old file or the new one, never a torn one. */
function writeJsonDurable(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  const fd = fs.openSync(temporary, "w");
  try {
    fs.writeSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
}

/**
 * Records how an update ended in _update/last-result.json. A version that keeps failing counts
 * its failures there, so the app stops installing it by itself (see createAutoInstaller).
 */
function recordResult(installRoot, { version, ok, stage, message = null, countFailure = true }) {
  const filePath = updateFile(installRoot, LAST_RESULT);
  const previous = readJsonFile(filePath);
  const before = previous?.version === version && Number.isInteger(previous.failures) ? previous.failures : 0;
  // Only a start that reached whenReady clears the count: placed files that then fail to start
  // would otherwise reset it on every try, and the version would never stop installing itself.
  const failures = ok && stage === "started" ? 0 : before + (!ok && countFailure ? 1 : 0);
  const result = { version, ok, stage, message: message ? String(message).slice(0, 2000) : null, failures, at: Date.now() };
  try { writeJsonDurable(filePath, result); } catch {}
  return result;
}

/** The swap as planned, written before the first rename: enough to finish or undo it from the files. */
function createJournal(job, jobPath, stamp) {
  const expected = new Map((job.installedManifest?.files || []).map((file) => [file.path, file]));
  return {
    schema: 1, state: "swapping", version: job.version, stamp, at: Date.now(), attempts: 0, launches: 0,
    installRoot: job.installRoot, stageRoot: job.stageRoot, filesRoot: job.filesRoot, executable: job.executable, jobPath,
    changed: swapOrder(job.changed).map((rel) => ({
      rel, size: expected.get(rel)?.size ?? null, sha256: expected.get(rel)?.sha256 ?? null,
    })),
    obsolete: [...job.obsolete],
  };
}

function journalPaths(journal, rel) {
  const destination = path.join(journal.installRoot, ...rel.split("/"));
  return { destination, aside: `${destination}.old-${journal.stamp}`, staged: path.join(journal.filesRoot, ...rel.split("/")) };
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/** Whether a file is the one the update ships: its size, and its hash when the job carries one. */
async function matches(filePath, file, hash = hashFile) {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat?.isFile()) return false;
  if (Number.isSafeInteger(file.size) && stat.size !== file.size) return false;
  return !file.sha256 || await hash(filePath) === file.sha256;
}

/** Before the relaunch: the runtime is this version's and every placed file is the one shipped. */
async function verifyPlaced(journal, hash = hashFile) {
  const manifest = readJsonFile(path.join(journal.installRoot, ...RUNTIME_MANIFEST.split("/")));
  if (manifest?.appVersion !== journal.version) {
    throw new Error(`The installed runtime is ${manifest?.appVersion ? `v${manifest.appVersion}` : "missing"}, not v${journal.version}`);
  }
  for (const file of journal.changed) {
    if (!await matches(journalPaths(journal, file.rel).destination, file, hash)) {
      throw new Error(`A placed file does not match the update: ${file.rel}`);
    }
  }
}

/**
 * Finishes an interrupted swap from the staged files. Every file must be either placed already or
 * staged whole (the same checks extractPack made); otherwise nothing is touched and it returns false.
 */
async function rollForward(journal, hash = hashFile) {
  const pending = [];
  for (const file of journal.changed) {
    const { destination, staged } = journalPaths(journal, file.rel);
    if (isFile(staged)) {
      if (!await matches(staged, file, hash)) return false;
      pending.push(file);
    } else if (!await matches(destination, file, hash)) {
      return false;
    }
  }
  for (const file of pending) {
    const { destination, aside, staged } = journalPaths(journal, file.rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (fs.existsSync(destination)) {
      // With the old copy already at `aside` (a hard link made just before the kill), this is a
      // second name for the same file.
      if (fs.existsSync(aside)) fs.rmSync(destination, { force: true });
      else await renameWithRetry(destination, aside);
    }
    await renameWithRetry(staged, destination);
  }
  for (const rel of journal.obsolete) {
    const { destination, aside } = journalPaths(journal, rel);
    if (fs.existsSync(destination) && !fs.existsSync(aside)) await renameWithRetry(destination, aside);
  }
  return true;
}

async function moveToStage(from, staged) {
  if (fs.existsSync(staged)) {
    fs.rmSync(from, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  await renameWithRetry(from, staged);
}

/** Puts the previous version back: every old copy returns to its path. Returns what it could not. */
async function rollBack(journal, hash = hashFile) {
  const failed = [];
  for (const rel of [...journal.obsolete].reverse()) {
    const { destination, aside } = journalPaths(journal, rel);
    try {
      if (fs.existsSync(aside) && !fs.existsSync(destination)) await renameWithRetry(aside, destination);
    } catch (error) {
      failed.push(`${rel}: ${error?.code || error}`);
    }
  }
  for (const file of [...journal.changed].reverse()) {
    const { destination, aside, staged } = journalPaths(journal, file.rel);
    try {
      if (fs.existsSync(aside)) {
        if (fs.existsSync(destination)) await moveToStage(destination, staged);
        await renameWithRetry(aside, destination);
      } else if (file.sha256 && !isFile(staged) && await matches(destination, file, hash)) {
        // A file this update added (nothing stood there before) goes back to the stage.
        await moveToStage(destination, staged);
      }
    } catch (error) {
      failed.push(`${file.rel}: ${error?.code || error}`);
    }
  }
  return failed;
}

/** Shows the new version in Windows' installed-apps list (the installer's uninstall entry). */
function updateUninstallEntry(job) {
  if (process.platform !== "win32") return;
  const base = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
  // Bounded: a hung reg.exe held the update marker and the relaunch never came.
  const query = spawnSync("reg.exe", ["query", base, "/s", "/v", "InstallLocation"], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (query.status !== 0) return;
  let key = null;
  const wanted = path.win32.normalize(job.installRoot).toLowerCase().replace(/\\+$/, "");
  for (const line of query.stdout.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) key = line.trim();
    const match = /^\s+InstallLocation\s+REG_\w+\s+(.+)$/.exec(line);
    if (key && match && path.win32.normalize(match[1].trim()).toLowerCase().replace(/\\+$/, "") === wanted) {
      spawnSync("reg.exe", ["add", key, "/v", "DisplayVersion", "/t", "REG_SZ", "/d", job.version, "/f"], { windowsHide: true, timeout: 20_000 });
      return;
    }
  }
}

function launch(executable) {
  // The worker runs as Node; the app it starts must not.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  const child = spawn(executable, [], { detached: true, stdio: "ignore", windowsHide: false, env, cwd: path.dirname(executable) });
  child.on("error", () => {});
  child.unref();
}

const errorText = (error) => (error instanceof Error ? error.stack || error.message : String(error));

/** The new files are in and checked: the app starts on them; their old copies wait for its commit. */
function finishPlaced(job, journal, journalPath) {
  try {
    if (job.installedManifest) fs.writeFileSync(updateFile(job.installRoot, "installed.json"), `${JSON.stringify(job.installedManifest)}\n`);
  } catch (error) {
    appendLog(job, `could not record the installed file list: ${error?.message || error}`);
  }
  try { updateUninstallEntry(job); } catch {}
  // Unrecorded, the next start still finds the journal "swapping" and checks every file again.
  try { writeJsonDurable(journalPath, { ...journal, state: "placed", launches: 0 }); } catch {}
  recordResult(job.installRoot, { version: job.version, ok: true, stage: "placed" });
}

async function applyJob(jobPath) {
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  appendLog(job, `waiting for the app (PID ${job.parentPid}) to close before updating to v${job.version}`);
  if (!await waitForParent(job.parentPid)) {
    // The app kept running (its quit was cancelled): change nothing, start nothing.
    appendLog(job, "the app did not close; the update was not applied");
    try { fs.rmSync(job.stageRoot, { recursive: true, force: true }); } catch {}
    return;
  }
  const stamp = Date.now();
  const journalPath = updateFile(job.installRoot, JOURNAL);
  const journal = createJournal(job, jobPath, stamp);
  // While files are being swapped the app must not start from a half-updated install: a launch
  // meanwhile waits for this marker to go (see waitForUpdateApply in app-update.cjs), and a marker
  // whose worker died leads it to the journal.
  const marker = updateFile(job.installRoot, MARKER);
  try {
    writeJsonDurable(journalPath, journal);
  } catch (error) {
    // Unjournaled, a cut-off swap could not be repaired: the update waits for another try.
    recordResult(job.installRoot, { version: job.version, ok: false, stage: "apply", message: `could not write the update journal: ${error?.message || error}` });
    appendLog(job, `update not applied: could not write the update journal: ${errorText(error)}`);
    launch(job.executable);
    try { fs.rmSync(job.stageRoot, { recursive: true, force: true }); } catch {}
    return;
  }
  try { writeJsonDurable(marker, { pid: process.pid, version: job.version, at: stamp, jobPath, journal: journalPath }); } catch {}
  let swapped = false;
  try {
    await swapIn(job, stamp);
    swapped = true;
    await verifyPlaced(journal);
  } catch (error) {
    // swapIn puts its own files back; a swap that finished but failed the check is undone here.
    const failed = swapped ? await rollBack(journal) : [];
    for (const line of failed) appendLog(job, `could not restore ${line}`);
    recordResult(job.installRoot, { version: job.version, ok: false, stage: "apply", message: error?.message || error });
    try { fs.rmSync(journalPath, { force: true }); } catch {}
    try { fs.rmSync(marker, { force: true }); } catch {}
    appendLog(job, `update failed and was rolled back: ${errorText(error)}`);
    launch(job.executable);
    try { fs.rmSync(job.stageRoot, { recursive: true, force: true }); } catch {}
    return;
  }
  finishPlaced(job, journal, journalPath);
  try { fs.rmSync(marker, { force: true }); } catch {}
  appendLog(job, `v${job.version} applied: ${job.changed.length} file(s) replaced, ${job.obsolete.length} removed`);
  // The stage stays until the new version commits: a start that fails puts the old files back.
  launch(job.executable);
}

/**
 * --recover: the app found an update it cannot start from (app-update.cjs handOffUpdateRecovery)
 * and exits. Once it has, a swap cut off midway is finished, or undone when its staged files are
 * gone or damaged; a version that failed to start ("restoring") is undone. Then the app starts.
 */
async function recoverJournal(journalPath, parentPid) {
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (!await waitForParent(parentPid)) return;
  const marker = updateFile(journal.installRoot, MARKER);
  try { writeJsonDurable(marker, { pid: process.pid, version: journal.version, at: Date.now(), journal: journalPath }); } catch {}
  try {
    // "restoring" was recorded as a failure by the app that could not start; a cut-off swap is
    // finished when it can be, and recorded as a failure when it cannot.
    let failure = null;
    if (journal.state === "swapping") {
      try {
        if (!await rollForward(journal)) throw new Error("The staged files were missing or damaged");
        await verifyPlaced(journal);
        const installedManifest = readJsonFile(journal.jobPath)?.installedManifest;
        finishPlaced({ installRoot: journal.installRoot, version: journal.version, installedManifest }, journal, journalPath);
        return;
      } catch (error) {
        failure = error?.message || String(error);
      }
    }
    const failed = await rollBack(journal);
    const notRestored = failed.length ? `could not restore ${failed.join(", ")}` : null;
    if (failure || notRestored) {
      recordResult(journal.installRoot, {
        version: journal.version, ok: false, stage: journal.state === "swapping" ? "recover" : "restore",
        message: [failure, notRestored].filter(Boolean).join("; "), countFailure: Boolean(failure),
      });
    }
    try { fs.rmSync(journalPath, { force: true }); } catch {}
    try { fs.rmSync(journal.stageRoot, { recursive: true, force: true }); } catch {}
  } finally {
    try { fs.rmSync(marker, { force: true }); } catch {}
    launch(journal.executable);
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--recover") {
    const [, journalPath, pid] = argv;
    if (!journalPath || !path.isAbsolute(journalPath)) throw new Error("App update recovery requires an absolute journal path");
    return recoverJournal(journalPath, Number(pid));
  }
  const jobPath = argv[0];
  if (!jobPath || !path.isAbsolute(jobPath)) throw new Error("App update worker requires an absolute job path");
  return applyJob(jobPath);
}

if (require.main === module) {
  void main().catch(() => process.exit(1));
}

module.exports = {
  JOURNAL, LAST_RESULT, MARKER, createJournal, hashFile, readJsonFile, recordResult, renameWithRetry,
  rollBack, rollForward, swapIn, sweep, verifyPlaced, waitForParent, writeJsonDurable,
};
