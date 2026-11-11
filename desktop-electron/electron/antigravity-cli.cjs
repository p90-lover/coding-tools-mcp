"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const MANIFEST_PATH = path.join(__dirname, "..", "vendor", "tools", "antigravity-cli.json");
const DOWNLOAD_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
const EXECUTABLE_NAMES = new Set(["antigravity", "antigravity.exe", "agy", "agy.exe"]);
// Windows' bundled bsdtar reads zip; a GNU tar earlier on PATH (e.g. Git's) does not.
const tarBinary = (platform = process.platform) => (platform === "win32"
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar");

const VERSION = /^\d+\.\d+\.\d+$/;
// The pinned archive is ~60 MB; a release asset far beyond that isn't the CLI.
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

function checkManifest(manifest) {
  if (manifest?.id !== "antigravity-cli" || !VERSION.test(String(manifest.version))
    || manifest.repository !== "google-antigravity/antigravity-cli") {
    throw new Error("Antigravity CLI manifest is invalid");
  }
  return manifest;
}

function loadManifest(manifestPath = MANIFEST_PATH) {
  return checkManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
}

/** -1, 0 or 1 for two x.y.z versions. */
function compareVersion(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

/**
 * A manifest for a newer GitHub release (App plugins' update): the pinned manifest's file names and
 * executables, with the size and SHA-256 GitHub computed for each of that release's assets. A
 * platform whose asset is missing or has no digest is left out, so it has nothing to install.
 */
function releaseManifest(base, release) {
  const version = String(release?.tag_name || "").replace(/^v/u, "");
  if (!VERSION.test(version)) throw new Error("Antigravity CLI release has no x.y.z version");
  const assets = new Map((release.assets || []).map(asset => [asset.name, asset]));
  const platforms = {};
  for (const [platform, arches] of Object.entries(base.platforms || {})) {
    for (const [arch, pinned] of Object.entries(arches || {})) {
      const asset = assets.get(pinned.fileName);
      const sha256 = /^sha256:([a-f0-9]{64})$/u.exec(String(asset?.digest || ""))?.[1];
      if (!sha256 || !(asset.size > 0 && asset.size <= MAX_ARCHIVE_BYTES)) continue;
      (platforms[platform] ??= {})[arch] = { fileName: pinned.fileName, size: asset.size, sha256, executable: pinned.executable };
    }
  }
  return checkManifest({ ...base, version, platforms });
}

function platformAsset(manifest, platform, arch) {
  const asset = manifest.platforms?.[platform]?.[arch];
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^agy_cli_[a-z0-9_]+\.(zip|tar\.gz)$/.test(asset.fileName)) {
    throw new Error(`Antigravity CLI has no pinned build for ${platform}/${arch}`);
  }
  return { ...asset, url: `https://github.com/${manifest.repository}/releases/download/${manifest.version}/${asset.fileName}` };
}

function checkEntryNames(entries) {
  if (!entries.length) throw new Error("Antigravity CLI archive is empty");
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized) || normalized.split("/").includes("..") || normalized.includes("\0")) {
      throw new Error("Antigravity CLI archive contains an unsafe path");
    }
  }
}

function checkEntryTypes(lines) {
  for (const line of lines) {
    if (["l", "h"].includes(line.trimStart()[0])) throw new Error("Antigravity CLI archive contains a link entry");
  }
}

const listingLines = (result) => {
  if (result.error || result.status !== 0) throw new Error("Antigravity CLI archive could not be read");
  return String(result.stdout || "").split(/\r?\n/u).filter(Boolean);
};

/** Reject absolute paths, parent traversal and link entries before anything is extracted. */
function validateArchive(archive, run = spawnSync) {
  const list = (args) => listingLines(run(tarBinary(), args, { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
  checkEntryNames(list(["-tf", archive]));
  checkEntryTypes(list(["-tvf", archive]));
}

/** validateArchive with tar run as a child the caller doesn't wait on: `run(args)` resolves { status, stdout, error }. */
async function validateArchiveAsync(archive, run) {
  checkEntryNames(listingLines(await run(["-tf", archive])));
  checkEntryTypes(listingLines(await run(["-tvf", archive])));
}

async function findExecutableAsync(root) {
  const found = [];
  const visit = async (directory, depth) => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && depth < 3) await visit(candidate, depth + 1);
      else if (entry.isFile() && EXECUTABLE_NAMES.has(entry.name.toLowerCase())) found.push(candidate);
    }
  };
  await visit(root, 0);
  if (found.length !== 1) throw new Error(`Antigravity CLI archive must contain one executable; found ${found.length}`);
  return found[0];
}

