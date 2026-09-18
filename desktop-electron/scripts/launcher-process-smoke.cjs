"use strict";

const fs = require("node:fs");
const { spawn } = require("node:child_process");
const {
  DETACH_OWNED_CHILD,
  processRunning,
  terminateOwnedProcessTree,
} = require("../electron/process-tree.cjs");

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function appendBounded(current, chunk) {
  const combined = `${current}${chunk.toString("utf8")}`;
  return combined.length <= MAX_CAPTURE_BYTES
    ? combined
    : combined.slice(combined.length - MAX_CAPTURE_BYTES);
}

function readDiagnostic(filePath) {
  if (!filePath) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 1) return null;
    const bytes = fs.readFileSync(filePath);
    return bytes.subarray(Math.max(0, bytes.length - MAX_DIAGNOSTIC_BYTES)).toString("utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return `could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function readMarker(markerPath) {
  let source;
  try {
    source = fs.readFileSync(markerPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { marker: null, parseError: null };
    return { marker: null, parseError: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { marker: JSON.parse(source), parseError: null };
  } catch (error) {
    return { marker: null, parseError: error instanceof Error ? error.message : String(error) };
  }
}

function packagedLauncherEnvironment(environment) {
  if (!environment) return environment;
  return Object.fromEntries(
    Object.entries(environment)
      .filter(([name]) => name.toUpperCase() !== "NODE_OPTIONS"),
  );
}

async function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let settled = false;
  await Promise.race([
    new Promise((resolve) => child.once("exit", () => { settled = true; resolve(); })),
    delay(milliseconds),
  ]);
  return settled || child.exitCode !== null || child.signalCode !== null;
}

async function stopOwnedChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !processRunning(child.pid)) return;
  terminateOwnedProcessTree(child, "SIGTERM");
  if (await waitForExit(child, 2_000)) return;
  terminateOwnedProcessTree(child, "SIGKILL");
  if (!await waitForExit(child, 5_000) && processRunning(child.pid)) {
    throw new Error(`Packaged launcher process ${child.pid} remained alive after owned-tree termination`);
  }
}

function failureMessage(prefix, state) {
  const details = [prefix];
  if (state.exit) details.push(`exit=${JSON.stringify(state.exit)}`);
  if (state.markerParseError) details.push(`marker_error=${JSON.stringify(state.markerParseError)}`);
  if (state.fatalLog) details.push(`fatal_log=${JSON.stringify(state.fatalLog)}`);
  if (state.stderr.trim()) details.push(`stderr=${JSON.stringify(state.stderr.trim())}`);
  if (state.stdout.trim()) details.push(`stdout=${JSON.stringify(state.stdout.trim())}`);
  return details.join("; ");
}

async function runPackagedLauncherProcess({
  command,
  args = [],
  cwd,
  env,
  markerPath,
  fatalLogPath,
  timeoutMs = 120_000,
  exitGraceMs = 5_000,
  pollIntervalMs = 100,
}) {
  if (typeof command !== "string" || !command) throw new Error("Packaged launcher command is required");
  if (!Array.isArray(args)) throw new Error("Packaged launcher arguments must be an array");
  if (typeof markerPath !== "string" || !markerPath) throw new Error("Packaged launcher marker path is required");
  for (const [label, value] of [["timeout", timeoutMs], ["exit grace", exitGraceMs], ["poll interval", pollIntervalMs]]) {
    if (!Number.isFinite(value) || value < 1) throw new Error(`Packaged launcher ${label} must be positive`);
  }

  const child = spawn(command, args, {
    cwd,
    env: packagedLauncherEnvironment(env),
    detached: DETACH_OWNED_CHILD,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const state = {
    stdout: "",
    stderr: "",
    exit: null,
    spawnError: null,
    markerParseError: null,
    fatalLog: null,
  };
  child.stdout?.on("data", (chunk) => { state.stdout = appendBounded(state.stdout, chunk); });
  child.stderr?.on("data", (chunk) => { state.stderr = appendBounded(state.stderr, chunk); });
  child.once("error", (error) => { state.spawnError = error; });
  child.once("exit", (code, signal) => { state.exit = { code, signal }; });

  const startedAt = Date.now();
  let markerSeenAt = null;
  for (;;) {
    if (state.spawnError) {
      await stopOwnedChild(child).catch(() => {});
      throw new Error(failureMessage(
        `Packaged launcher could not start: ${state.spawnError.message}`,
        state,
      ));
    }

    const markerRead = readMarker(markerPath);
    state.markerParseError = markerRead.parseError;
    const marker = markerRead.marker;
    if (marker && markerSeenAt === null) markerSeenAt = Date.now();
    state.fatalLog = readDiagnostic(fatalLogPath);

    if (state.fatalLog && !marker) {
      await stopOwnedChild(child);
      throw new Error(failureMessage("Packaged launcher reported a fatal startup error", state));
    }

    if (state.exit) {
      if (marker) {
        return {
          marker,
          forcedTermination: false,
          exit: state.exit,
          stdout: state.stdout,
          stderr: state.stderr,
        };
      }
      throw new Error(failureMessage("Packaged launcher exited before writing its readiness marker", state));
    }

    if (marker && Date.now() - markerSeenAt >= exitGraceMs) {
      await stopOwnedChild(child);
      return {
        marker,
        forcedTermination: true,
        exit: state.exit,
        stdout: state.stdout,
        stderr: state.stderr,
      };
    }

    if (Date.now() - startedAt >= timeoutMs) {
      await stopOwnedChild(child);
      throw new Error(failureMessage(
        `Packaged launcher did not become ready within ${timeoutMs}ms`,
        state,
      ));
    }
    await delay(pollIntervalMs);
  }
}

module.exports = {
  runPackagedLauncherProcess,
};
