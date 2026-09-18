"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BUNDLED_IDS = Object.freeze(["commandcode-proxy", "paseo", "anneal"]);

function copyBundledTree(sourceRoot, destinationRoot) {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error("Bundled component payload is missing from this Desktop build");
  }
  const visit = (from, to) => {
    fs.mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const fromPath = path.join(from, entry.name);
      const toPath = path.join(to, entry.name);
      const stat = fs.lstatSync(fromPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(fromPath, toPath);
        continue;
      }
      if (!stat.isFile()) continue;
      fs.copyFileSync(fromPath, toPath);
      fs.chmodSync(toPath, stat.mode & 0o777);
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
      copied.push(id);
      continue;
    }
    if (!fetchMissing) {
      missing.push(id);
      continue;
    }
    const archiveUrl = `https://github.com/${manifest.repository}/archive/${manifest.commit}.tar.gz`;
    const archive = path.join(os.tmpdir(), `coding-tools-bundle-${id}-${manifest.commit}.tar.gz`);
    try {
      if (!fs.existsSync(archive)) downloadArchive(archiveUrl, archive);
      extractArchive(archive, dest);
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
  materializeBundledComponents,
};
