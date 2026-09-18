"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createRetentionSession, PRODUCT_VERSION } = require("./prepare-package-resources.cjs");

const COMPONENT_IDS = Object.freeze([
  "codex-router",
  "commandcode-proxy",
  "cpa",
  "paseo",
  "anneal",
]);
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail("FIVE_STACK_MANIFEST_INVALID", `${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
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

function copyTree(sourceRoot, destinationRoot) {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    let metadata;
    try { metadata = fs.statSync(from); }
    catch (error) {
      fail("FIVE_STACK_BUNDLE_ENTRY_UNREADABLE", `${from}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (metadata.isDirectory()) {
      copyTree(from, to);
      continue;
    }
    if (!metadata.isFile()) fail("FIVE_STACK_BUNDLE_ENTRY_UNSUPPORTED", from);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(to, metadata.mode & 0o777 || 0o600);
  }
}

function runGit(args, cwd, spawnSyncProcess) {
  const result = spawnSyncProcess("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 10 * 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail("FIVE_STACK_GIT_FAILED", `${args.join(" ")}: ${String(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

function selectedReleaseAsset(manifest, platform, arch) {
  const asset = manifest.platforms?.[platform]?.[arch];
  if (!asset || typeof asset.fileName !== "string" || !SHA256.test(String(asset.sha256 || ""))) {
    fail("FIVE_STACK_RELEASE_ASSET_MISSING", `${manifest.id} ${platform}/${arch}`);
  }
  return asset;
}

async function downloadFile(url, destination, fetchImpl) {
  if (typeof fetchImpl !== "function") fail("FIVE_STACK_DOWNLOAD_UNAVAILABLE", url);
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok || !response.body) fail("FIVE_STACK_DOWNLOAD_FAILED", `HTTP ${response.status} ${url}`);
  const length = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(length) && length > MAX_ASSET_BYTES) fail("FIVE_STACK_DOWNLOAD_TOO_LARGE", url);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ASSET_BYTES) fail("FIVE_STACK_DOWNLOAD_TOO_LARGE", url);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
}

function cachedSource(cacheRoot, id) {
  if (!cacheRoot) return null;
  const nested = path.join(cacheRoot, id, "source");
  if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) return nested;
  return null;
}

function cachedRelease(cacheRoot, id, fileName) {
  if (!cacheRoot) return null;
  const candidate = path.join(cacheRoot, id, fileName);
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  return null;
}

function shouldPrepareDependencies(options) {
  if (options.prepareDependencies === true) return true;
  if (options.prepareDependencies === false) return false;
  if (String(process.env.CODING_TOOLS_PREPARE_FIVE_STACK_DEPS || "").trim() === "1") return true;
  return require.main === module;
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function envPathKey(env, platform = process.platform) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path")
    || (platform === "win32" ? "Path" : "PATH");
}

function envPathDelimiter(platform = process.platform) {
  return platform === "win32" ? ";" : ":";
}

function envPathParts(env, platform = process.platform) {
  const delimiter = envPathDelimiter(platform);
  const values = [];
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "path" && value) values.push(String(value));
  }
  if (values.length === 0) {
    const fallback = env[envPathKey(env, platform)];
    if (fallback) values.push(String(fallback));
  }
  return values.flatMap((chunk) => chunk.split(delimiter)).filter(Boolean);
}

function nodeExecutableName(platform = process.platform) {
  return platform === "win32" ? "node.exe" : "node";
}

function isBunExecutable(filePath) {
  return /^bun(\.exe)?$/i.test(path.basename(filePath || ""));
}

function directoryHasBun(dir, platform = process.platform) {
  return isFile(path.join(dir, platform === "win32" ? "bun.exe" : "bun"));
}

function resolveNodeExecutable(env = process.env, platform = process.platform) {
  const nodeName = nodeExecutableName(platform);
  for (const key of ["CODING_TOOLS_NODE_EXE", "npm_node_execpath"]) {
    const candidate = env[key];
    if (candidate && isFile(candidate) && !isBunExecutable(candidate)) return candidate;
  }
  const searchDirs = [...envPathParts(env, platform)];
  if (
    !isBunExecutable(process.execPath)
    && !directoryHasBun(path.dirname(process.execPath), platform)
    && new RegExp(`^${nodeName}$`, "i").test(path.basename(process.execPath))
  ) {
    searchDirs.unshift(path.dirname(process.execPath));
  }
  for (const dir of searchDirs) {
    if (directoryHasBun(dir, platform)) continue;
    const candidate = path.join(dir, nodeName);
    if (isFile(candidate) && !isBunExecutable(candidate)) return candidate;
  }
  return null;
}

