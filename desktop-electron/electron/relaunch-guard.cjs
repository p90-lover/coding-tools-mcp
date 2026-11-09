"use strict";
// Starts the app again after a keep-bridge quit that left the restart to someone else, if nobody does.
//
// Installers and install scripts close the app with POST /v1/launcher/quit-keep-bridge {"relaunch":false}
// (control-server.cjs), so the Codex bridge, CPA and MCP tunnel keep running; they install, then start
// the app. When they never get that far, nothing started it: on 2026-11-02 a script quit 0.8.50 at 14:21
// and neither installed 0.8.51 nor started the app, which stayed closed for 19 minutes until it was
// opened by hand. Install scripts also stop at their own checks after the quit (the app took too long
// to exit, a process still runs from the install folder, the installer failed), leaving it closed.
//
// The quitting app starts this file as a separate process under its bridge runtime's Bun, from a copy
// next to the browser descriptor. Nothing of it is in the install folder: an installer replaces those
// files, and install scripts wait for every process running from there, then stop it. Once the app
// has exited, the guard waits until nothing has happened for GRACE_MS: no new app (browser-host.cjs
// writes the descriptor with its pid once a started app's browser is up) and no installer running.
// Then it starts the installed app through Explorer, as the install scripts do, and leaves a note the
// new app logs in memory and deletes. The guard itself logs nothing and writes nothing else.

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const SCRIPT_NAME = "relaunch-guard.cjs";
const NOTE_NAME = "launcher-relaunch-note.json";
// The guard starts at the quit's last step (main.cjs requestQuit); an app still running this long after is not exiting.
const PARENT_WAIT_MS = 10 * 60_000;
// How long a caller has after the app exits (or its installer ends) to start an installer or the app.
const GRACE_MS = 5 * 60_000;
// The longest the guard lives. The slowest silent install seen here took 34 minutes.
const MAX_MS = 60 * 60_000;
const POLL_MS = 5_000;
// The process names install scripts wait out: electron-builder's installer (Coding.Tools_<version>_win_x64.exe),
// its old-uninstaller, and the copy NSIS runs an uninstaller from (Un_A.exe).
const INSTALLER_IMAGE = /^(?:coding\.tools_.*|.*old-uninstaller.*|un_.*)\.exe$/i;
// The installer process lives for the whole install, its old-uninstaller step included, so the listing
// asks for it alone: a full listing took 40 s on this machine's 968 processes, a filtered one 2-14 s.
// Its deadline is generous; one that passes counts as an installer, and the guard asks again later.
const INSTALLER_LISTING = ["/nh", "/fo", "csv", "/fi", "IMAGENAME eq Coding.Tools_*"];
const LISTING_TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** The pid in the app's browser descriptor, or null when there is none. */
function descriptorPid(descriptorPath) {
  try {
    const pid = JSON.parse(fs.readFileSync(descriptorPath, "utf8"))?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Whether a listing names an installer; a listing that could not be read counts as one. */
function listsInstaller(listing) {
  if (listing?.status !== 0 || typeof listing.stdout !== "string") return true;
  return listing.stdout.split(/\r?\n/).some((line) => INSTALLER_IMAGE.test(/^"([^"]*)"/.exec(line)?.[1] ?? ""));
}

function installerRunning(run = spawnSync) {
  return listsInstaller(run("tasklist.exe", INSTALLER_LISTING, { encoding: "utf8", windowsHide: true, timeout: LISTING_TIMEOUT_MS }));
}

function isFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

/**
 * Explorer hands the start to the running shell and exits, so the app is the shell's child: it gets
 * none of this process's environment, and nothing that ends this process ends it. Waited for, so the
 * guard is still here while Explorer passes it on.
 */
function launchThroughExplorer(executable, run = spawnSync) {
  run("explorer.exe", [executable], { stdio: "ignore", windowsHide: true, timeout: 30_000 });
}

/**
 * Waits for the app (`parentPid`) to exit, then until nothing has happened for GRACE_MS, and starts
 * `executable` unless a new app or an installer turned up. Returns what it did.
 */
async function guardRelaunch({ parentPid, executable, descriptorPath }, deps = {}) {
  const {
    alive = processAlive, now = Date.now, wait = sleep, appPid = () => descriptorPid(descriptorPath),
    installing = () => installerRunning(), present = isFile, launch = launchThroughExplorer,
    note = (value) => fs.writeFileSync(path.join(path.dirname(descriptorPath), NOTE_NAME), `${JSON.stringify(value)}\n`),
  } = deps;
  const startedAt = now();
  while (alive(parentPid)) {
    if (now() - startedAt >= PARENT_WAIT_MS) return { outcome: "app-still-running" };
    await wait(POLL_MS);
  }
  const exitedAt = now();
  let quietSince = exitedAt;
  let installerSeen = false;
  for (;;) {
    const pid = appPid();
    if (pid !== null && pid !== parentPid && alive(pid)) return { outcome: "app-started", pid };
    const capped = now() - startedAt >= MAX_MS;
    if (capped || now() - quietSince >= GRACE_MS) {
      // Checked only when the app would start: one process listing per grace period at most.
      if (installing()) {
        installerSeen = true;
        quietSince = now();
        if (capped) return { outcome: "installer-still-running" };
      } else if (present(executable)) {
        const relaunch = {
          version: 1, by: "relaunch-guard", quitPid: parentPid, exitedAt, relaunchedAt: now(),
          waitedMs: now() - exitedAt, installerSeen,
          reason: installerSeen
            ? "an installer ran after the keep-bridge quit, and nothing started the app once it ended"
            : "nothing installed or started the app after the keep-bridge quit",
        };
        try { note(relaunch); } catch {}
        launch(executable);
        return { outcome: "relaunched", ...relaunch };
      } else {
        // No app in the install folder and no installer: one between its steps, or an install that broke.
        quietSince = now();
        if (capped) return { outcome: "no-app-to-start" };
      }
    }
    await wait(POLL_MS);
  }
}

/**
 * Starts the guard for this app, which is about to exit: `runtime` (a Bun outside the install folder)
 * runs a copy of this file written next to the browser descriptor. Refuses a runtime inside the install
 * folder, where a running guard would hold files an installer replaces. At quit only, so its few
 * synchronous calls hold no window that is still in use.
 */
function spawnRelaunchGuard({
  runtime, executable, descriptorPath, parentPid = process.pid, source = __filename, io = fs, spawnProcess = spawn,
}) {
  const inside = (file, folder) => path.resolve(file).toLowerCase().startsWith(path.resolve(folder).toLowerCase() + path.sep);
  if (typeof runtime !== "string" || !path.isAbsolute(runtime) || inside(runtime, path.dirname(executable))) {
    throw new Error("The relaunch guard needs a runtime outside the install folder");
  }
  if (!io.existsSync(runtime)) throw new Error(`The relaunch guard's runtime is missing: ${runtime}`);
  const script = path.join(path.dirname(descriptorPath), SCRIPT_NAME);
  io.writeFileSync(script, io.readFileSync(source));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  const child = spawnProcess(runtime, [script, "--parent", String(parentPid), "--executable", executable, "--descriptor", descriptorPath], {
    cwd: path.dirname(script), detached: true, env, stdio: "ignore", windowsHide: true,
  });
  // A refused start is reported from the missing pid; the 'error' event after it must not be uncaught.
  child?.once?.("error", () => undefined);
  if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error("The relaunch guard did not start");
  child.unref?.();
  return { pid: child.pid, script };
}

/** The note a guard left when it started this app, read once and deleted, for the app's in-memory log. */
async function consumeRelaunchNote(directory, io = fs.promises) {
  const file = path.join(directory, NOTE_NAME);
  let note;
  try { note = JSON.parse(await io.readFile(file, "utf8")); } catch { return null; }
  await io.rm(file, { force: true }).catch(() => undefined);
  if (note?.version !== 1 || note.by !== "relaunch-guard") return null;
  const number = (value) => (Number.isFinite(value) ? value : null);
  return {
    reason: String(note.reason ?? "").slice(0, 300), quitPid: number(note.quitPid), exitedAt: number(note.exitedAt),
    relaunchedAt: number(note.relaunchedAt), waitedMs: number(note.waitedMs), installerSeen: note.installerSeen === true,
  };
}

function parseArguments(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const parentPid = Number(value("--parent"));
  const executable = value("--executable");
  const descriptorPath = value("--descriptor");
  if (!Number.isInteger(parentPid) || parentPid <= 0 || typeof executable !== "string" || !path.isAbsolute(executable)
    || typeof descriptorPath !== "string" || !path.isAbsolute(descriptorPath)) {
    throw new Error("The relaunch guard needs --parent <pid> --executable <path> --descriptor <path>");
  }
  return { parentPid, executable, descriptorPath };
}

if (require.main === module) {
  Promise.resolve().then(() => guardRelaunch(parseArguments(process.argv.slice(2))))
    .then(() => process.exit(0), () => process.exit(1));
}

module.exports = {
  GRACE_MS, MAX_MS, NOTE_NAME, PARENT_WAIT_MS, SCRIPT_NAME,
  consumeRelaunchNote, guardRelaunch, installerRunning, listsInstaller, parseArguments, spawnRelaunchGuard,
};
