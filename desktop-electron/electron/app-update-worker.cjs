"use strict";
// Swaps a staged whole-app update into the install once the app has closed (see app-update.cjs).
// Runs under the app's own executable with ELECTRON_RUN_AS_NODE, from the stage folder.
//
// Each replaced file is renamed aside (<file>.old-<stamp>) before the new one takes its path:
// Windows allows renaming a running image, so an agent still running from the install keeps its
// copy. Any failure renames everything back, and the previous version starts again.
// Started with ELECTRON_NO_ASAR, so app.asar is a plain file to it.
const fs = (() => { try { return require("original-fs"); } catch { return require("node:fs"); } })();
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const PARENT_WAIT_MS = 5 * 60_000;
const RENAME_ATTEMPTS = 12;

function appendLog(job, message) {
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

async function swapIn(job, stamp) {
  const journal = [];
  try {
    for (const rel of job.changed) {
      const destination = target(job, rel);
      const staged = path.join(job.filesRoot, ...rel.split("/"));
      if (!fs.statSync(staged, { throwIfNoEntry: false })?.isFile()) throw new Error(`Staged file is missing: ${rel}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const entry = { rel, destination, staged, aside: null, placed: false };
      journal.push(entry);
      if (fs.existsSync(destination)) {
        entry.aside = `${destination}.old-${stamp}`;
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
        if (entry.placed) fs.renameSync(entry.destination, entry.staged);
        if (entry.aside && fs.existsSync(entry.aside)) fs.renameSync(entry.aside, entry.destination);
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

/** Shows the new version in Windows' installed-apps list (the installer's uninstall entry). */
function updateUninstallEntry(job) {
  if (process.platform !== "win32") return;
  const base = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
  const query = spawnSync("reg.exe", ["query", base, "/s", "/v", "InstallLocation"], { encoding: "utf8", windowsHide: true });
  if (query.status !== 0) return;
  let key = null;
  const wanted = path.win32.normalize(job.installRoot).toLowerCase().replace(/\\+$/, "");
  for (const line of query.stdout.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) key = line.trim();
    const match = /^\s+InstallLocation\s+REG_\w+\s+(.+)$/.exec(line);
    if (key && match && path.win32.normalize(match[1].trim()).toLowerCase().replace(/\\+$/, "") === wanted) {
      spawnSync("reg.exe", ["add", key, "/v", "DisplayVersion", "/t", "REG_SZ", "/d", job.version, "/f"], { windowsHide: true });
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

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath || !path.isAbsolute(jobPath)) throw new Error("App update worker requires an absolute job path");
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  appendLog(job, `waiting for the app (PID ${job.parentPid}) to close before updating to v${job.version}`);
  if (!await waitForParent(job.parentPid)) {
    // The app kept running (its quit was cancelled): change nothing, start nothing.
    appendLog(job, "the app did not close; the update was not applied");
    try { fs.rmSync(job.stageRoot, { recursive: true, force: true }); } catch {}
    return;
  }
  const stamp = Date.now();
  // While files are being swapped the app must not start from a half-updated install: a launch
  // meanwhile waits for this marker to go (see waitForUpdateApply in app-update.cjs).
  const marker = path.join(job.installRoot, "_update", "applying.json");
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${JSON.stringify({ pid: process.pid, version: job.version, at: stamp })}\n`);
  } catch {}
  let journal;
  try {
    journal = await swapIn(job, stamp);
  } catch (error) {
    try { fs.rmSync(marker, { force: true }); } catch {}
    appendLog(job, `update failed and was rolled back: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    launch(job.executable);
    return;
  }
  try {
    fs.writeFileSync(path.join(job.installRoot, "_update", "installed.json"), `${JSON.stringify(job.installedManifest)}\n`);
  } catch (error) {
    appendLog(job, `could not record the installed file list: ${error?.message || error}`);
  }
  try { updateUninstallEntry(job); } catch {}
  const leftover = sweep(job, journal);
  try { fs.rmSync(marker, { force: true }); } catch {}
  appendLog(job, `v${job.version} applied: ${job.changed.length} file(s) replaced, ${job.obsolete.length} removed${leftover ? `, ${leftover} still in use` : ""}`);
  launch(job.executable);
  try { fs.rmSync(job.stageRoot, { recursive: true, force: true }); } catch {}
}

if (require.main === module) {
  void main().catch(() => process.exit(1));
}

module.exports = { renameWithRetry, swapIn, sweep, waitForParent };
