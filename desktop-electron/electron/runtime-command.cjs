const fs = require("node:fs");
const path = require("node:path");

function runtimeReleaseVersion({ app, sourceRoot, installedRuntimeRoot, runtimeRootProvider }) {
  const root = runtimeRootProvider?.() || installedRuntimeRoot;
  const packagePath = app.isPackaged
    ? root && path.join(root, "app", "package.json")
    : sourceRoot && path.join(sourceRoot, "package.json");
  if (!packagePath || !fs.existsSync(packagePath)) {
    if (app.isPackaged) throw new Error("Bundled bridge package metadata is missing");
    return app.getVersion();
  }
  const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (metadata.name !== "codex-chatgpt-web" || typeof metadata.version !== "string" || !metadata.version.trim()) {
    throw new Error("Bundled bridge package metadata is invalid");
  }
  return metadata.version;
}

function runtimeBundlePaths(runtimeRoot, platform = process.platform) {
  return {
    runtimeRoot,
    executable: path.join(runtimeRoot, "runtime", platform === "win32" ? "bun.exe" : "bun"),
    entrypoint: path.join(runtimeRoot, "app", "cli.js"),
  };
}

function packagedRuntimePaths(resourcesPath, platform = process.platform) {
  return runtimeBundlePaths(path.join(resourcesPath, "runtime"), platform);
}

function sourceRuntimeInvocation(sourceRoot, args) {
  return {
    executable: process.env.CODEX_CHATGPT_WEB_BUN?.trim()
      || process.env.CODEX_WEB_GPT_BUN?.trim()
      || "bun",
    args: ["run", path.join(sourceRoot, "src", "cli.ts"), ...args],
    cwd: sourceRoot,
  };
}

// Installed runtime roots whose bun.exe and cli.js are known to be there: checked here once, or
// handed over by runtime-install.cjs, which stats every file of the bundle (off the main thread at
// launch) before it returns a root. A command for one of them skips the synchronous check, which
// ran for every daemon start, tunnel invocation and bridge ownership check: the existence check of
// bun.exe alone held every window 5.6 s as 0.8.106 started on the busy hard disk (2026-11-10). A root that
// goes missing is found by main's runtime root check (every 30 s, off the main thread), which
// installs it again; until then a start fails at its spawn instead of here.
const checkedRuntimeRoots = new Set();

/** Marks a root whose whole bundle was just verified (ensurePackagedRuntime, preparePackagedRuntime). */
function markRuntimeRootChecked(runtimeRoot) {
  if (typeof runtimeRoot === "string" && path.isAbsolute(runtimeRoot)) checkedRuntimeRoots.add(path.resolve(runtimeRoot));
}

function runtimeInvocation({ app, sourceRoot, installedRuntimeRoot, args }) {
  if (!Array.isArray(args)) throw new Error("Runtime arguments must be an array");
  if (!app.isPackaged) return sourceRuntimeInvocation(sourceRoot, args);

  if (!installedRuntimeRoot || !path.isAbsolute(installedRuntimeRoot)) {
    throw new Error("Packaged launcher runtime has not been installed into durable local storage");
  }
  const { runtimeRoot, executable, entrypoint } = runtimeBundlePaths(installedRuntimeRoot);
  if (!checkedRuntimeRoots.has(path.resolve(installedRuntimeRoot))) {
    if (!fs.existsSync(executable)) throw new Error(`Bundled Bun runtime is missing: ${executable}`);
    if (!fs.existsSync(entrypoint)) throw new Error(`Bundled runtime entrypoint is missing: ${entrypoint}`);
    markRuntimeRootChecked(installedRuntimeRoot);
  }
  return {
    executable,
    args: [entrypoint, ...args],
    cwd: runtimeRoot,
  };
}

function embeddedRuntimeInvocation({ app, sourceRoot, args }) {
  if (!Array.isArray(args)) throw new Error("Runtime arguments must be an array");
  if (!app.isPackaged) return sourceRuntimeInvocation(sourceRoot, args);
  const { runtimeRoot, executable, entrypoint } = packagedRuntimePaths(process.resourcesPath);
  if (!fs.existsSync(executable)) throw new Error(`Embedded Bun runtime is missing: ${executable}`);
  if (!fs.existsSync(entrypoint)) throw new Error(`Embedded runtime entrypoint is missing: ${entrypoint}`);
  return {
    executable,
    args: [entrypoint, ...args],
    cwd: runtimeRoot,
  };
}

module.exports = {
  runtimeReleaseVersion,
  embeddedRuntimeInvocation,
  markRuntimeRootChecked,
  packagedRuntimePaths,
  runtimeBundlePaths,
  runtimeInvocation,
};
