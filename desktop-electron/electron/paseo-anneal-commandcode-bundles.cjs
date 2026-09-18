"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LANE_193_IDS = Object.freeze(["commandcode-proxy", "paseo", "anneal"]);
const LANE_193_ID_SET = new Set(LANE_193_IDS);
const MARKER_NAME = "CODING_TOOLS_BUNDLED.json";

function isDirectory(candidate) {
  try {
    return Boolean(candidate) && fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate) {
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function desktopRootFrom(filePath) {
  return path.resolve(filePath, "..", "..");
}

function defaultLane193Roots({
  bundleRoot = null,
  resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : null,
  desktopRoot = desktopRootFrom(__dirname),
} = {}) {
  return [
    bundleRoot,
    resourcesPath ? path.join(resourcesPath, "paseo-anneal-commandcode") : null,
    path.join(desktopRoot, "build", "paseo-anneal-commandcode"),
    path.join(desktopRoot, "vendor", "bundled"),
  ].filter(Boolean);
}

function resolveLane193Root(options = {}) {
  for (const root of defaultLane193Roots(options)) {
    if (isDirectory(root)) return path.resolve(root);
  }
  return null;
}

function assertInside(root, candidate, label) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped the Paseo/Anneal/CommandCode bundle root`);
  }
  return target;
}

function sourceRelative(id) {
  if (id === "commandcode-proxy") return "commandcode-proxy";
  return path.posix.join(id, "source");
}

function requiredEntrypoint(id) {
  if (id === "commandcode-proxy") return "proxy.mjs";
  return "package.json";
}

function readMarker(sourceRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sourceRoot, MARKER_NAME), "utf8"));
  } catch {
    return null;
  }
}

function resolveLane193Payload(manifest, options = {}) {
  if (!manifest || !LANE_193_ID_SET.has(manifest.id)) return null;
  const roots = defaultLane193Roots(options);
  const entry = manifest.bundle?.entrypoint || requiredEntrypoint(manifest.id);
  for (const root of roots) {
    if (!isDirectory(root)) continue;
    const candidates = [
      path.join(root, ...sourceRelative(manifest.id).split("/")),
      path.join(root, manifest.id, "source"),
      path.join(root, manifest.id),
    ];
    for (const sourceRoot of candidates) {
      if (!isDirectory(sourceRoot)) continue;
      const entryPath = path.join(sourceRoot, ...String(entry).split("/"));
      if (!isFile(entryPath)) continue;
      assertInside(root, sourceRoot, `${manifest.id} bundled source`);
      const marker = readMarker(sourceRoot);
      if (marker?.id && marker.id !== manifest.id) continue;
      if (manifest.commit && marker?.commit && marker.commit !== manifest.commit) continue;
      return {
        id: manifest.id,
        path: sourceRoot,
        relative: path.relative(root, sourceRoot).split(path.sep).join("/"),
        marker,
        skipNetworkPrepare: marker?.skipNetworkPrepare === true,
      };
    }
  }
  return null;
}

module.exports = {
  LANE_193_IDS,
  MARKER_NAME,
  defaultLane193Roots,
  resolveLane193Payload,
  resolveLane193Root,
  sourceRelative,
};
