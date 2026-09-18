"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { MARKER_NAME, sourceRelative } = require("../electron/paseo-anneal-commandcode-bundles.cjs");
const { createRetentionSession } = require("./prepare-package-resources.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const COMMANDCODE_MANIFEST = require("../vendor/managed-components/commandcode-proxy.json");
const PASEO_MANIFEST = require("../vendor/managed-components/paseo.json");
const ANNEAL_MANIFEST = require("../vendor/managed-components/anneal.json");
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function githubHeaders(url) {
  const headers = { Accept: "application/octet-stream" };
  const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  if (token && /github\.com/i.test(url)) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function downloadFile(url, destination, fetchImpl, { attempts = 3 } = {}) {
  if (typeof fetchImpl !== "function") fail("LANE193_DOWNLOAD_UNAVAILABLE", url);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: "follow", headers: githubHeaders(url) });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${url}`);
      }
      const length = Number(response.headers?.get?.("content-length") || 0);
      if (Number.isFinite(length) && length > MAX_ARCHIVE_BYTES) fail("LANE193_DOWNLOAD_TOO_LARGE", url);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_ARCHIVE_BYTES) fail("LANE193_DOWNLOAD_TOO_LARGE", url);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.startsWith("LANE193_DOWNLOAD_TOO_LARGE")) throw error;
      if (fs.existsSync(destination)) {
        try { fs.renameSync(destination, `${destination}.failed-${attempt}`); } catch {}
      }
      if (attempt === attempts) break;
    }
  }
  fail("LANE193_DOWNLOAD_FAILED", lastError instanceof Error ? lastError.message : String(lastError || url));
}

function extractGithubArchive(archivePath, extractRoot, spawnSyncProcess) {
  fs.mkdirSync(extractRoot, { recursive: true, mode: 0o700 });
  const workDir = path.dirname(extractRoot);
  const archiveName = path.relative(workDir, archivePath) || path.basename(archivePath);
  const extractName = path.relative(workDir, extractRoot) || path.basename(extractRoot);
  const result = spawnSyncProcess("tar", ["-xf", archiveName, "-C", extractName], {
    cwd: workDir,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail("LANE193_ARCHIVE_EXTRACT_FAILED", String(result.stderr || result.stdout || "").trim());
  }
  const extracted = fs.readdirSync(extractRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(extractRoot, entry.name));
  if (extracted.length !== 1) fail("LANE193_ARCHIVE_LAYOUT", JSON.stringify(extracted));
  return extracted[0];
}

function writeMarker(sourceRoot, manifest, extra = {}) {
  const markerPath = path.join(sourceRoot, MARKER_NAME);
  if (fs.existsSync(markerPath)) return;
  writeJson(markerPath, {
    schemaVersion: 1,
    id: manifest.id,
    version: manifest.version,
    commit: manifest.commit || null,
    skipNetworkPrepare: true,
    npmLifecycleSkipped: true,
    ...extra,
  });
}

function skipPackagedEntry(name) {
  const base = String(name || "").toLowerCase();
  return base.startsWith(".env") || base === ".git";
}

function copyLane193Tree(sourcePath, destinationPath) {
  const source = fs.lstatSync(sourcePath);
  if (source.isSymbolicLink() || !source.isDirectory() && !source.isFile()) return;
  if (source.isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(destinationPath, 0o700);
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
      if (skipPackagedEntry(entry.name)) continue;
      copyLane193Tree(path.join(sourcePath, entry.name), path.join(destinationPath, entry.name));
    }
    return;
  }
  fs.copyFileSync(sourcePath, destinationPath);
  if (process.platform !== "win32") {
    fs.chmodSync(destinationPath, (source.mode & 0o777) || 0o600);
  }
}

function copyCommandCode(stagingRoot) {
  const vendorRoot = path.join(desktopRoot, "vendor", "bundled", "commandcode-proxy");
  const destination = path.join(stagingRoot, ...sourceRelative("commandcode-proxy").split("/"));
  if (!isFile(path.join(vendorRoot, "proxy.mjs"))) {
    fail("LANE193_COMMANDCODE_VENDOR_MISSING", vendorRoot);
  }
  copyLane193Tree(vendorRoot, destination);
  writeMarker(destination, COMMANDCODE_MANIFEST, { prebuilt: true, entrypoint: "proxy.mjs" });
  return { id: "commandcode-proxy", relative: sourceRelative("commandcode-proxy"), commit: COMMANDCODE_MANIFEST.commit };
}

async function materializeGitSource({
  manifest,
  stagingRoot,
  scratchRoot,
  cacheRoot,
  fetchImpl,
  spawnSyncProcess,
}) {
  const destination = path.join(stagingRoot, ...sourceRelative(manifest.id).split("/"));
  const cached = cacheRoot ? path.join(cacheRoot, manifest.id, "source") : null;
  if (cached && isDirectory(cached)) {
    copyLane193Tree(cached, destination);
    writeMarker(destination, manifest);
    return { id: manifest.id, relative: sourceRelative(manifest.id), commit: manifest.commit, source: "cache" };
  }
  const archiveUrl = `https://github.com/${manifest.repository}/archive/${manifest.commit}.tar.gz`;
  const archivePath = path.join(scratchRoot, `${manifest.id}-${manifest.commit}.tar.gz`);
  await downloadFile(archiveUrl, archivePath, fetchImpl);
  const extracted = extractGithubArchive(
    archivePath,
    path.join(scratchRoot, `${manifest.id}-extract`),
    spawnSyncProcess,
  );
  copyLane193Tree(extracted, destination);
  writeMarker(destination, manifest);
  return { id: manifest.id, relative: sourceRelative(manifest.id), commit: manifest.commit, source: "archive" };
}

