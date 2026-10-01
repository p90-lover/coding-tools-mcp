"use strict";

// The swappable backend tier. The GUI shell, Codex bridge, MCP tunnel and CPA proxy are the
// core tier and keep running; the backend (headless service, Agent Orchestrator, Antigravity
// CLI and the app modules) is loaded from a versioned bundle under the user data folder, so a
// new backend can be installed and restarted while the core keeps running.
//
// Bundle layout (<userData>/backend/<id>/):
//   backend-manifest.json          { schemaVersion, id, builtAt, appVersion, files: { rel: sha256 } }
//   electron/*.cjs                 backend JavaScript (only Node built-ins and each other)
//   vendor/tools/*.json            pinned tool manifests the backend reads
//   app-handler/                   in-process app modules
//   coding-tools/                  headless service executable
//   agent-orchestrator/            AO daemon and renderer

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const MANIFEST_NAME = "backend-manifest.json";
const READY_MARKER = "READY";
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KEEP_BUNDLES = 3;

// The backend JavaScript closure. Each file may require only Node built-ins and files here.
const BACKEND_MODULES = Object.freeze([
  "agent-orchestrator-gateway.cjs",
  "agent-orchestrator-upstream.cjs",
  "agent-orchestrator-workflow.cjs",
  "agent-orchestrator-workspace.cjs",
  "antigravity-cli.cjs",
  "cpa-antigravity-reauth.cjs",
  "cpa-oauth-adapter.cjs",
  "headless-host.cjs",
]);

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function safeRelative(rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) return null;
  const normalized = path.posix.normalize(rel.replaceAll("\\", "/"));
  if (normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

function readManifest(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_NAME), "utf8"));
  if (manifest?.schemaVersion !== SCHEMA_VERSION) throw new Error("Backend bundle schema is unsupported");
  if (!BUNDLE_ID_PATTERN.test(String(manifest.id || ""))) throw new Error("Backend bundle id is invalid");
  if (!manifest.files || typeof manifest.files !== "object") throw new Error("Backend bundle file list is missing");
  for (const rel of Object.keys(manifest.files)) {
    if (!safeRelative(rel)) throw new Error(`Backend bundle path is unsafe: ${rel}`);
  }
  for (const name of BACKEND_MODULES) {
    if (!Object.hasOwn(manifest.files, `electron/${name}`)) throw new Error(`Backend bundle is missing electron/${name}`);
  }
  if (!Object.hasOwn(manifest.files, "app-handler/host.cjs")) throw new Error("Backend bundle is missing app-handler/host.cjs");
  return manifest;
}

/** Verify every listed file against its recorded hash. */
function verifyBundle(root) {
  const manifest = readManifest(root);
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const filePath = path.join(root, ...safeRelative(rel).split("/"));
    if (!fs.statSync(filePath).isFile()) throw new Error(`Backend bundle entry is not a file: ${rel}`);
    if (sha256File(filePath) !== expected) throw new Error(`Backend bundle file does not match its hash: ${rel}`);
  }
  return manifest;
}

function copyListed(sourceRoot, targetRoot, manifest) {
  for (const rel of [MANIFEST_NAME, ...Object.keys(manifest.files)]) {
    const parts = safeRelative(rel).split("/");
    const target = path.join(targetRoot, ...parts);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, ...parts), target);
  }
}

