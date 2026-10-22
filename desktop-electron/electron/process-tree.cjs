const path = require("node:path");
const { execFile, spawnSync } = require("node:child_process");

const DETACH_OWNED_CHILD = process.platform !== "win32";

function processRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves the process exists even though this user cannot signal it.
    return error?.code === "EPERM";
  }
}

// A short synchronous pause so a process asked to close politely has a moment to
// exit before we escalate. No timer, subprocess or shell is involved.
function sleepSync(milliseconds) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, milliseconds));
  } catch {
    // SharedArrayBuffer may be unavailable in a constrained runtime; skip the pause.
  }
}

function runTaskkill(taskkill, args) {
  return spawnSync(taskkill, args, { stdio: "ignore", windowsHide: true, timeout: 10_000 });
}

function terminateOwnedProcessTree(child, signal = "SIGTERM") {
  if (!child) return;
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid < 1) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!child.kill(signal) && child.exitCode === null && child.signalCode === null) {
      throw new Error("Owned child process has no valid pid and refused termination");
    }
    return;
  }

  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    // Ask the process tree to close politely first, and only force it if it does not
    // stop on its own. Escalating instead of always force-killing is gentler on the
    // child's own cleanup and avoids the aggressive whole-tree force-kill pattern.
    const graceful = runTaskkill(taskkill, ["/PID", String(pid), "/T"]);
    if ((!graceful.error && graceful.status === 0) || !processRunning(pid)) return;
    sleepSync(400);
    if (!processRunning(pid)) return;
    const forced = runTaskkill(taskkill, ["/PID", String(pid), "/T", "/F"]);
    if ((forced.error || forced.status !== 0) && processRunning(pid)) {
      const detail = forced.error?.message || `taskkill exited with status ${forced.status ?? "unknown"}`;
      throw new Error(`Could not terminate owned Windows process tree ${pid}: ${detail}`);
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw new Error(
      `Could not terminate owned process group ${pid}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function runTaskkillAsync(taskkill, args) {
  return new Promise((resolve) => {
    execFile(taskkill, args, { windowsHide: true, timeout: 10_000 }, (error) => {
      // execFile reports a non-zero exit as an error with a numeric code; a spawn failure has none.
      if (!error) resolve({ status: 0 });
      else if (typeof error.code === "number") resolve({ status: error.code });
      else resolve({ error, status: null });
    });
  });
}

/**
 * terminateOwnedProcessTree without blocking the caller's thread: the same polite-then-forced
 * taskkill, run as child processes, and the same errors (rejects). The synchronous form waited
 * up to two 10 s taskkill runs plus a 400 ms pause on the app's main thread; on a busy machine
 * that froze the whole app while a bridge, helper or control process was stopped.
 */
async function terminateOwnedProcessTreeAsync(child, signal = "SIGTERM") {
  if (!child) return;
  const pid = child.pid;
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid < 1) {
    terminateOwnedProcessTree(child, signal);
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
  const graceful = await runTaskkillAsync(taskkill, ["/PID", String(pid), "/T"]);
  if ((!graceful.error && graceful.status === 0) || !processRunning(pid)) return;
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (!processRunning(pid)) return;
  const forced = await runTaskkillAsync(taskkill, ["/PID", String(pid), "/T", "/F"]);
  if ((forced.error || forced.status !== 0) && processRunning(pid)) {
    const detail = forced.error?.message || `taskkill exited with status ${forced.status ?? "unknown"}`;
    throw new Error(`Could not terminate owned Windows process tree ${pid}: ${detail}`);
  }
}

module.exports = {
  DETACH_OWNED_CHILD,
  processRunning,
  terminateOwnedProcessTree,
  terminateOwnedProcessTreeAsync,
};
