"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

function runtimeCliVersion(runtimeRoot) {
  if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot)) {
    throw new TypeError("Launcher runtime verification requires an absolute runtime root");
  }
  const packagePath = path.join(runtimeRoot, "app", "package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Installed launcher runtime package metadata is invalid: ${packagePath}`
      + `: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const version = typeof packageJson?.version === "string" ? packageJson.version.trim() : "";
  if (!RUNTIME_VERSION.test(version)) {
    throw new Error(`Installed launcher runtime package version is invalid: ${JSON.stringify(version)}`);
  }
  return version;
}

function assertLauncherRuntimeVersion({ runtimeRoot, result }) {
  if (!result || typeof result !== "object") {
    throw new TypeError("Launcher runtime verification requires a process result");
  }
  if (result.error) throw result.error;
  const expectedVersion = runtimeCliVersion(runtimeRoot);
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  if (result.status !== 0 || stdout !== expectedVersion) {
    throw new Error(
      `Installed launcher runtime is not executable or reports an unexpected version`
      + ` (expected=${JSON.stringify(expectedVersion)}, status=${result.status ?? "unknown"},`
      + ` stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)})`,
    );
  }
  return expectedVersion;
}

async function terminateLauncherSmoke({ app, browserHost, browserControl, mainWindow }) {
  if (!app || typeof app.exit !== "function") {
    throw new TypeError("Launcher smoke exit requires Electron app.exit");
  }
  if (!browserHost || typeof browserHost.destroy !== "function") {
    throw new TypeError("Launcher smoke exit requires browser host cleanup");
  }
  if (!browserControl || typeof browserControl.close !== "function") {
    throw new TypeError("Launcher smoke exit requires browser control cleanup");
  }
  browserHost.destroy();
  await browserControl.close();
  if (mainWindow
    && typeof mainWindow.isDestroyed === "function"
    && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
  // This path is exclusively for packaged CI smoke verification. app.quit() can leave
  // Chromium utility processes alive on Windows; app.exit(0) makes the verified marker
  // and cleanup the terminal state instead of waiting until the outer smoke command times out.
  app.exit(0);
}

module.exports = {
  assertLauncherRuntimeVersion,
  runtimeCliVersion,
  terminateLauncherSmoke,
};
