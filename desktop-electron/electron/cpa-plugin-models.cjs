"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

// CPA asks a plugin for its models only when it loads the plugin's auth file, and the app keeps
// CPA running across installs: a model the Cline Pass switcher learned later (deepseek-v4.1-flash,
// synced on 15 Oct while CPA had run since 12 Oct) showed in the auth file's Models dialog, which
// asks the plugin live, but never in CPA's /v1/models, so no chat could pick it. The switcher's
// model list lives in its own config; when that list changes, the credential-free bridge marker
// is rewritten with the list's revision, and CPA's auth watcher reloads it and re-reads the models.

const INTERVAL_MS = 15_000;

/** A stable revision of the models the switcher serves (what its /v1/models lists). */
function clineModelsRevision(config) {
  if (!config || typeof config !== "object") return null;
  const known = Array.isArray(config.knownModels) ? config.knownModels.filter((id) => typeof id === "string") : [];
  const tuned = config.perModel && typeof config.perModel === "object" ? Object.keys(config.perModel) : [];
  const ids = [...new Set([...known, ...tuned])].sort();
  return crypto.createHash("sha256").update(JSON.stringify({ ids, catalog: config.exposeCatalog === true })).digest("hex").slice(0, 16);
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
};

/**
 * Brings the marker's revision up to the switcher's model list. Returns true when it rewrote
 * the marker. Leaves alone a marker that is missing or is not the switcher's bridge marker.
 */
function syncClineMarker(stateRoot) {
  const config = readJson(path.join(stateRoot, "cline-pass-switcher-data", "config.json"));
  const revision = clineModelsRevision(config);
  if (!revision) return false;
  const markerFile = path.join(stateRoot, "auth", "cline-pass-switcher.json");
  const marker = readJson(markerFile);
  if (!marker || marker.type !== "cline" || marker.switcher !== true) return false;
  if (marker.modelsRevision === revision) return false;
  writePrivateFileAtomic(markerFile, `${JSON.stringify({ ...marker, modelsRevision: revision })}\n`);
  return true;
}

function watchCpaPluginModels({ stateRoot, logger = console, intervalMs = INTERVAL_MS }) {
  const check = () => {
    try {
      if (syncClineMarker(stateRoot)) logger.info?.("cpa.plugin_models_changed", { plugin: "cline-pass-switcher" });
    } catch (error) {
      logger.warn?.("cpa.plugin_models_sync_failed", { message: String(error?.message ?? error).slice(0, 200) });
    }
  };
  check();
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  return { check, stop: () => clearInterval(timer) };
}

module.exports = { clineModelsRevision, syncClineMarker, watchCpaPluginModels };
