"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawnSync } = require("node:child_process");
const {
  ROUTER_MARKER_NAME,
  ROUTER_REQUIRED_FILES,
  copyTreeDeref,
  cpaArchiveRelative,
  routerSourceRelative,
} = require("../electron/bundled-runtimes.cjs");
const { createRetentionSession } = require("./prepare-package-resources.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const CPA_MANIFEST = require("../vendor/managed-components/cpa.json");
const ROUTER_MANIFEST = require("../vendor/managed-components/codex-router.json");
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function windowsBatchSpawn(executable, args, { platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(String(executable))) {
    return { executable, args };
  }
  return {
    executable: env.ComSpec || process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", executable, ...args],
  };
}

function runChecked(executable, args, options = {}) {
  const { platform, ...spawnOptions } = options;
  const spawned = windowsBatchSpawn(executable, args, {
    platform: platform || process.platform,
    env: spawnOptions.env || process.env,
  });
  const result = spawnSync(spawned.executable, spawned.args, {
    encoding: "utf8",
    windowsHide: true,
    ...spawnOptions,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim().slice(-4_000);
    fail("BUNDLED_RUNTIME_COMMAND_FAILED", `${executable} ${args.join(" ")} (${result.status ?? "unknown"})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

async function downloadFile(url, destination, fetchImpl) {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok || !response.body) fail("BUNDLED_RUNTIME_DOWNLOAD_FAILED", `${url}: HTTP ${response.status}`);
  const length = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(length) && length > MAX_ARCHIVE_BYTES) {
    fail("BUNDLED_RUNTIME_DOWNLOAD_TOO_LARGE", url);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  if (fs.statSync(destination).size > MAX_ARCHIVE_BYTES) fail("BUNDLED_RUNTIME_DOWNLOAD_TOO_LARGE", url);
}

function pythonExecutable(platform, env) {
  const override = String(env.CODING_TOOLS_BUNDLED_PYTHON || "").trim();
  if (override) return override;
  if (platform === "win32") return "py";
  return "python3";
}

function pythonArguments(platform) {
  return platform === "win32" ? ["-3"] : [];
}

function npmExecutable(platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function writeRouterMarker(sourceRoot, {
  platform,
  arch,
  nodeModules,
  pythonVenv,
  controlCenterRenderer,
}) {
  writeJson(path.join(sourceRoot, ROUTER_MARKER_NAME), {
    schemaVersion: 1,
    id: "codex-router",
    version: ROUTER_MANIFEST.version,
    commit: ROUTER_MANIFEST.commit,
    repository: ROUTER_MANIFEST.repository,
    platform,
    arch,
    skipNetworkPrepare: true,
    includes: {
      source: true,
      nodeModules,
      pythonVenv,
      controlCenterRenderer,
    },
  });
}

async function materializeCpaArchive({
  stagingRoot,
  platform,
  arch,
  fetchImpl,
  cacheRoot,
}) {
  const asset = CPA_MANIFEST.platforms?.[platform]?.[arch];
  if (!asset) fail("BUNDLED_RUNTIME_CPA_PLATFORM_UNSUPPORTED", `${platform}/${arch}`);
  const relative = cpaArchiveRelative(platform, arch, asset.fileName);
  const destination = path.join(stagingRoot, ...relative.split("/"));
  const cached = cacheRoot ? path.join(cacheRoot, asset.fileName) : null;
  if (cached && fs.existsSync(cached)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(cached, destination);
  } else {
    await downloadFile(asset.url, destination, fetchImpl);
  }
  const digest = sha256File(destination);
  if (digest !== asset.sha256) fail("BUNDLED_RUNTIME_CPA_DIGEST_MISMATCH", `${asset.fileName}: ${digest}`);
  return { relative, fileName: asset.fileName, sha256: digest };
}

async function materializeRouterSource({
  stagingRoot,
  platform,
  arch,
  fetchImpl,
  env,
  allowIncompletePython,
}) {
  const sourceRoot = path.join(stagingRoot, ...routerSourceRelative().split("/"));
  const archiveName = `codex-router-${ROUTER_MANIFEST.commit}.tar.gz`;
  const archivePath = path.join(stagingRoot, "aiTemp-router-archive", archiveName);
  const archiveUrl = `https://github.com/${ROUTER_MANIFEST.repository}/archive/${ROUTER_MANIFEST.commit}.tar.gz`;
  await downloadFile(archiveUrl, archivePath, fetchImpl);
  const extractRoot = path.join(stagingRoot, "aiTemp-router-extract");
  fs.mkdirSync(extractRoot, { recursive: true, mode: 0o700 });
  runChecked("tar", ["-xf", archivePath, "-C", extractRoot]);
  const extracted = fs.readdirSync(extractRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(extractRoot, entry.name));
  if (extracted.length !== 1) fail("BUNDLED_RUNTIME_ROUTER_ARCHIVE_LAYOUT", JSON.stringify(extracted));
  copyTreeDeref(extracted[0], sourceRoot);
  for (const relative of ROUTER_REQUIRED_FILES) {
    const expected = path.join(sourceRoot, ...relative.split("/"));
    if (!fs.existsSync(expected)) fail("BUNDLED_RUNTIME_ROUTER_FILE_MISSING", relative);
  }

  const npm = npmExecutable(platform);
  runChecked(npm, ["ci", "--omit=dev"], { cwd: sourceRoot, env, stdio: "inherit" });
  let controlCenterRenderer = false;
  const controlCenter = path.join(sourceRoot, "apps", "control-center");
  if (fs.existsSync(path.join(controlCenter, "package.json"))) {
    runChecked(npm, ["ci", "--ignore-scripts"], { cwd: controlCenter, env, stdio: "inherit" });
    runChecked(npm, ["run", "build"], { cwd: controlCenter, env, stdio: "inherit" });
    controlCenterRenderer = fs.existsSync(path.join(controlCenter, "dist", "index.html"));
  }
  if (!controlCenterRenderer) fail("BUNDLED_RUNTIME_CONTROL_CENTER_RENDERER_MISSING", controlCenter);

  let pythonVenv = false;
  try {
    const python = pythonExecutable(platform, env);
    const args = [
      ...pythonArguments(platform),
      "-m",
      "venv",
      path.join(sourceRoot, ".venv"),
    ];
    runChecked(python, args, { cwd: sourceRoot, env, stdio: "inherit" });
    const venvPython = platform === "win32"
      ? path.join(sourceRoot, ".venv", "Scripts", "python.exe")
      : path.join(sourceRoot, ".venv", "bin", "python");
    const requirements = path.join(sourceRoot, "requirements", "python.txt");
    if (fs.existsSync(requirements)) {
      runChecked(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], { cwd: sourceRoot, env, stdio: "inherit" });
      runChecked(venvPython, ["-m", "pip", "install", "--require-hashes", "-r", requirements], {
        cwd: sourceRoot,
        env,
        stdio: "inherit",
      });
    }
    pythonVenv = fs.existsSync(venvPython);
  } catch (error) {
    if (!allowIncompletePython) {
      fail(
        "BUNDLED_RUNTIME_PYTHON_VENV_REQUIRED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const nodeModules = fs.existsSync(path.join(sourceRoot, "node_modules"));
  if (!nodeModules) fail("BUNDLED_RUNTIME_NODE_MODULES_MISSING", sourceRoot);
  writeRouterMarker(sourceRoot, {
    platform,
    arch,
    nodeModules,
    pythonVenv,
    controlCenterRenderer,
  });
  return {
    relative: routerSourceRelative(),
    commit: ROUTER_MANIFEST.commit,
    nodeModules,
    pythonVenv,
    controlCenterRenderer,
  };
}

async function prepareBundledRuntimes(options = {}) {
  const platform = String(options.platform || process.env.CODING_TOOLS_PACKAGE_PLATFORM || process.platform);
  const arch = String(options.arch || process.env.CODING_TOOLS_PACKAGE_ARCH || process.arch);
  const outputRoot = path.resolve(options.outputRoot || path.join(desktopRoot, "build", "bundled-runtimes"));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") fail("BUNDLED_RUNTIME_FETCH_REQUIRED", "fetch");
  const env = options.env || process.env;
  const allowIncompletePython = options.allowIncompletePython === true
    || env.CODING_TOOLS_ALLOW_INCOMPLETE_ROUTER_BUNDLE === "1";
  const session = createRetentionSession({
    repositoryRoot: options.repositoryRoot || repositoryRoot,
    label: "bundled-runtimes",
    now: options.now,
    nonce: options.nonce,
  });
  const stagingRoot = path.join(session.workRoot, "payload");
  fs.mkdirSync(stagingRoot, { recursive: false, mode: 0o700 });
  try {
    const cpa = await materializeCpaArchive({
      stagingRoot,
      platform,
      arch,
      fetchImpl,
      cacheRoot: options.cpaCacheRoot || env.CODING_TOOLS_CPA_ARCHIVE_CACHE || null,
    });
    const router = options.routerSourceRoot
      ? (() => {
        const sourceRoot = path.join(stagingRoot, ...routerSourceRelative().split("/"));
        copyTreeDeref(path.resolve(options.routerSourceRoot), sourceRoot);
        const marker = path.join(sourceRoot, ROUTER_MARKER_NAME);
        if (!fs.existsSync(marker)) {
          writeRouterMarker(sourceRoot, {
            platform,
            arch,
            nodeModules: fs.existsSync(path.join(sourceRoot, "node_modules")),
            pythonVenv: fs.existsSync(path.join(sourceRoot, ".venv")),
            controlCenterRenderer: fs.existsSync(path.join(sourceRoot, "apps", "control-center", "dist", "index.html")),
          });
        }
        return { relative: routerSourceRelative(), commit: ROUTER_MANIFEST.commit };
      })()
      : await materializeRouterSource({
        stagingRoot,
        platform,
        arch,
        fetchImpl,
        env,
        allowIncompletePython,
      });
    writeJson(path.join(stagingRoot, "MANIFEST.json"), {
      schemaVersion: 1,
      platform,
      arch,
      cpa: {
        version: CPA_MANIFEST.version,
        ...cpa,
      },
      "codex-router": {
        version: ROUTER_MANIFEST.version,
        ...router,
      },
    });
    const preservedPath = session.publishDirectory(stagingRoot, outputRoot, "prior-bundled-runtimes");
    return { outputRoot, preservedPath, platform, arch, cpa, router };
  } catch (error) {
    try {
      if (fs.existsSync(stagingRoot)) session.preservePath(stagingRoot, "failed-bundled-runtimes");
    } catch {}
    throw error;
  }
}

if (require.main === module) {
  prepareBundledRuntimes().then((result) => {
    process.stdout.write(`BUNDLED_RUNTIMES_PREPARED ${JSON.stringify({
      outputRoot: result.outputRoot,
      platform: result.platform,
      arch: result.arch,
    })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  npmExecutable,
  prepareBundledRuntimes,
  windowsBatchSpawn,
};
