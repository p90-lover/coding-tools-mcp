"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
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

function copyTreeAcyclic(sourceRoot, destinationRoot, seen, options = {}) {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  let real;
  try {
    real = fs.realpathSync(source);
  } catch (error) {
    fail("FIVE_STACK_BUNDLE_ENTRY_UNREADABLE", `${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let metadata;
  try {
    metadata = fs.statSync(source);
  } catch (error) {
    fail("FIVE_STACK_BUNDLE_ENTRY_UNREADABLE", `${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (metadata.isDirectory()) {
    if (seen.has(real)) return;
    const nextSeen = new Set(seen);
    nextSeen.add(real);
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      if (options.skipNodeModules && entry.name === "node_modules") continue;
      copyTreeAcyclic(path.join(source, entry.name), path.join(destination, entry.name), nextSeen, options);
    }
    return;
  }
  if (!metadata.isFile()) fail("FIVE_STACK_BUNDLE_ENTRY_UNSUPPORTED", source);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, metadata.mode & 0o777 || 0o600);
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

function isUsableNodeExecutable(filePath, platform = process.platform) {
  if (!filePath || !isFile(filePath) || isBunExecutable(filePath)) return false;
  if (directoryHasBun(path.dirname(filePath), platform)) return false;
  return /^node(\.exe)?$/i.test(path.basename(filePath));
}

function extraNodeSearchDirs(env = process.env, platform = process.platform) {
  if (platform !== "win32") return [];
  const dirs = [];
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files";
  dirs.push(path.join(programFiles, "nodejs"));
  const toolcache = env.RUNNER_TOOL_CACHE;
  if (!toolcache) return dirs;
  const nodeRoot = path.join(toolcache, "node");
  let versions = [];
  try {
    versions = fs.readdirSync(nodeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    return dirs;
  }
  for (const version of versions) {
    const versionDir = path.join(nodeRoot, version);
    let arches = [];
    try {
      arches = fs.readdirSync(versionDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const arch of arches) dirs.push(path.join(versionDir, arch.name));
  }
  return dirs;
}

function resolveNodeExecutable(env = process.env, platform = process.platform) {
  const nodeName = nodeExecutableName(platform);
  for (const key of ["CODING_TOOLS_NODE_EXE", "npm_node_execpath"]) {
    if (isUsableNodeExecutable(env[key], platform)) return env[key];
  }
  const searchDirs = [...envPathParts(env, platform)];
  if (isUsableNodeExecutable(process.execPath, platform)) {
    searchDirs.unshift(path.dirname(process.execPath));
  }
  searchDirs.push(...extraNodeSearchDirs(env, platform));
  for (const dir of searchDirs) {
    if (directoryHasBun(dir, platform)) continue;
    const candidate = path.join(dir, nodeName);
    if (isUsableNodeExecutable(candidate, platform)) return candidate;
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

function resolveNpmCliJs(nodeExecutable) {
  if (!nodeExecutable || !isFile(nodeExecutable)) return null;
  const dir = path.dirname(nodeExecutable);
  const candidates = [
    path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (isFile(candidate)) return path.resolve(candidate);
  }
  return null;
}

function ensureWindowsNodeShims(nodeExecutable, npmExecutable, env = process.env, platform = process.platform) {
  if (platform !== "win32" || !nodeExecutable || !isFile(nodeExecutable)) return null;
  const root = env.CODING_TOOLS_RETENTION_ROOT || env.TEMP || env.TMP || os.tmpdir();
  const shimDir = path.join(String(root), "coding-tools-node-shims");
  fs.mkdirSync(shimDir, { recursive: true });
  const nodeBody = `@echo off\r\n"${nodeExecutable}" %*\r\n`;
  fs.writeFileSync(path.join(shimDir, "node.cmd"), nodeBody);
  fs.writeFileSync(path.join(shimDir, "node.bat"), nodeBody);
  if (npmExecutable && path.isAbsolute(npmExecutable) && isFile(npmExecutable)) {
    const npmBody = `@echo off\r\ncall "${npmExecutable}" %*\r\n`;
    fs.writeFileSync(path.join(shimDir, "npm.cmd"), npmBody);
    fs.writeFileSync(path.join(shimDir, "npm.bat"), npmBody);
  }
  return shimDir;
}

function withNpmOnPath(env = process.env, platform = process.platform, sourceRoot = null) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === "path") delete next[key];
  }
  const nodeExecutable = resolveNodeExecutable(env, platform);
  const npmExecutable = resolveNpmExecutable(env, platform);
  const shimDir = ensureWindowsNodeShims(nodeExecutable, npmExecutable, env, platform);
  const extras = [];
  if (shimDir) extras.push(shimDir);
  if (nodeExecutable) extras.push(path.dirname(nodeExecutable));
  if (path.isAbsolute(npmExecutable)) extras.push(path.dirname(npmExecutable));
  if (sourceRoot) extras.push(...npmBinDirectories(sourceRoot));
  const merged = [];
  for (const dir of [...extras, ...envPathParts(env, platform)]) {
    const resolved = path.resolve(dir);
    if (!merged.some((existing) => path.resolve(existing) === resolved)) merged.push(dir);
  }
  const mergedPath = merged.join(envPathDelimiter(platform));
  // Node's Windows spawn keeps the lexicographically first PATH key (PATH < Path).
  // An empty uppercase PATH plus a good Path drops the good value, so nested
  // cmd.exe cannot find node. Always pass a single uppercase PATH.
  next.PATH = mergedPath;
  if (platform === "win32") {
    const pathext = String(env.PATHEXT || env.Pathext || "");
    next.PATHEXT = pathext.toUpperCase().includes(".CMD") && pathext.toUpperCase().includes(".EXE")
      ? pathext
      : `.COM;.EXE;.BAT;.CMD;${pathext}`;
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

function windowsCmdWithInjectedPath(commandLine, options, env) {
  // bun/libuv on Windows can spawn cmd.exe with an empty PATH even when
  // options.env.PATH is set. `set PATH=` runs inside cmd after spawn, so
  // nested npm/tsc/node lookups see the managed path instead of CWD shims.
  const pathValue = String(options.env?.PATH || "");
  const injected = pathValue
    ? `set "PATH=${pathValue}" && ${commandLine}`
    : commandLine;
  return {
    command: env.ComSpec || process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${injected}"`],
    options: {
      ...options,
      windowsVerbatimArguments: true,
    },
  };
}

function npmSpawnInvocation(args, platform = process.platform, env = process.env, sourceRoot = null) {
  const options = {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30 * 60_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: withNpmOnPath(env, platform, sourceRoot),
  };
  if (platform === "win32") {
    const nodeExecutable = resolveNodeExecutable(env, platform);
    const npmCli = resolveNpmCliJs(nodeExecutable);
    if (nodeExecutable && npmCli) {
      const commandLine = [
        quoteCmdToken(nodeExecutable),
        quoteCmdToken(npmCli),
        ...args.map(quoteCmdToken),
      ].join(" ");
      return windowsCmdWithInjectedPath(commandLine, {
        ...options,
        env: {
          ...options.env,
          npm_execpath: npmCli,
        },
      }, env);
    }
    const resolved = resolveNpmExecutable(env, platform);
    const npmCmd = /\.cmd$/i.test(resolved) ? resolved : "npm.cmd";
    const commandLine = ["call", quoteCmdToken(npmCmd), ...args.map(quoteCmdToken)].join(" ");
    return windowsCmdWithInjectedPath(commandLine, options, env);
  }
  return {
    command: resolveNpmExecutable(env, platform),
    args: [...args],
    options,
  };
}

function runNpm(sourceRoot, args, spawnSyncProcess, code, platform = process.platform) {
  const invocation = npmSpawnInvocation(args, platform, process.env, sourceRoot);
  const result = spawnSyncProcess(invocation.command, invocation.args, {
    cwd: sourceRoot,
    ...invocation.options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(code, String(result.stderr || result.stdout || "").trim());
  }
}

function withAbsoluteNodeCommand(script, nodeExecutable) {
  const exe = String(nodeExecutable);
  // cmd.exe /s strips a leading/trailing quote pair, so quoted Program Files
  // paths break. Leave `node` in place when quoting would be required; CWD
  // node.cmd shims cover that case. Safe unquoted paths work with an empty PATH.
  if (/[\s"&()<>^|!]/.test(exe)) return String(script);
  return String(script).replace(/(^|[\s|&;])node(?:\.exe)?(?=\s|$)/gi, `$1${exe}`);
}

function withAbsoluteNpmCommand(script, npmExecutable) {
  const exe = String(npmExecutable);
  if (/[\s"&()<>^|!]/.test(exe)) return String(script);
  return String(script).replace(/(^|[\s|&;])npm(?:\.cmd)?(?=\s|$)/gi, `$1${exe}`);
}

function rewritePackageScriptsToAbsoluteNode(sourceRoot, nodeExecutable, npmExecutable) {
  if (!nodeExecutable || !isFile(nodeExecutable)) return 0;
  let rewritten = 0;
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (entry.name !== "package.json") continue;
      let pkg;
      try {
        pkg = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {
        continue;
      }
      if (!pkg || typeof pkg.scripts !== "object" || pkg.scripts === null) continue;
      let changed = false;
      for (const [name, value] of Object.entries(pkg.scripts)) {
        if (typeof value !== "string") continue;
        let next = withAbsoluteNodeCommand(value, nodeExecutable);
        if (npmExecutable && isFile(npmExecutable)) {
          next = withAbsoluteNpmCommand(next, npmExecutable);
        }
        if (next === value) continue;
        pkg.scripts[name] = next;
        changed = true;
      }
      if (!changed) continue;
      fs.writeFileSync(full, `${JSON.stringify(pkg, null, 2)}\n`);
      rewritten += 1;
    }
  };
  visit(sourceRoot);
  return rewritten;
}

function npmBinDirectories(sourceRoot) {
  const bins = [path.join(sourceRoot, "node_modules", ".bin")];
  for (const folder of ["packages", "apps"]) {
    const parent = path.join(sourceRoot, folder);
    if (!fs.existsSync(parent)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) bins.push(path.join(parent, entry.name, "node_modules", ".bin"));
    }
  }
  return bins;
}

function installWindowsNodeBinShims(sourceRoot, env = process.env, platform = process.platform) {
  if (platform !== "win32") return [];
  const nodeExecutable = resolveNodeExecutable(env, platform);
  if (!nodeExecutable || !isFile(nodeExecutable)) return [];
  const npmExecutable = resolveNpmExecutable(env, platform);
  const nodeBody = `@echo off\r\n"${nodeExecutable}" %*\r\n`;
  const npmBody = npmExecutable && isFile(npmExecutable)
    ? `@echo off\r\ncall "${npmExecutable}" %*\r\n`
    : null;
  const written = [];
  for (const bin of npmBinDirectories(sourceRoot)) {
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
    const cmd = path.join(bin, "node.cmd");
    fs.writeFileSync(cmd, nodeBody);
    fs.writeFileSync(path.join(bin, "node.bat"), nodeBody);
    written.push(cmd);
    if (npmBody) {
      const npmCmd = path.join(bin, "npm.cmd");
      fs.writeFileSync(npmCmd, npmBody);
      fs.writeFileSync(path.join(bin, "npm.bat"), npmBody);
      written.push(npmCmd);
    }
  }
  return written;
}

function packageJsonDirectories(sourceRoot) {
  const dirs = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (isFile(path.join(dir, "package.json"))) dirs.push(dir);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      visit(path.join(dir, entry.name));
    }
  };
  visit(sourceRoot);
  return dirs;
}

function cmdShimBody(lines) {
  return ["@echo off", ...lines, ""].join("\r\n");
}

function writeCmdPair(fileBase, body, written) {
  const cmd = `${fileBase}.cmd`;
  const bat = `${fileBase}.bat`;
  fs.writeFileSync(cmd, body);
  fs.writeFileSync(bat, body);
  written.push(cmd, bat);
}

function installWindowsCwdNodeCommands(sourceRoot, env = process.env, platform = process.platform) {
  if (platform !== "win32") return [];
  const nodeExecutable = resolveNodeExecutable(env, platform);
  if (!nodeExecutable || !isFile(nodeExecutable)) return [];
  const nodeDir = path.dirname(nodeExecutable);
  const npmCli = resolveNpmCliJs(nodeExecutable);
  const npmExecutable = resolveNpmExecutable(env, platform);
  const rootBin = path.join(sourceRoot, "node_modules", ".bin");
  const nodeBody = cmdShimBody([`"${nodeExecutable}" %*`]);
  const written = [];
  for (const dir of packageJsonDirectories(sourceRoot)) {
    const localBin = path.join(dir, "node_modules", ".bin");
    const pathLine = `set "PATH=${nodeDir};${rootBin};${localBin};%PATH%"`;
    writeCmdPair(path.join(dir, "node"), nodeBody, written);
    let npmBody = null;
    if (npmCli) {
      npmBody = cmdShimBody([pathLine, `"${nodeExecutable}" "${npmCli}" %*`]);
    } else if (path.isAbsolute(npmExecutable) && isFile(npmExecutable)) {
      npmBody = cmdShimBody([pathLine, `call "${npmExecutable}" %*`]);
    }
    if (npmBody) writeCmdPair(path.join(dir, "npm"), npmBody, written);
  }
  return written;
}

function installWindowsCwdLifecycleFallbacks(sourceRoot, platform = process.platform) {
  if (platform !== "win32") return [];
  const reserved = new Set(["node.cmd", "node.bat", "npm.cmd", "npm.bat"]);
  const tools = new Map();
  for (const bin of npmBinDirectories(sourceRoot)) {
    let names = [];
    try {
      names = fs.readdirSync(bin);
    } catch {
      continue;
    }
    for (const name of names) {
      const lower = name.toLowerCase();
      if (!/\.(cmd|bat)$/i.test(name) || reserved.has(lower) || tools.has(lower)) continue;
      const abs = path.join(bin, name);
      if (isFile(abs)) tools.set(lower, { name, abs });
    }
  }
  const written = [];
  for (const dir of packageJsonDirectories(sourceRoot)) {
    for (const { name, abs } of tools.values()) {
      const dest = path.join(dir, name);
      if (path.resolve(dest) === path.resolve(abs)) continue;
      // Copying npm .bin shims breaks %~dp0; call the original by absolute path.
      fs.writeFileSync(dest, cmdShimBody([`call "${abs}" %*`]));
      written.push(dest);
    }
  }
  return written;
}

function removeWrittenFiles(files) {
  for (const file of files) {
    try {
      fs.unlinkSync(file);
    } catch {
      // prepare-only Windows shims must not ship CI node.exe paths
    }
  }
}

function hostNpmPrepareAllowed(manifest, platform) {
  const mode = String(manifest?.platformModes?.[platform] || "native").trim().toLowerCase();
  return mode !== "wsl2";
}

function maybePrepareDependencies(sourceRoot, spawnSyncProcess, extraScripts = []) {
  if (!fs.existsSync(path.join(sourceRoot, "package.json"))) return false;
  const nodeExecutable = resolveNodeExecutable();
  const npmExecutable = resolveNpmExecutable();
  const cleanup = [];
  const track = (files) => {
    cleanup.push(...files);
  };
  try {
    track(installWindowsCwdNodeCommands(sourceRoot));
  if (nodeExecutable) rewritePackageScriptsToAbsoluteNode(sourceRoot, nodeExecutable, npmExecutable);
  // Native addons such as anneal's fs-ext need node-gyp/VS. windows-2025 ships
  // Visual Studio 18, which node-gyp 11 cannot use. Skip install scripts and run
  // the explicit JS build afterwards.
  runNpm(sourceRoot, ["ci", "--ignore-scripts"], spawnSyncProcess, "FIVE_STACK_NPM_CI_FAILED");
    track(installWindowsNodeBinShims(sourceRoot));
    track(installWindowsCwdNodeCommands(sourceRoot));
    track(installWindowsCwdLifecycleFallbacks(sourceRoot));
    for (const script of extraScripts) {
      runNpm(sourceRoot, ["run", script], spawnSyncProcess, "FIVE_STACK_NPM_BUILD_FAILED");
    }
    // Windows npm workspace junctions keep absolute targets. publishDirectory
    // renames the staging tree afterward, which would leave @scope/name dangling.
    materializeNpmWorkspaceLinks(sourceRoot);
  } finally {
    removeWrittenFiles(cleanup);
  }
  return true;
}

function unlinkFilesystemLink(pathname) {
  // Replace a workspace junction/symlink in place. Payload files stay; only the
  // reparse point is removed so publishDirectory rename cannot dangle it.
  try {
    fs.unlinkSync(pathname);
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EISDIR")) {
      fs.rmdirSync(pathname);
      return;
    }
    throw error;
  }
}

function materializeNpmWorkspaceLinks(root) {
  const stack = [path.resolve(root)];
  const seen = new Set();
  while (stack.length > 0) {
    const dir = stack.pop();
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      let linkStat;
      try {
        linkStat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (linkStat.isSymbolicLink()) {
        let targetStat;
        try {
          targetStat = fs.statSync(full);
        } catch {
          continue;
        }
        let resolved;
        try {
          resolved = fs.realpathSync(full);
        } catch {
          continue;
        }
        unlinkFilesystemLink(full);
        if (targetStat.isDirectory()) {
          copyTreeAcyclic(resolved, full, new Set(), { skipNodeModules: true });
          stack.push(full);
        } else if (targetStat.isFile()) {
          fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
          fs.copyFileSync(resolved, full, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(full, targetStat.mode & 0o777 || 0o600);
        }
        continue;
      }
      if (linkStat.isDirectory()) stack.push(full);
    }
  }
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
    if (prepareDependencies && hostNpmPrepareAllowed(manifest, platform)) {
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
  hostNpmPrepareAllowed,
  installWindowsCwdLifecycleFallbacks,
  installWindowsCwdNodeCommands,
  installWindowsNodeBinShims,
  materializeNpmWorkspaceLinks,
  npmSpawnInvocation,
  prepareFiveStackRuntime,
  resolveNpmCliJs,
  resolveNodeExecutable,
  rewritePackageScriptsToAbsoluteNode,
  withAbsoluteNodeCommand,
  withAbsoluteNpmCommand,
};