function resolveNpmExecutable(env = process.env, platform = process.platform) {
  const names = platform === "win32" ? ["npm.cmd", "npm.CMD", "npm"] : ["npm"];
  const nodeExecutable = resolveNodeExecutable(env, platform);
  const searchDirs = [];
  if (nodeExecutable) searchDirs.push(path.dirname(nodeExecutable));
  searchDirs.push(...envPathParts(env, platform));
  for (const dir of searchDirs) {
    if (directoryHasBun(dir, platform)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate) && !isBunExecutable(candidate)) return candidate;
    }
  }
  return platform === "win32" ? "npm.cmd" : "npm";
}

function withNpmOnPath(env = process.env, platform = process.platform) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === "path") delete next[key];
  }
  const nodeExecutable = resolveNodeExecutable(env, platform);
  const npmExecutable = resolveNpmExecutable(env, platform);
  const extras = [];
  if (nodeExecutable) extras.push(path.dirname(nodeExecutable));
  if (path.isAbsolute(npmExecutable)) extras.push(path.dirname(npmExecutable));
  const merged = [];
  for (const dir of [...extras, ...envPathParts(env, platform)]) {
    const resolved = path.resolve(dir);
    if (!merged.some((existing) => path.resolve(existing) === resolved)) merged.push(dir);
  }
  const mergedPath = merged.join(envPathDelimiter(platform));
  if (platform === "win32") {
    next.Path = mergedPath;
    next.PATH = mergedPath;
    const pathext = String(next.PATHEXT || next.Pathext || "");
    if (!pathext.toUpperCase().includes(".EXE")) {
      next.PATHEXT = pathext ? `.COM;.EXE;.BAT;.CMD;${pathext}` : ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.MSC";
    }
  } else {
    next.PATH = mergedPath;
  }
  if (nodeExecutable) {
    next.npm_node_execpath = nodeExecutable;
    next.NODE = nodeExecutable;
    next.npm_config_scripts_prepend_node_path = "true";
  }
  return next;
}

