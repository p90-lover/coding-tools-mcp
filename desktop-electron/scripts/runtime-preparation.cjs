"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function safeSessionId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(value)) {
    fail("RUNTIME_SESSION_ID_INVALID", JSON.stringify(value));
  }
  return value;
}

function uniqueSessionId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

function assertInside(root, target, code) {
  const canonicalRoot = path.resolve(root);
  const canonicalTarget = path.resolve(target);
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return canonicalTarget;
  fail(code, canonicalTarget);
}

function readDesktopVersion(desktopRoot, fsImpl = fs) {
  const manifestPath = path.join(desktopRoot, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(
      "RUNTIME_DESKTOP_MANIFEST_INVALID",
      `${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    fail("RUNTIME_DESKTOP_VERSION_INVALID", JSON.stringify(manifest.version));
  }
  return manifest.version;
}

function resolveRuntimeLayout({ scriptDirectory = __dirname, env = process.env, fsImpl = fs } = {}) {
  const desktopRoot = path.resolve(scriptDirectory, "..");
  const repositoryRoot = path.resolve(desktopRoot, "..");
  const runtimeRoot = path.join(repositoryRoot, "runtime-web");
  const aiTempRoot = path.join(repositoryRoot, "aiTemp");
  const layout = {
    desktopRoot,
    repositoryRoot,
    runtimeRoot,
    output: path.join(desktopRoot, "build", "runtime"),
    workRoot: path.join(aiTempRoot, "work", "runtime-bundle"),
    trashRoot: path.join(aiTempRoot, "Trash", "runtime-bundle"),
    buildScript: "scripts/build-runtime-bundle.ts",
    bun: env.CODEX_WEB_GPT_BUN || process.execPath,
    version: readDesktopVersion(desktopRoot, fsImpl),
    platform: process.platform,
    arch: process.arch,
  };
  assertInside(aiTempRoot, layout.workRoot, "RUNTIME_WORK_ROOT_OUTSIDE_AITEMP");
  assertInside(aiTempRoot, layout.trashRoot, "RUNTIME_TRASH_ROOT_OUTSIDE_AITEMP");
  assertInside(desktopRoot, layout.output, "RUNTIME_OUTPUT_OUTSIDE_DESKTOP");
  return layout;
}

function inspectMovableDirectory(source, fsImpl, code) {
  let metadata;
  try {
    metadata = fsImpl.lstatSync(source);
  } catch (error) {
    fail(code, `${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (metadata.isSymbolicLink()) fail(`${code}_SYMLINK_REJECTED`, source);
  if (!metadata.isDirectory()) fail(`${code}_NOT_DIRECTORY`, source);
}

function unusedDestination(base, fsImpl) {
  if (!fsImpl.existsSync(base)) return base;
  for (let index = 1; index <= 10_000; index += 1) {
    const candidate = `${base}-${String(index).padStart(4, "0")}`;
    if (!fsImpl.existsSync(candidate)) return candidate;
  }
  fail("RUNTIME_RETENTION_DESTINATION_EXHAUSTED", base);
}

function retainDirectory({ source, destinationRoot, sessionId, fsImpl = fs, category }) {
  if (!fsImpl.existsSync(source)) return null;
  inspectMovableDirectory(source, fsImpl, "RUNTIME_RETENTION_SOURCE_INVALID");
  const safeId = safeSessionId(sessionId);
  const root = path.join(destinationRoot, category);
  fsImpl.mkdirSync(root, { recursive: true });
  const destination = unusedDestination(path.join(root, safeId), fsImpl);
  fsImpl.renameSync(source, destination);
  return destination;
}

function publishStagedRuntime({ staged, layout, fsImpl = fs, sessionId }) {
  const safeId = safeSessionId(sessionId);
  inspectMovableDirectory(staged, fsImpl, "RUNTIME_STAGED_OUTPUT_INVALID");
  assertInside(layout.workRoot, staged, "RUNTIME_STAGED_OUTPUT_OUTSIDE_WORK_ROOT");
  assertInside(layout.desktopRoot, layout.output, "RUNTIME_OUTPUT_OUTSIDE_DESKTOP");
  fsImpl.mkdirSync(path.dirname(layout.output), { recursive: true });

  let retainedPrevious = null;
  if (fsImpl.existsSync(layout.output)) {
    retainedPrevious = retainDirectory({
      source: layout.output,
      destinationRoot: layout.trashRoot,
      sessionId: safeId,
      fsImpl,
      category: "previous",
    });
  }

  try {
    fsImpl.renameSync(staged, layout.output);
  } catch (error) {
    let rollbackError = null;
    if (retainedPrevious && !fsImpl.existsSync(layout.output)) {
      try {
        fsImpl.renameSync(retainedPrevious, layout.output);
      } catch (restoreError) {
        rollbackError = restoreError;
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    const rollback = rollbackError
      ? `; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      : "";
    fail("RUNTIME_PUBLICATION_FAILED", `${detail}${rollback}`);
  }

  return {
    output: layout.output,
    retainedPrevious,
  };
}

function defaultRuntimeValidator(staged, identity) {
  const { validateRuntimeBundle } = require("../electron/runtime-install.cjs");
  return validateRuntimeBundle(staged, identity);
}

function prepareRuntime({
  layout = resolveRuntimeLayout(),
  sessionId = uniqueSessionId(),
  spawnSyncImpl = spawnSync,
  validateRuntimeBundle = defaultRuntimeValidator,
  fsImpl = fs,
} = {}) {
  const safeId = safeSessionId(sessionId);
  const aiTempRoot = path.join(layout.repositoryRoot, "aiTemp");
  assertInside(aiTempRoot, layout.workRoot, "RUNTIME_WORK_ROOT_OUTSIDE_AITEMP");
  assertInside(aiTempRoot, layout.trashRoot, "RUNTIME_TRASH_ROOT_OUTSIDE_AITEMP");
  assertInside(layout.desktopRoot, layout.output, "RUNTIME_OUTPUT_OUTSIDE_DESKTOP");

  if (!fsImpl.existsSync(layout.runtimeRoot) || !fsImpl.statSync(layout.runtimeRoot).isDirectory()) {
    fail("RUNTIME_SOURCE_ROOT_MISSING", layout.runtimeRoot);
  }
  const buildScriptPath = path.join(layout.runtimeRoot, ...layout.buildScript.split("/"));
  if (!fsImpl.existsSync(buildScriptPath) || !fsImpl.statSync(buildScriptPath).isFile()) {
    fail("RUNTIME_BUILD_SCRIPT_MISSING", buildScriptPath);
  }

  fsImpl.mkdirSync(layout.workRoot, { recursive: true });
  const staged = path.join(layout.workRoot, safeId);
  assertInside(layout.workRoot, staged, "RUNTIME_STAGED_OUTPUT_OUTSIDE_WORK_ROOT");
  if (fsImpl.existsSync(staged)) fail("RUNTIME_STAGED_OUTPUT_ALREADY_EXISTS", staged);

  const result = spawnSyncImpl(
    layout.bun,
    ["run", layout.buildScript, staged],
    {
      cwd: layout.runtimeRoot,
      env: process.env,
      stdio: "inherit",
      shell: false,
    },
  );

  if (result?.error || result?.status !== 0) {
    const retained = retainDirectory({
      source: staged,
      destinationRoot: layout.trashRoot,
      sessionId: safeId,
      fsImpl,
      category: "failures",
    });
    const detail = result?.error instanceof Error
      ? result.error.message
      : `status=${result?.status ?? "unknown"}`;
    fail("RUNTIME_BUILD_FAILED", `${detail}; retained=${retained ?? "none"}`);
  }

  try {
    validateRuntimeBundle(staged, {
      version: layout.version,
      platform: layout.platform,
      arch: layout.arch,
    });
  } catch (error) {
    const retained = retainDirectory({
      source: staged,
      destinationRoot: layout.trashRoot,
      sessionId: safeId,
      fsImpl,
      category: "failures",
    });
    fail(
      "RUNTIME_VALIDATION_FAILED",
      `${error instanceof Error ? error.message : String(error)}; retained=${retained ?? "none"}`,
    );
  }

  return publishStagedRuntime({ staged, layout, fsImpl, sessionId: safeId });
}

module.exports = {
  prepareRuntime,
  publishStagedRuntime,
  resolveRuntimeLayout,
};
