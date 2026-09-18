"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BUNDLED_IDS = Object.freeze(["commandcode-proxy", "paseo", "anneal"]);
const SKIP_BUNDLED_DIRS = new Set([".git", "node_modules", ".bin", "fastlane", ".github", "test", "tests", "__tests__", "e2e"]);

function isUnsafeWindowsPackagedName(name) {
  const base = String(name || "");
  if (!base || /[. ]$/.test(base)) return true;
  if (/[<>:"/\\|?*]/.test(base)) return true;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base);
}

function looksLikePackagedFileName(name) {
  return /\.(?:md|png|jpe?g|gif|webp|json|txt|ya?ml|js|mjs|cjs|ts|tsx|css|html|svg|lock|map|xml)$/i.test(String(name || ""));
}

function isLinkOrReparse(filePath, dirent, linkStat) {
  if ((dirent && typeof dirent.isSymbolicLink === "function" && dirent.isSymbolicLink()) || linkStat.isSymbolicLink()) {
    return true;
  }
  try {
    fs.readlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function unlinkReparsePoint(pathname) {
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

function flattenSymlinks(root, seen = new Set()) {
  const dir = path.resolve(root);
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_BUNDLED_DIRS.has(entry.name) || isUnsafeWindowsPackagedName(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let linkStat;
    try {
      linkStat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (isLinkOrReparse(full, entry, linkStat)) {
      let targetStat;
      let resolved;
      try {
        targetStat = fs.statSync(full);
        resolved = fs.realpathSync(full);
      } catch {
        try { unlinkReparsePoint(full); } catch { /* dangling gitlink */ }
        continue;
      }
      if (!targetStat.isFile()) {
        try { unlinkReparsePoint(full); } catch { /* directory gitlink */ }
        continue;
      }
      unlinkReparsePoint(full);
      fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
      fs.copyFileSync(resolved, full);
      fs.chmodSync(full, targetStat.mode & 0o777 || 0o600);
      continue;
    }
    if (linkStat.isDirectory()) {
      if (looksLikePackagedFileName(entry.name)) {
        fs.rmSync(full, { recursive: true, force: true });
        continue;
      }
      flattenSymlinks(full, seen);
    }
  }
}

function copyBundledTree(sourceRoot, destinationRoot) {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error("Bundled component payload is missing from this Desktop build");
  }
  const visit = (from, to) => {
    fs.mkdirSync(to, { recursive: true, mode: 0o700 });
    let entries;
    try {
      entries = fs.readdirSync(from, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_BUNDLED_DIRS.has(entry.name) || isUnsafeWindowsPackagedName(entry.name)) continue;
      const fromPath = path.join(from, entry.name);
      const toPath = path.join(to, entry.name);
      let linkStat;
      try {
        linkStat = fs.lstatSync(fromPath);
      } catch {
        continue;
      }
      if (linkStat.isDirectory() && /\.(md|png|jpe?g|gif|webp)$/i.test(entry.name)) continue;
      if (isLinkOrReparse(fromPath, entry, linkStat)) {
        // GitHub tarballs keep docs/screenshot gitlinks. Windows tar turns
        // dangling ones into reparse points that 7zip then rejects as
        // "The directory name is invalid." during NSIS compression.
        let followed;
        try {
          followed = fs.statSync(fromPath);
        } catch {
          continue;
        }
        if (!followed.isFile()) continue;
        fs.copyFileSync(fromPath, toPath);
        fs.chmodSync(toPath, followed.mode & 0o777);
        continue;
      }
      if (linkStat.isDirectory()) {
        if (looksLikePackagedFileName(entry.name)) continue;
        visit(fromPath, toPath);
        continue;
      }
      if (!linkStat.isFile()) continue;
      fs.copyFileSync(fromPath, toPath);
      fs.chmodSync(toPath, linkStat.mode & 0o777);
    }
  };
  visit(source, destination);
}

function loadManifest(desktopRoot, id) {
  return JSON.parse(fs.readFileSync(path.join(desktopRoot, "vendor", "managed-components", `${id}.json`), "utf8"));
}

function entrypointReady(home, entry) {
  return Boolean(home) && fs.existsSync(path.join(home, entry));
}

function downloadArchive(url, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const curl = spawnSync("curl", ["-fsSL", "--retry", "3", "-o", destination, url], { encoding: "utf8" });
  if (curl.status === 0 && fs.existsSync(destination)) return destination;
  const wget = spawnSync("wget", ["-q", "-O", destination, url], { encoding: "utf8" });
  if (wget.status === 0 && fs.existsSync(destination)) return destination;
  throw new Error(`Bundled component download failed: ${String(curl.stderr || wget.stderr || "curl/wget unavailable").trim()}`);
}

function extractArchive(archive, destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const result = spawnSync("tar", ["-xzf", archive, "-C", destination, "--strip-components=1"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Bundled component extract failed: ${String(result.stderr || result.stdout || "tar failed").trim()}`);
  }
}

function materializeBundledComponents({
  desktopRoot,
  destinationRoot,
  fetchMissing = false,
} = {}) {
  if (!desktopRoot || !destinationRoot) throw new Error("Bundled component roots are required");
  const copied = [];
  const fetched = [];
  const missing = [];

  for (const id of BUNDLED_IDS) {
    const manifest = loadManifest(desktopRoot, id);
    if (manifest.strategy !== "bundled-source") continue;
    const entry = manifest.bundle?.entrypoint;
    if (!entry) throw new Error(`${id} bundled entrypoint is required`);
    const dest = path.join(destinationRoot, id);
    const local = path.join(desktopRoot, "vendor", "bundled", id);
    if (entrypointReady(local, entry)) {
      copyBundledTree(local, dest);
      flattenSymlinks(dest);
      copied.push(id);
      continue;
    }
    if (!fetchMissing) {
      missing.push(id);
      continue;
    }
    const archiveUrl = `https://github.com/${manifest.repository}/archive/${manifest.commit}.tar.gz`;
    const archive = path.join(os.tmpdir(), `coding-tools-bundle-${id}-${manifest.commit}.tar.gz`);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `coding-tools-bundle-${id}-`));
    try {
      if (!fs.existsSync(archive)) downloadArchive(archiveUrl, archive);
      extractArchive(archive, scratch);
      copyBundledTree(scratch, dest);
      flattenSymlinks(dest);
    } catch (error) {
      throw new Error(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!entrypointReady(dest, entry)) {
      throw new Error(`Bundled ${id} payload is missing ${entry}`);
    }
    fetched.push(id);
  }

  return Object.freeze({ copied, fetched, missing, destinationRoot });
}

module.exports = {
  BUNDLED_IDS,
  copyBundledTree,
  flattenSymlinks,
  looksLikePackagedFileName,
  materializeBundledComponents,
};