function findExecutable(root) {
  const found = [];
  const visit = (directory, depth) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && depth < 3) visit(candidate, depth + 1);
      else if (entry.isFile() && EXECUTABLE_NAMES.has(entry.name.toLowerCase())) found.push(candidate);
    }
  };
  visit(root, 0);
  if (found.length !== 1) throw new Error(`Antigravity CLI archive must contain one executable; found ${found.length}`);
  return found[0];
}

// Proxy values reach the shim through CODING_TOOLS_AGY_* variables held only in the AO
// daemon's memory. Without them the shim refuses to start, so agy never goes direct.
const SHIM_PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
function shimBody(executable, platform = process.platform) {
  if (platform === "win32") {
    return [
      "@echo off",
      "setlocal",
      "if not defined CODING_TOOLS_AGY_HTTPS_PROXY (",
      "  echo Antigravity CLI runs only through the Coding Tools network proxy. Select a global proxy on the Proxy page, then restart Agent Orchestrator. 1>&2",
      "  exit /b 1",
      ")",
      ...SHIM_PROXY_KEYS.flatMap(key => [
        `if defined CODING_TOOLS_AGY_${key} set "${key}=%CODING_TOOLS_AGY_${key}%"`,
        `if defined CODING_TOOLS_AGY_${key} set "${key.toLowerCase()}=%CODING_TOOLS_AGY_${key}%"`,
      ]),
      'if not defined SSH_CLIENT set "SSH_CLIENT=coding-tools"',
      `"${executable}" %*`,
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    'if [ -z "$CODING_TOOLS_AGY_HTTPS_PROXY" ]; then',
    "  echo 'Antigravity CLI runs only through the Coding Tools network proxy. Select a global proxy on the Proxy page, then restart Agent Orchestrator.' >&2",
    "  exit 1",
    "fi",
    ...SHIM_PROXY_KEYS.map(key => `[ -n "$CODING_TOOLS_AGY_${key}" ] && export ${key}="$CODING_TOOLS_AGY_${key}" ${key.toLowerCase()}="$CODING_TOOLS_AGY_${key}"`),
    'export SSH_CLIENT="${SSH_CLIENT:-coding-tools}"',
    `exec "${executable}" "$@"`,
    "",
  ].join("\n");
}

// The CLI's documented SSH auth mode prints a sign-in link/code instead of opening the
// system browser. Keep this local to managed agy; a real SSH session keeps its own value.
function manualAuthEnvironment(environment, inherited = process.env) {
  return { ...environment, SSH_CLIENT: environment.SSH_CLIENT || inherited.SSH_CLIENT || "coding-tools" };
}

/** Map a standard proxy environment to the variables the agy shim reads. */
function shimProxyEnvironment(proxyEnvironment = {}) {
  const out = {};
  for (const key of SHIM_PROXY_KEYS) {
    const value = proxyEnvironment[key] ?? proxyEnvironment[key.toLowerCase()];
    if (typeof value === "string" && value) out[`CODING_TOOLS_AGY_${key}`] = value;
  }
  return out;
}

function createAntigravityCli({
  toolsRoot, confirm, getWorkspaces, logger = console,
  platform = process.platform, arch = process.arch, fetchImpl = fetch,
  spawnImpl = spawn, manifestPath = MANIFEST_PATH, now = () => Date.now(),
}) {
  if (!toolsRoot || !path.isAbsolute(toolsRoot)) throw new Error("Antigravity CLI tools root must be absolute");
  const manifest = loadManifest(manifestPath);
  const root = path.join(toolsRoot, "antigravity-cli");
  const binDir = path.join(toolsRoot, "bin");
  const shimPath = path.join(binDir, platform === "win32" ? "agy.cmd" : "agy");
  const markerPath = (home) => path.join(home, "CODING_TOOLS_TOOL.json");
  let installing = null;

  function versionDirs() {
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && VERSION.test(entry.name)).map(entry => entry.name);
    } catch { return []; }
  }

  function installedVersion(version) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath(path.join(root, version)), "utf8"));
      const executable = path.join(root, version, marker.executable);
      if (marker.version !== version || !fs.statSync(executable).isFile()) return null;
      return { version: marker.version, executable, installedAt: marker.installedAt };
    } catch { return null; }
  }

  /** The newest complete install: the pinned build, or a newer release App plugins updated to. */
  function installed() {
    const versions = versionDirs().sort((left, right) => compareVersion(right, left));
    for (const version of versions) {
      const found = installedVersion(version);
      if (found) return found;
    }
    return null;
  }

  /** The status from what is on disk: the newest complete install, every version folder, the shim. */
  function statusOf(current, versions, shimExists) {
    let asset = null;
    try { asset = platformAsset(manifest, platform, arch); } catch {}
    const keep = current?.version ?? manifest.version;
    return {
      ok: true, id: manifest.id, name: manifest.name, command: manifest.command,
      version: current?.version ?? manifest.version, pinned: manifest.version, supported: Boolean(asset), installing: Boolean(installing),
      installed: Boolean(current), installedAt: current?.installedAt ?? null,
      previous: versions.filter(version => version !== keep), shim: current && shimExists ? shimPath : null,
      binDir: current ? binDir : null, download: asset ? { fileName: asset.fileName, size: asset.size, url: asset.url } : null,
    };
  }

  function status() {
    const current = installed();
    return statusOf(current, versionDirs(), Boolean(current) && fs.existsSync(shimPath));
  }

  async function versionDirsAsync() {
    try {
      return (await fs.promises.readdir(root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && VERSION.test(entry.name)).map(entry => entry.name);
    } catch { return []; }
  }

  async function installedAsync(versions) {
    for (const version of [...versions].sort((left, right) => compareVersion(right, left))) {
      try {
        const marker = JSON.parse(await fs.promises.readFile(markerPath(path.join(root, version)), "utf8"));
        const executable = path.join(root, version, marker.executable);
        if (marker.version === version && (await fs.promises.stat(executable)).isFile()) {
          return { version: marker.version, executable, installedAt: marker.installedAt };
        }
      } catch { /* an incomplete install: try the next */ }
    }
    return null;
  }

  /**
   * status() for the app's own screens (the Antigravity page, App plugins): the same answer, read
   * off the main thread. The synchronous scan held every window 614 ms on the busy disk (Activity,
   * 2026-11-09 06:14:33Z: readdirSync antigravity-cli < status).
   */
  async function statusAsync() {
    const versions = await versionDirsAsync();
    const current = await installedAsync(versions);
    const shimExists = Boolean(current) && await fs.promises.access(shimPath).then(() => true, () => false);
    return statusOf(current, versions, shimExists);
  }

  async function download(asset, target) {
    let url = new URL(asset.url);
    for (let hop = 0; hop < 5; hop += 1) {
      if (url.protocol !== "https:" || !DOWNLOAD_HOSTS.has(url.hostname)) throw new Error("Antigravity CLI download left the pinned GitHub release");
      const response = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(10 * 60_000) });
      if (response.status >= 300 && response.status < 400) {
        url = new URL(response.headers.get("location"), url);
        continue;
      }
      if (!response.ok || !response.body) throw new Error(`Antigravity CLI download failed (HTTP ${response.status})`);
      const hash = crypto.createHash("sha256");
      const out = fs.createWriteStream(target, { mode: 0o600 });
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > asset.size) throw new Error("Antigravity CLI download is larger than the pinned release");
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise(resolve => out.once("drain", resolve));
        }
      } finally { await new Promise(resolve => out.end(resolve)); }
      if (size !== asset.size || hash.digest("hex") !== asset.sha256) throw new Error("Antigravity CLI download does not match its pinned checksum");
      return;
    }
    throw new Error("Antigravity CLI download redirected too many times");
  }

  function writeShim(executable) {
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${shimPath}.tmp`, shimBody(executable, platform), { mode: 0o755 });
    fs.renameSync(`${shimPath}.tmp`, shimPath);
  }

  async function writeShimAsync(executable) {
    await fs.promises.mkdir(binDir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(`${shimPath}.tmp`, shimBody(executable, platform), { mode: 0o755 });
    await fs.promises.rename(`${shimPath}.tmp`, shimPath);
  }

  /**
   * Previous builds move to Trash; nothing the user installed is deleted. A build an agent is still
   * running can't be moved on Windows: it stays until the next install, and the newest one is used.
   */
  async function toTrash(source, name) {
    const trash = path.join(toolsRoot, "Trash", "antigravity-cli", name);
    await fs.promises.mkdir(path.dirname(trash), { recursive: true });
    await fs.promises.rename(source, trash);
  }

  async function retirePrevious(keep) {
    for (const version of (await versionDirsAsync()).filter((name) => name !== keep)) {
      try {
        await toTrash(path.join(root, version), `${version}-${now()}`);
      } catch (error) {
        logger.warn?.("antigravity_cli.retire_failed", { version, message: String(error?.message || error) });
      }
    }
  }

  // tar as a child the main thread doesn't wait on. The install ran it with spawnSync and wrote its
  // files synchronously, and an update held every window (Activity 2026-11-10 05:50Z: 1.1 s, then a
  // 2.9 s stall, in writeFileSync CODING_TOOLS_TOOL.json < updateAntigravity).
  function runTar(args) {
    return new Promise((resolve) => {
      let stdout = "";
      let child;
      try {
        child = spawnImpl(tarBinary(platform), args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      } catch (error) { resolve({ error }); return; }
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > 16 * 1024 * 1024) { child.kill(); resolve({ error: new Error("tar listing too large") }); }
      });
      child.on("error", (error) => resolve({ error }));
      child.on("close", (status) => resolve({ status, stdout }));
    });
  }

  /** Downloads, checks and unpacks `target`'s build into <root>/<version>, then points the shim at it. */
  function installManifest(target, asset) {
    if (installing) return installing;
    installing = (async () => {
      const staging = path.join(root, `.staging-${target.version}-${now()}`);
      const archive = path.join(root, `.download-${asset.fileName}`);
      try {
        // Every step is off the main thread: the download, tar's listing and extraction, and the writes.
        await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
        await download(asset, archive);
        await validateArchiveAsync(archive, runTar);
        const extracted = await runTar(["-xf", archive, "-C", staging]);
        if (extracted.error || extracted.status !== 0) throw new Error("Antigravity CLI archive could not be extracted");
        const executable = await findExecutableAsync(staging);
        if (platform !== "win32") await fs.promises.chmod(executable, 0o755);
        const relative = path.relative(staging, executable);
        await fs.promises.writeFile(markerPath(staging), `${JSON.stringify({ id: target.id, version: target.version,
          executable: relative, sha256: asset.sha256, installedAt: new Date(now()).toISOString() }, null, 2)}\n`);
        const home = path.join(root, target.version);
        if (await fs.promises.access(home).then(() => true, () => false)) await toTrash(home, `${target.version}-incomplete-${now()}`);
        await fs.promises.rename(staging, home);
        await writeShimAsync(path.join(home, relative));
        // After the switch: a failed move of the old build leaves the new one in use.
        await retirePrevious(target.version);
        logger.info?.("antigravity_cli.installed", { version: target.version });
        return await statusAsync();
      } finally {
        installing = null;
        // The verified archive is no longer needed; the staging folder is only left behind on failure.
        await fs.promises.rm(archive, { force: true }).catch(() => {});
      }
    })();
    return installing;
  }

  async function install() {
    if (installing) return installing;
    const asset = platformAsset(manifest, platform, arch);
    const current = await installedAsync(await versionDirsAsync());
    if (current && compareVersion(current.version, manifest.version) >= 0) return statusAsync();
    if (!await confirm({
      message: `Install ${manifest.name} ${manifest.version}?`,
      detail: `Source: ${asset.url}\nFile: ${asset.fileName} (${(asset.size / 1048576).toFixed(1)} MB)\nSHA-256: ${asset.sha256}\n\nIt's installed for Coding Tools only, and agents run it as "${manifest.command}". You sign in from the CLI.`,
    })) return { ok: false, cancelled: true };
    return installManifest(manifest, asset);
  }

  /**
   * Updates to a newer release (App plugins' Update button, which is the person's consent): a
   * manifest from releaseManifest, installed with the same checksum and archive checks as the pin.
   */
  async function update(target) {
    if (installing) throw new Error("The Antigravity CLI is already being installed");
    checkManifest(target);
    const current = await installedAsync(await versionDirsAsync());
    if (!current) throw new Error("Install the Antigravity CLI first");
    if (compareVersion(target.version, current.version) <= 0) return statusAsync();
    const asset = platformAsset(target, platform, arch);
    if (asset.size > MAX_ARCHIVE_BYTES) throw new Error("Antigravity CLI release is larger than the CLI can be");
    return installManifest(target, asset);
  }

  /** The pinned executable; it only runs inside the in-app terminal with proxy variables. */
  function executable() {
    const current = installed();
    if (!current) throw new Error("Install the Antigravity CLI first");
    if (!fs.existsSync(shimPath) || fs.readFileSync(shimPath, "utf8") !== shimBody(current.executable, platform)) {
      writeShim(current.executable);
    }
    return current.executable;
  }

  /**
   * The shim folder for AO's PATH, or null before an install (resolves). AO's start awaits it:
   * the same scan done synchronously held main 0.6-0.8 s per call on a cold disk after launch.
   */
  async function binDirAsync() {
    const target = (await installedAsync(await versionDirsAsync()))?.executable;
    if (!target) return null;
    const shim = await fs.promises.readFile(shimPath, "utf8").catch(() => null);
    if (shim !== shimBody(target, platform)) await writeShimAsync(target);
    return binDir;
  }

  return Object.freeze({ status, statusAsync, install, update, executable, binDir: binDirAsync, manifest });
}

module.exports = { createAntigravityCli, loadManifest, releaseManifest, compareVersion, platformAsset, validateArchive, findExecutable, tarBinary, shimBody, shimProxyEnvironment, manualAuthEnvironment };
