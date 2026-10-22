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

const strings = (values) => (Array.isArray(values) ? values.filter((id) => typeof id === "string") : []);

/**
 * A stable revision of the models the switcher serves, as its /v1/models builds them: its known
 * models plus the per-model settings' ids, or with exposeCatalog the known models plus the
 * upstream catalog it caches in its metadata (`catalog`), which refreshes hourly.
 */
function clineModelsRevision(config, meta = null) {
  if (!config || typeof config !== "object") return null;
  const known = strings(config.knownModels);
  const exposed = config.exposeCatalog === true;
  const extra = exposed ? strings(meta?.catalog)
    : config.perModel && typeof config.perModel === "object" ? Object.keys(config.perModel) : [];
  const ids = [...new Set([...known, ...extra])].sort();
  return crypto.createHash("sha256").update(JSON.stringify({ ids, catalog: exposed })).digest("hex").slice(0, 16);
}

// Read off the main thread: this runs every 15 s, and the synchronous reads (the metadata holds
// a growing request history) stalled the whole app for seconds on the busy hard disk.
const readJson = async (file) => {
  try { return JSON.parse(await fs.promises.readFile(file, "utf8")); } catch { return null; }
};

/**
 * Brings the marker's revision up to the switcher's model list. Resolves to true when it rewrote
 * the marker. Leaves alone a marker that is missing or is not the switcher's bridge marker.
 */
async function syncClineMarker(stateRoot) {
  const data = path.join(stateRoot, "cline-pass-switcher-data");
  const config = await readJson(path.join(data, "config.json"));
  // The metadata also holds request history; read it only when the catalog is served.
  const revision = clineModelsRevision(config, config?.exposeCatalog === true ? await readJson(path.join(data, "metadata.json")) : null);
  if (!revision) return false;
  const markerFile = path.join(stateRoot, "auth", "cline-pass-switcher.json");
  const marker = await readJson(markerFile);
  if (!marker || marker.type !== "cline" || marker.switcher !== true) return false;
  if (marker.modelsRevision === revision) return false;
  writePrivateFileAtomic(markerFile, `${JSON.stringify({ ...marker, modelsRevision: revision })}\n`);
  return true;
}

// The switcher learns new Cline Pass models (deepseek-v4.1-flash-1017, released on 19 Oct) only
// when someone presses its "fetch official models" button. CPA serves the plugin's management
// routes, so the watcher asks for that fetch itself: a minute after CPA starts, then every 6 hours.
// A model it adds lands in the switcher's config, and the marker check above takes it to CPA.
const REFRESH_FIRST_MS = 60_000;
const REFRESH_EVERY_MS = 6 * 60 * 60_000;

async function refreshClineModels({ baseUrl, managementKey, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl}/v0/management/cline-pass-switcher/api/fetch-official-models`, {
    method: "POST", headers: { Authorization: `Bearer ${managementKey}`, "Content-Type": "application/json" }, body: "{}",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json().catch(() => null);
  return Array.isArray(body?.added) ? body.added.filter((id) => typeof id === "string") : [];
}

function watchCpaPluginModels({ stateRoot, logger = console, intervalMs = INTERVAL_MS, refresh = null }) {
  // A check still reading on a slow disk is not joined by another one.
  let running = null;
  const check = () => running ??= syncClineMarker(stateRoot).then((changed) => {
    if (changed) logger.info?.("cpa.plugin_models_changed", { plugin: "cline-pass-switcher" });
  }, (error) => {
    logger.warn?.("cpa.plugin_models_sync_failed", { message: String(error?.message ?? error).slice(0, 200) });
  }).finally(() => { running = null; });
  const ready = check();
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  // refresh: { baseUrl, managementKey } of the managed loopback CPA, to keep Cline Pass's list current.
  const timers = [];
  if (refresh?.baseUrl && refresh.managementKey) {
    const pull = () => void refreshClineModels(refresh).then((added) => {
      if (added.length) { logger.info?.("cpa.cline_models_added", { added }); check(); }
    }).catch((error) => logger.warn?.("cpa.cline_models_refresh_failed", { message: String(error?.message ?? error).slice(0, 200) }));
    const first = setTimeout(pull, refresh.firstMs ?? REFRESH_FIRST_MS);
    const every = setInterval(pull, refresh.everyMs ?? REFRESH_EVERY_MS);
    first.unref?.(); every.unref?.();
    timers.push(() => clearTimeout(first), () => clearInterval(every));
  }
  return { check, ready, stop: () => { clearInterval(timer); for (const clear of timers) clear(); } };
}

module.exports = { clineModelsRevision, syncClineMarker, watchCpaPluginModels, refreshClineModels };