function quoteCmdToken(value) {
  const text = String(value);
  if (!/[\s"&()<>^|!]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function npmSpawnInvocation(args, platform = process.platform, env = process.env) {
  const options = {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30 * 60_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: withNpmOnPath(env, platform),
  };
  if (platform === "win32") {
    const resolved = resolveNpmExecutable(env, platform);
    const npmCmd = /\.cmd$/i.test(resolved) ? resolved : "npm.cmd";
    const npmCommand = ["call", quoteCmdToken(npmCmd), ...args.map(quoteCmdToken)].join(" ");
    const mergedPath = options.env.Path || options.env.PATH || "";
    const commandLine = mergedPath
      ? `set "PATH=${mergedPath}" && ${npmCommand}`
      : npmCommand;
    return {
      command: env.ComSpec || process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
      options,
    };
  }
  return {
    command: resolveNpmExecutable(env, platform),
    args: [...args],
    options,
  };
}

function runNpm(sourceRoot, args, spawnSyncProcess, code, platform = process.platform) {
  const invocation = npmSpawnInvocation(args, platform);
  const result = spawnSyncProcess(invocation.command, invocation.args, {
    cwd: sourceRoot,
    ...invocation.options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(code, String(result.stderr || result.stdout || "").trim());
  }
}

function maybePrepareDependencies(sourceRoot, spawnSyncProcess, extraScripts = []) {
  if (!fs.existsSync(path.join(sourceRoot, "package.json"))) return false;
  runNpm(sourceRoot, ["ci"], spawnSyncProcess, "FIVE_STACK_NPM_CI_FAILED");
  for (const script of extraScripts) {
    runNpm(sourceRoot, ["run", script], spawnSyncProcess, "FIVE_STACK_NPM_BUILD_FAILED");
  }
  return true;
}

function writeBundledMarker(destination, manifest) {
  const marker = path.join(destination, "CODING_TOOLS_BUNDLED.json");
  if (fs.existsSync(marker)) return;
  writeJson(marker, {
    schemaVersion: 1,
    id: manifest.id,
    version: manifest.version,
    skipNetworkPrepare: true,
  });
}

async function materializeComponent({
  manifest,
  outputRoot,
  cacheRoot,
  workRoot,
  platform,
  arch,
  fetchImpl,
  spawnSyncProcess,
  prepareDependencies,
  now,
}) {
  const componentRoot = path.join(outputRoot, manifest.id);
  fs.mkdirSync(componentRoot, { recursive: true, mode: 0o700 });
  const record = {
    schemaVersion: 1,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    commit: manifest.commit || null,
    strategy: manifest.strategy,
    preparedAt: typeof now === "function" ? now() : now,
  };

  if (manifest.strategy === "release-binary") {
    const asset = selectedReleaseAsset(manifest, platform, arch);
    const destination = path.join(componentRoot, asset.fileName);
    const cached = cachedRelease(cacheRoot, manifest.id, asset.fileName);
    if (cached) fs.copyFileSync(cached, destination, fs.constants.COPYFILE_EXCL);
    else await downloadFile(asset.url, destination, fetchImpl);
    const digest = sha256File(destination);
    if (digest !== asset.sha256) fail("FIVE_STACK_RELEASE_DIGEST_MISMATCH", `${asset.fileName}: ${digest}`);
    record.fileName = asset.fileName;
    record.sha256 = digest;
    writeBundledMarker(componentRoot, manifest);
  } else {
    if (!COMMIT_SHA.test(String(manifest.commit || ""))) {
      fail("FIVE_STACK_COMMIT_UNPINNED", manifest.id);
    }
    const sourceDestination = path.join(componentRoot, "source");
    const cached = cachedSource(cacheRoot, manifest.id);
    if (cached) {
      copyTree(cached, sourceDestination);
    } else {
      const cloneRoot = path.join(workRoot, `${manifest.id}-git`);
      fs.mkdirSync(cloneRoot, { recursive: true, mode: 0o700 });
      runGit(["clone", "--filter=blob:none", "--no-checkout", manifest.repositoryUrl, cloneRoot], workRoot, spawnSyncProcess);
      runGit(["fetch", "--depth", "1", "origin", manifest.commit], cloneRoot, spawnSyncProcess);
      runGit(["checkout", "--detach", manifest.commit], cloneRoot, spawnSyncProcess);
      copyTree(cloneRoot, sourceDestination);
    }
    if (prepareDependencies) {
      if (manifest.id === "paseo") maybePrepareDependencies(sourceDestination, spawnSyncProcess, ["build:server"]);
      if (manifest.id === "anneal") maybePrepareDependencies(sourceDestination, spawnSyncProcess, ["build"]);
      if (manifest.id === "codex-router") {
        maybePrepareDependencies(path.join(sourceDestination, "apps", "control-center"), spawnSyncProcess, ["build"]);
      }
    }
    writeBundledMarker(sourceDestination, manifest);
    record.source = "source";
  }

  writeJson(path.join(componentRoot, "BUNDLE.json"), record);
  return record;
}

async function prepareFiveStackRuntime(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot || path.join(__dirname, "..", ".."));
  const desktopRoot = path.resolve(options.desktopRoot || path.join(repositoryRoot, "desktop-electron"));
  const manifestRoot = path.resolve(options.manifestRoot || path.join(desktopRoot, "vendor", "managed-components"));
  const outputRoot = path.resolve(options.outputRoot || path.join(desktopRoot, "build", "five-stack-runtime"));
  const cacheRoot = options.cacheRoot || process.env.CODING_TOOLS_FIVE_STACK_CACHE || null;
  const platform = String(options.platform || process.env.CODING_TOOLS_PACKAGE_PLATFORM || process.platform);
  const arch = String(options.arch || process.env.CODING_TOOLS_PACKAGE_ARCH || process.arch);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const spawnSyncProcess = options.spawnSyncProcess || spawnSync;
  const prepareDependencies = shouldPrepareDependencies(options);
  const now = options.now || (() => new Date().toISOString());

  const session = createRetentionSession({
    repositoryRoot,
    label: "five-stack-runtime",
    now: typeof now === "function" ? () => new Date(now()) : now,
    nonce: options.nonce,
  });
  const stagingRoot = path.join(session.workRoot, "payload");
  fs.mkdirSync(stagingRoot, { recursive: false, mode: 0o700 });

  try {
    const components = [];
    for (const id of COMPONENT_IDS) {
      const manifest = readJson(path.join(manifestRoot, `${id}.json`), id);
      if (manifest.id !== id) fail("FIVE_STACK_MANIFEST_ID_MISMATCH", id);
      components.push(await materializeComponent({
        manifest,
        outputRoot: stagingRoot,
        cacheRoot,
        workRoot: session.workRoot,
        platform,
        arch,
        fetchImpl,
        spawnSyncProcess,
        prepareDependencies,
        now,
      }));
    }
    writeJson(path.join(stagingRoot, "MANIFEST.json"), {
      schemaVersion: 1,
      productVersion: PRODUCT_VERSION,
      platform,
      arch,
      preparedAt: typeof now === "function" ? now() : now,
      components,
    });
    const preservedPath = session.publishDirectory(stagingRoot, outputRoot, "prior-five-stack-runtime");
    return {
      outputRoot,
      preservedPath,
      platform,
      arch,
      componentIds: components.map((component) => component.id),
      trashRoot: session.trashRoot,
    };
  } catch (error) {
    let retentionError = null;
    try {
      if (fs.existsSync(stagingRoot)) session.preservePath(stagingRoot, "failed-five-stack-runtime");
    } catch (failure) {
      retentionError = failure;
    }
    if (retentionError) {
      throw new AggregateError([error, retentionError], "Five-stack runtime preparation and evidence retention both failed");
    }
    throw error;
  }
}

if (require.main === module) {
  prepareFiveStackRuntime().then((result) => {
    process.stdout.write(`FIVE_STACK_RUNTIME_PREPARED ${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  COMPONENT_IDS,
  npmSpawnInvocation,
  prepareFiveStackRuntime,
};