function createBackendBundles({
  userDataRoot,
  builtin,
  installId,
  logger = null,
  pollMs = 5_000,
}) {
  if (!userDataRoot || !path.isAbsolute(userDataRoot)) throw new Error("Backend bundle root must be absolute");
  const root = path.join(userDataRoot, "backend");
  const incomingRoot = path.join(root, "incoming");
  const pointerPath = path.join(root, "active.json");
  const installPath = path.join(root, "installed.json");
  fs.mkdirSync(incomingRoot, { recursive: true });
  let incomingTimer = null;
  let applying = false;

  const readJson = (filePath) => {
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
  };
  const writeJson = (filePath, value) => {
    const temporary = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, filePath);
  };

  // A fresh install ships its own backend, which is newer than any bundle deployed before it.
  if (installId && readJson(installPath)?.installId !== installId) {
    try { fs.rmSync(pointerPath, { force: true }); } catch {}
    writeJson(installPath, { installId, at: new Date().toISOString() });
    logger?.info?.("backend.install_detected", { installId });
  }

  function bundleInfo(id) {
    const bundleRoot = path.join(root, id);
    return {
      source: "bundle",
      id,
      codeRoot: bundleRoot,
      appHandlerRoot: path.join(bundleRoot, "app-handler"),
      resourcesRoot: bundleRoot,
    };
  }

  /** The backend to load: the active bundle when it is intact, otherwise the one the installer shipped. */
  function current() {
    const id = readJson(pointerPath)?.id;
    if (typeof id === "string" && BUNDLE_ID_PATTERN.test(id)) {
      try {
        readManifest(path.join(root, id));
        return bundleInfo(id);
      } catch (error) {
        logger?.warn?.("backend.bundle_unusable", { id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { source: "builtin", id: "builtin", ...builtin };
  }

  function requireModule(info, name) {
    if (!BACKEND_MODULES.includes(name)) throw new Error(`Not a backend module: ${name}`);
    return require(path.join(info.codeRoot, "electron", name));
  }

  /** Verify a bundle directory, copy it into place, and make it the active backend. */
  function install(sourceRoot) {
    const manifest = verifyBundle(sourceRoot);
    const target = path.join(root, manifest.id);
    if (!fs.existsSync(target)) {
      const staging = path.join(root, `.staging-${manifest.id}-${process.pid}`);
      fs.rmSync(staging, { recursive: true, force: true });
      copyListed(sourceRoot, staging, manifest);
      verifyBundle(staging);
      fs.renameSync(staging, target);
    } else {
      verifyBundle(target);
    }
    writeJson(pointerPath, { id: manifest.id, activatedAt: new Date().toISOString() });
    prune(manifest.id);
    logger?.info?.("backend.bundle_activated", { id: manifest.id, builtAt: manifest.builtAt });
    return manifest;
  }

  /** Go back to the backend the installer shipped. */
  function useBuiltin() {
    fs.rmSync(pointerPath, { force: true });
  }

  function prune(activeId) {
    let bundles;
    try {
      bundles = fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && BUNDLE_ID_PATTERN.test(entry.name) && entry.name !== "incoming")
        .map((entry) => ({ id: entry.name, at: fs.statSync(path.join(root, entry.name)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
    } catch {
      return;
    }
    for (const bundle of bundles.slice(KEEP_BUNDLES)) {
      if (bundle.id === activeId) continue;
      try { fs.rmSync(path.join(root, bundle.id), { recursive: true, force: true }); } catch {}
    }
  }

  /**
   * Watch <userData>/backend/incoming/<id>/ for a deployed bundle. A deployment writes the
   * READY marker last; the bundle is then installed and onInstalled restarts the backend.
   */
  function watchIncoming(onInstalled) {
    if (incomingTimer) return;
    incomingTimer = setInterval(async () => {
      if (applying) return;
      let ready;
      try {
        ready = fs.readdirSync(incomingRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(incomingRoot, entry.name, READY_MARKER)));
      } catch {
        return;
      }
      if (!ready.length) return;
      applying = true;
      const source = path.join(incomingRoot, ready[0].name);
      try {
        const manifest = install(source);
        await onInstalled(manifest);
      } catch (error) {
        logger?.warn?.("backend.incoming_failed", { name: ready[0].name, message: error instanceof Error ? error.message : String(error) });
      } finally {
        try { fs.rmSync(source, { recursive: true, force: true }); } catch {}
        applying = false;
      }
    }, pollMs);
    incomingTimer.unref?.();
  }

  function stopWatching() {
    if (incomingTimer) clearInterval(incomingTimer);
    incomingTimer = null;
  }

  return Object.freeze({ root, incomingRoot, current, requireModule, install, useBuiltin, watchIncoming, stopWatching });
}

module.exports = {
  BACKEND_MODULES,
  MANIFEST_NAME,
  READY_MARKER,
  SCHEMA_VERSION,
  createBackendBundles,
  readManifest,
  sha256File,
  verifyBundle,
};
