const fs = require("node:fs");
const path = require("node:path");

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

function runtimeInvocation({ app, sourceRoot, installedRuntimeRoot, args }) {
  if (!Array.isArray(args)) throw new Error("Runtime arguments must be an array");
  if (!app.isPackaged) return sourceRuntimeInvocation(sourceRoot, args);

  if (!installedRuntimeRoot || !path.isAbsolute(installedRuntimeRoot)) {
    throw new Error("Packaged launcher runtime has not been installed into durable local storage");
  }
  const { runtimeRoot, executable, entrypoint } = runtimeBundlePaths(installedRuntimeRoot);
  if (!fs.existsSync(executable)) throw new Error(`Bundled Bun runtime is missing: ${executable}`);
  if (!fs.existsSync(entrypoint)) throw new Error(`Bundled runtime entrypoint is missing: ${entrypoint}`);
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

const RUNTIME_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function outputText(value) {
  if (typeof value === "string") return value.trim();
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return "";
}

function runtimePackageVersion(runtimeRoot, fsImpl = fs) {
  if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot)) {
    throw new Error("Installed launcher runtime root must be an absolute path");
  }
  const manifestPath = path.join(runtimeRoot, "app", "package.json");
  let manifest;
  try {
    manifest = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Installed launcher runtime package manifest is invalid: ${manifestPath}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof manifest?.version !== "string" || !RUNTIME_VERSION_PATTERN.test(manifest.version)) {
    throw new Error(
      `Installed launcher runtime package version is invalid: ${JSON.stringify(manifest?.version)}`,
    );
  }
  return manifest.version;
}

function validateRuntimeVersionProbe(runtimeRoot, result, fsImpl = fs) {
  if (result?.error) throw result.error;
  const expectedVersion = runtimePackageVersion(runtimeRoot, fsImpl);
  const stdout = outputText(result?.stdout);
  const stderr = outputText(result?.stderr);
  if (result?.status !== 0 || stdout !== expectedVersion) {
    throw new Error(
      `Installed launcher runtime version probe failed`
      + ` (status=${result?.status ?? "unknown"}, expected=${JSON.stringify(expectedVersion)},`
      + ` stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)})`,
    );
  }
  return expectedVersion;
}

module.exports = {
  embeddedRuntimeInvocation,
  packagedRuntimePaths,
  runtimeBundlePaths,
  runtimeInvocation,
  runtimePackageVersion,
  validateRuntimeVersionProbe,
};
