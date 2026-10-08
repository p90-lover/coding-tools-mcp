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

function loadManifest(manifestPath = MANIFEST_PATH) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest?.id !== "antigravity-cli" || !/^\d+\.\d+\.\d+$/.test(String(manifest.version))
    || manifest.repository !== "google-antigravity/antigravity-cli") {
    throw new Error("Antigravity CLI manifest is invalid");
  }
  return manifest;
}

function platformAsset(manifest, platform, arch) {
  const asset = manifest.platforms?.[platform]?.[arch];
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^agy_cli_[a-z0-9_]+\.(zip|tar\.gz)$/.test(asset.fileName)) {
    throw new Error(`Antigravity CLI has no pinned build for ${platform}/${arch}`);
  }
  return { ...asset, url: `https://github.com/${manifest.repository}/releases/download/${manifest.version}/${asset.fileName}` };
}

/** Reject absolute paths, parent traversal and link entries before anything is extracted. */
function validateArchive(archive, run = spawnSync) {
  const list = (args) => {
    const result = run(tarBinary(), args, { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error("Antigravity CLI archive could not be read");
    return String(result.stdout || "").split(/\r?\n/u).filter(Boolean);
  };
  const entries = list(["-tf", archive]);
  if (!entries.length) throw new Error("Antigravity CLI archive is empty");
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized) || normalized.split("/").includes("..") || normalized.includes("\0")) {
      throw new Error("Antigravity CLI archive contains an unsafe path");
    }
  }
  for (const line of list(["-tvf", archive])) {
    if (["l", "h"].includes(line.trimStart()[0])) throw new Error("Antigravity CLI archive contains a link entry");
  }
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
      "  echo Antigravity CLI runs only through the Coding Tools network proxy. Select a global proxy in Network Proxy, then restart Agent Orchestrator. 1>&2",
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
    "  echo 'Antigravity CLI runs only through the Coding Tools network proxy. Select a global proxy in Network Proxy, then restart Agent Orchestrator.' >&2",
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
  spawnImpl = spawn, spawnSyncImpl = spawnSync, manifestPath = MANIFEST_PATH, now = () => Date.now(),
}) {
  if (!toolsRoot || !path.isAbsolute(toolsRoot)) throw new Error("Antigravity CLI tools root must be absolute");
  const manifest = loadManifest(manifestPath);
  const root = path.join(toolsRoot, "antigravity-cli");
  const binDir = path.join(toolsRoot, "bin");
  const shimPath = path.join(binDir, platform === "win32" ? "agy.cmd" : "agy");
  const markerPath = (home) => path.join(home, "CODING_TOOLS_TOOL.json");
  let installing = null;

  function installed() {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath(path.join(root, manifest.version)), "utf8"));
      const executable = path.join(root, manifest.version, marker.executable);
      if (marker.version !== manifest.version || !fs.statSync(executable).isFile()) return null;
      return { version: marker.version, executable, installedAt: marker.installedAt };
    } catch { return null; }
  }

  function previousVersions() {
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name) && entry.name !== manifest.version)
        .map(entry => entry.name);
    } catch { return []; }
  }

  function status() {
    const current = installed();
    let asset = null;
    try { asset = platformAsset(manifest, platform, arch); } catch {}
    return {
      ok: true, id: manifest.id, name: manifest.name, command: manifest.command,
      version: manifest.version, supported: Boolean(asset), installing: Boolean(installing),
      installed: Boolean(current), installedAt: current?.installedAt ?? null,
      previous: previousVersions(), shim: current && fs.existsSync(shimPath) ? shimPath : null,
      binDir: current ? binDir : null, download: asset ? { fileName: asset.fileName, size: asset.size, url: asset.url } : null,
    };
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

  /** Previous builds move to Trash; nothing the user installed is deleted. */
  function retirePrevious() {
    for (const version of previousVersions()) {
      const trash = path.join(toolsRoot, "Trash", "antigravity-cli", `${version}-${now()}`);
      fs.mkdirSync(path.dirname(trash), { recursive: true });
      fs.renameSync(path.join(root, version), trash);
    }
  }

  async function install() {
    if (installing) return installing;
    const asset = platformAsset(manifest, platform, arch);
    if (installed()) return status();
    if (!await confirm({
      message: `Install ${manifest.name} ${manifest.version}?`,
      detail: `Source: ${asset.url}\nFile: ${asset.fileName} (${(asset.size / 1048576).toFixed(1)} MB)\nSHA-256: ${asset.sha256}\n\nIt is installed for Coding Tools only and exposed to Agent Orchestrator as "${manifest.command}". Sign-in happens in the CLI itself.`,
    })) return { ok: false, cancelled: true };
    installing = (async () => {
      const staging = path.join(root, `.staging-${manifest.version}-${now()}`);
      const archive = path.join(root, `.download-${asset.fileName}`);
      fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
      try {
        await download(asset, archive);
        validateArchive(archive, spawnSyncImpl);
        const extracted = spawnSyncImpl(tarBinary(platform), ["-xf", archive, "-C", staging], { windowsHide: true, encoding: "utf8" });
        if (extracted.error || extracted.status !== 0) throw new Error("Antigravity CLI archive could not be extracted");
        const executable = findExecutable(staging);
        if (platform !== "win32") fs.chmodSync(executable, 0o755);
        const relative = path.relative(staging, executable);
        fs.writeFileSync(markerPath(staging), `${JSON.stringify({ id: manifest.id, version: manifest.version,
          executable: relative, sha256: asset.sha256, installedAt: new Date(now()).toISOString() }, null, 2)}\n`);
        retirePrevious();
        const home = path.join(root, manifest.version);
        if (fs.existsSync(home)) fs.renameSync(home, path.join(toolsRoot, "Trash", "antigravity-cli", `${manifest.version}-incomplete-${now()}`));
        fs.renameSync(staging, home);
        writeShim(path.join(home, relative));
        logger.info?.("antigravity_cli.installed", { version: manifest.version });
        return status();
      } finally {
        installing = null;
        // The verified archive is no longer needed; the staging folder is only left behind on failure.
        try { fs.rmSync(archive, { force: true }); } catch {}
      }
    })();
    return installing;
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

  return Object.freeze({ status, install, executable, binDir: () => { if (!installed()) return null; executable(); return binDir; }, manifest });
}

module.exports = { createAntigravityCli, loadManifest, platformAsset, validateArchive, findExecutable, tarBinary, shimBody, shimProxyEnvironment, manualAuthEnvironment };
