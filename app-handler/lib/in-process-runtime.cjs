"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MODULES_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MODULES_ROOT, "..");

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function existsDir(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function firstExistingDir(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsDir(candidate)) return candidate;
  }
  return null;
}

function vendorCandidates(moduleId) {
  const candidates = [
    path.join(REPO_ROOT, "desktop-electron", "vendor", "bundled", moduleId),
    path.join(REPO_ROOT, "vendor", "bundled", moduleId),
    path.join(MODULES_ROOT, moduleId, "vendor"),
  ];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, "bundled-components", moduleId),
      path.join(process.resourcesPath, "vendor", "bundled", moduleId),
      path.join(process.resourcesPath, "five-stack-runtime", moduleId, "source"),
    );
  }
  return candidates;
}

function describeTree(root, entrypoint) {
  if (!root || !existsDir(root)) {
    return {
      present: false,
      path: root || null,
      entrypoint: entrypoint || null,
      entryPresent: false,
      bundlePresent: false,
    };
  }
  const entryPath = entrypoint ? path.join(root, entrypoint) : null;
  const bundlePath = path.join(root, "BUNDLE.json");
  const entryPresent = entryPath ? (existsFile(entryPath) || existsDir(entryPath)) : true;
  const bundlePresent = existsFile(bundlePath);
  return {
    present: entryPresent || bundlePresent,
    path: root,
    entrypoint: entrypoint || null,
    entryPresent,
    bundlePresent,
  };
}

function moduleSnapshot(moduleId) {
  const id = String(moduleId || "").trim();
  const root = path.join(MODULES_ROOT, id);
  const moduleJson = readJson(path.join(root, "module.json")) || {};
  const sourceMeta = moduleJson.source && typeof moduleJson.source === "object" ? moduleJson.source : {};
  const sourceRoot = path.join(root, "source");
  const bundle = readJson(path.join(sourceRoot, "BUNDLE.json")) || {};
  const entrypoint = sourceMeta.entrypoint || bundle.entrypoint || null;
  const source = describeTree(sourceRoot, entrypoint);
  const pkg = readJson(path.join(sourceRoot, "package.json")) || {};
  const vendorRoot = firstExistingDir(vendorCandidates(id));
  const vendorBundle = vendorRoot ? readJson(path.join(vendorRoot, "BUNDLE.json")) : null;
  const vendor = describeTree(vendorRoot, vendorBundle?.entrypoint || entrypoint);
  return {
    id,
    name: moduleJson.name || id,
    transport: moduleJson.transport || "in-process",
    present: source.present === true || vendor.present === true,
    listening: false,
    dedicatedListenPort: false,
    source: {
      ...source,
      commit: sourceMeta.commit || bundle.commit || null,
      strategy: sourceMeta.strategy || bundle.strategy || null,
      repository: sourceMeta.repository || bundle.repository || null,
    },
    vendor: {
      ...vendor,
      commit: vendorBundle?.commit || null,
      strategy: vendorBundle?.strategy || null,
    },
    version: typeof pkg.version === "string" ? pkg.version : null,
    legacyLoopback: moduleJson.legacyLoopback || null,
  };
}

function inspectResult(moduleId) {
  const snapshot = moduleSnapshot(moduleId);
  if (!snapshot.present) {
    return {
      ok: false,
      softFail: true,
      unavailable: true,
      id: snapshot.id,
      status: "unavailable",
      listening: false,
      dedicatedListenPort: false,
      runtimeStarted: false,
      detail: `${snapshot.id} bundled source is missing`,
      source: snapshot.source,
      vendor: snapshot.vendor,
      transport: "in-process",
    };
  }
  return {
    ok: true,
    id: snapshot.id,
    name: snapshot.name,
    status: "ready",
    transport: "in-process",
    listening: false,
    dedicatedListenPort: false,
    runtimeStarted: false,
    source: snapshot.source,
    vendor: snapshot.vendor,
    version: snapshot.version,
    legacyLoopback: snapshot.legacyLoopback,
  };
}

function runtimeUnavailable(moduleId, dependency, detail) {
  return {
    ok: false,
    softFail: true,
    unavailable: true,
    dependency,
    detail,
    listening: false,
    runtimeStarted: false,
    transport: "in-process",
    id: moduleId,
  };
}

function connectionRefused(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /econnrefused/i.test(message);
}

module.exports = {
  MODULES_ROOT,
  moduleSnapshot,
  inspectResult,
  runtimeUnavailable,
  connectionRefused,
};