async function preparePaseoAnnealCommandCode(options = {}) {
  const outputRoot = path.resolve(options.outputRoot || path.join(desktopRoot, "build", "paseo-anneal-commandcode"));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const spawnSyncProcess = options.spawnSyncProcess || spawnSync;
  const cacheRoot = options.cacheRoot || process.env.CODING_TOOLS_LANE193_CACHE || null;
  const session = createRetentionSession({
    repositoryRoot: options.repositoryRoot || repositoryRoot,
    label: "paseo-anneal-commandcode",
    now: options.now,
    nonce: options.nonce,
  });
  const stagingRoot = path.join(session.workRoot, "payload");
  const scratchRoot = path.join(session.workRoot, "scratch");
  fs.mkdirSync(stagingRoot, { recursive: false, mode: 0o700 });
  fs.mkdirSync(scratchRoot, { recursive: false, mode: 0o700 });
  try {
    const commandcode = copyCommandCode(stagingRoot);
    const paseo = await materializeGitSource({
      manifest: PASEO_MANIFEST,
      stagingRoot,
      scratchRoot,
      cacheRoot,
      fetchImpl,
      spawnSyncProcess,
    });
    const anneal = await materializeGitSource({
      manifest: ANNEAL_MANIFEST,
      stagingRoot,
      scratchRoot,
      cacheRoot,
      fetchImpl,
      spawnSyncProcess,
    });
    writeJson(path.join(stagingRoot, "MANIFEST.json"), {
      schemaVersion: 1,
      owner: "pr-193",
      npmLifecycleSkipped: true,
      components: { commandcode, paseo, anneal },
    });
    const preservedPath = session.publishDirectory(stagingRoot, outputRoot, "prior-paseo-anneal-commandcode");
    return { outputRoot, preservedPath, commandcode, paseo, anneal };
  } catch (error) {
    try {
      if (fs.existsSync(stagingRoot)) session.preservePath(stagingRoot, "failed-paseo-anneal-commandcode");
    } catch {}
    throw error;
  }
}

if (require.main === module) {
  preparePaseoAnnealCommandCode().then((result) => {
    process.stdout.write(`LANE193_RUNTIMES_PREPARED ${JSON.stringify({
      outputRoot: result.outputRoot,
      commandcode: result.commandcode.relative,
      paseo: result.paseo.relative,
      anneal: result.anneal.relative,
    })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  preparePaseoAnnealCommandCode,
};
