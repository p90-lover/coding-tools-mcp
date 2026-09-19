"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function runtimePackageVersion(runtimeRoot) {
  if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot)) {
    throw new TypeError("Runtime package version requires an absolute runtime root");
  }
  const packagePath = path.join(runtimeRoot, "app", "package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Installed runtime package metadata is invalid: ${packagePath}: ${errorMessage(error)}`,
    );
  }
  const version = typeof packageJson?.version === "string" ? packageJson.version.trim() : "";
  if (!RUNTIME_VERSION.test(version)) {
    throw new Error(`Installed runtime package version is invalid: ${JSON.stringify(version)}`);
  }
  return version;
}

function tryRuntimePackageVersion(runtimeRoot) {
  try {
    return runtimePackageVersion(runtimeRoot);
  } catch {
    return null;
  }
}

function launcherVersion(app) {
  const version = typeof app?.getVersion === "function" ? app.getVersion() : null;
  if (typeof version === "string" && RUNTIME_VERSION.test(version.trim())) return version.trim();
  return null;
}

function resolveExpectedRuntimeRelease({
  app,
  installedRuntimeRoot,
  runtimeRootProvider,
  expectedRuntimeRelease,
} = {}) {
  if (typeof expectedRuntimeRelease === "string" && expectedRuntimeRelease.trim()) {
    const version = expectedRuntimeRelease.trim();
    if (!RUNTIME_VERSION.test(version)) {
      throw new Error(`Expected runtime release version is invalid: ${JSON.stringify(version)}`);
    }
    return version;
  }

  let runtimeRoot = installedRuntimeRoot;
  if (typeof runtimeRootProvider === "function") {
    try {
      const provided = runtimeRootProvider();
      if (typeof provided === "string" && provided) runtimeRoot = provided;
    } catch {
      // Keep any previously installed root when the provider is still materializing.
    }
  }

  const fromInstalled = tryRuntimePackageVersion(runtimeRoot);
  if (fromInstalled) return fromInstalled;

  const fromLauncher = launcherVersion(app);
  if (fromLauncher) return fromLauncher;
  throw new Error("Expected runtime release version could not be resolved");
}

module.exports = {
  RUNTIME_VERSION,
  resolveExpectedRuntimeRelease,
  runtimePackageVersion,
};
