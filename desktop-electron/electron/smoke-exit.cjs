"use strict";

const { runtimePackageVersion } = require("./runtime-release.cjs");

function runtimeCliVersion(runtimeRoot) {
  return runtimePackageVersion(runtimeRoot);
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
