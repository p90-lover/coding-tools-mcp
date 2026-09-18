"use strict";

const fs = require("node:fs");
const path = require("node:path");

const BUNDLED_COMPONENT_IDS = Object.freeze(["cpa", "codex-router"]);
const BUNDLED_ID_SET = new Set(BUNDLED_COMPONENT_IDS);
const ROUTER_MARKER_NAME = "CODING_TOOLS_BUNDLED.json";
const ROUTER_REQUIRED_FILES = Object.freeze([
  "package.json",
  "src/foreground-start.mjs",
  "src/curate-models.mjs",
  "apps/control-center/electron/main.mjs",
  "apps/control-center/package.json",
]);

function desktopRootFrom(filePath) {
  return path.resolve(filePath, "..", "..");
}

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

function defaultBundleRoots({
  bundleRoot = null,
  resourcesPath = typeof process.resourcesPath === "string" ? process.resourcesPath : null,
  desktopRoot = desktopRootFrom(__dirname),
} = {}) {
  return [
    bundleRoot,
    resourcesPath ? path.join(resourcesPath, "bundled-runtimes") : null,
    path.join(desktopRoot, "vendor", "bundled-runtimes"),
    path.join(desktopRoot, "build", "bundled-runtimes"),
  ].filter(Boolean);
}

function resolveBundleRoot(options = {}) {
  for (const root of defaultBundleRoots(options)) {
    if (isDirectory(root)) return path.resolve(root);
  }
  return null;
}

function cpaArchiveRelative(platform, arch, fileName) {
  return path.posix.join("cpa", String(platform), String(arch), String(fileName));
}

function routerSourceRelative() {
  return "codex-router/source";
}

function routerMarkerRelative() {
  return path.posix.join(routerSourceRelative(), ROUTER_MARKER_NAME);
}

function assertInside(root, candidate, label) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped the bundled runtime root`);
  }
  return target;
}

function copyFileNoFollow(sourcePath, destinationPath) {
  const source = fs.lstatSync(sourcePath);
  if (source.isSymbolicLink()) throw new Error("Bundled runtime contains a symbolic link");
  if (!source.isFile()) throw new Error("Bundled runtime entry is not a file");
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(sourcePath, destinationPath);
  if (process.platform !== "win32") {
    fs.chmodSync(destinationPath, (source.mode & 0o777) || 0o600);
  }
}

function copyTreeDeref(sourcePath, destinationPath, root = sourcePath, walking = new Set()) {
  const resolvedSource = path.resolve(sourcePath);
  const source = fs.lstatSync(resolvedSource);
  if (source.isSymbolicLink()) {
    if (walking.has(resolvedSource)) return;
    walking.add(resolvedSource);
    const target = path.resolve(path.dirname(resolvedSource), fs.readlinkSync(resolvedSource));
    assertInside(root, target, "Bundled runtime symlink");
    copyTreeDeref(target, destinationPath, root, walking);
    walking.delete(resolvedSource);
    return;
  }
  if (source.isDirectory()) {
    fs.mkdirSync(destinationPath, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(destinationPath, 0o700);
    for (const entry of fs.readdirSync(resolvedSource, { withFileTypes: true })) {
      copyTreeDeref(
        path.join(resolvedSource, entry.name),
        path.join(destinationPath, entry.name),
        root,
        walking,
      );
    }
    return;
  }
  if (!source.isFile()) throw new Error("Bundled runtime entry is unsupported");
  copyFileNoFollow(resolvedSource, destinationPath);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function resolveCpaArchive(manifest, {
  platform = process.platform,
  arch = process.arch,
  bundleRoot = resolveBundleRoot(),
} = {}) {
  if (!manifest || manifest.id !== "cpa") return null;
  if (!bundleRoot) return null;
  const asset = manifest.platforms?.[platform]?.[arch];
  if (!asset?.fileName) return null;
  const relative = cpaArchiveRelative(platform, arch, asset.fileName);
  const archivePath = assertInside(bundleRoot, path.join(bundleRoot, ...relative.split("/")), "Bundled CPA archive");
  if (!isFile(archivePath)) return null;
  return {
    id: "cpa",
    path: archivePath,
    relative,
    fileName: asset.fileName,
    sha256: asset.sha256,
  };
}

function resolveRouterSource(manifest, {
  bundleRoot = resolveBundleRoot(),
} = {}) {
  if (!manifest || manifest.id !== "codex-router") return null;
  if (!bundleRoot) return null;
  const sourceRoot = assertInside(
    bundleRoot,
    path.join(bundleRoot, ...routerSourceRelative().split("/")),
    "Bundled Codex Router source",
  );
  if (!isDirectory(sourceRoot)) return null;
  const marker = readJson(path.join(sourceRoot, ROUTER_MARKER_NAME));
  if (marker?.schemaVersion !== 1 || marker.id !== "codex-router") return null;
  if (manifest.commit && marker.commit && marker.commit !== manifest.commit) return null;
  if (manifest.version && marker.version && marker.version !== manifest.version) return null;
  for (const relative of ROUTER_REQUIRED_FILES) {
    const expected = assertInside(sourceRoot, path.join(sourceRoot, ...relative.split("/")), "Bundled Codex Router file");
    if (!isFile(expected)) return null;
  }
  return {
    id: "codex-router",
    path: sourceRoot,
    relative: routerSourceRelative(),
    marker,
    skipNetworkPrepare: marker.skipNetworkPrepare === true,
  };
}

function resolveBundledPayload(manifest, options = {}) {
  if (!manifest || !BUNDLED_ID_SET.has(manifest.id)) return null;
  const bundleRoot = options.bundleRoot || resolveBundleRoot(options);
  if (!bundleRoot) return null;
  if (manifest.id === "cpa") return resolveCpaArchive(manifest, { ...options, bundleRoot });
  return resolveRouterSource(manifest, { ...options, bundleRoot });
}

function bundleRequired(manifest) {
  return manifest?.bundle?.required === true;
}

function missingBundleError(manifest, platform, arch) {
  return new Error(
    `${manifest.name} is bundled inside Coding Tools Desktop; the packaged ${platform}/${arch} runtime is missing`,
  );
}

module.exports = {
  BUNDLED_COMPONENT_IDS,
  ROUTER_MARKER_NAME,
  ROUTER_REQUIRED_FILES,
  bundleRequired,
  copyFileNoFollow,
  copyTreeDeref,
  cpaArchiveRelative,
  defaultBundleRoots,
  missingBundleError,
  resolveBundleRoot,
  resolveBundledPayload,
  resolveCpaArchive,
  resolveRouterSource,
  routerMarkerRelative,
  routerSourceRelative,
};
