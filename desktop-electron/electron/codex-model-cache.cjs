"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Codex keeps the model list it fetched last in <CODEX_HOME>/models_cache.json, one file for every
// Codex on the machine. Through the bridge that list carries the WebGPT rows (chatgpt-web/*). A
// Codex started while the bridge route was out of config.toml keeps asking OpenAI directly until it
// restarts, and writes a list without them. On 2026-11-09 the Codex app had run since the day
// before, when the bridge was down: its 01:37 refresh listed 10 models and no WebGPT row, while the
// app's own Codex servers fetched through the bridge and had marked the catalog verified.
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const WEB_PREFIX = "chatgpt-web/";

/**
 * Reads Codex's model cache: when it was fetched, by which Codex version, and whether it lists
 * WebGPT models. null when there is no readable cache. Reads only slugs, the time and the version.
 */
async function readCodexModelCache(codexHome, { fsp = fs.promises } = {}) {
  if (typeof codexHome !== "string" || !codexHome) return null;
  const file = path.join(codexHome, "models_cache.json");
  let stat;
  try { stat = await fsp.stat(file); } catch { return null; }
  if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return null;
  try {
    const cache = JSON.parse(await fsp.readFile(file, "utf8"));
    const fetchedAt = Date.parse(cache?.fetched_at);
    if (!Number.isFinite(fetchedAt) || !Array.isArray(cache.models)) return null;
    return {
      fetchedAt,
      modifiedAt: stat.mtimeMs,
      clientVersion: typeof cache.client_version === "string" ? cache.client_version.slice(0, 40) : null,
      webModels: cache.models.some((model) => typeof model?.slug === "string" && model.slug.startsWith(WEB_PREFIX)),
    };
  } catch {
    return null;
  }
}

/**
 * Whether a Codex goes around the bridge: its latest model list was fetched after the bridge last
 * answered one, and has no WebGPT model. `bridgeServedAt` is the bridge's
 * last_successful_model_catalog_request_at (ms). A list from before that answer says nothing: it
 * may predate the route.
 */
function codexSkipsBridge(cache, bridgeServedAt) {
  return Boolean(cache) && Number.isFinite(bridgeServedAt) && cache.fetchedAt > bridgeServedAt && !cache.webModels;
}

// How long no list may go around the bridge before "Restart Codex" clears. The cache names a Codex
// version, not a process: on 2026-11-12 the Codex app (running since 11-08) went around the bridge
// every 8 to 23 minutes, and the app's own Codex servers, the same 0.164.0, listed WebGPT through it
// in between. Clearing at that next list switched the notice off and on 35 times in three hours.
const QUIET_MS = 45 * 60_000;

/**
 * Watches Codex's model cache while the bridge route is in place and keeps "Restart Codex" up for
 * as long as a Codex goes around it (the catalog check stops at the first Codex that asks the
 * bridge, which can be the app's own). Clears it once a list fetched `quietMs` after the last one
 * that went around lists the WebGPT models, whichever version wrote it (a restarted Codex may be
 * a newer one). One stat a minute; the file is read only when it changed.
 * `routed()`: whether the bridge route is installed. `bridgeServedAt()`: async, ms or NaN.
 * `restartRequired()` / `setRestartRequired(boolean)`: the shown notice. `now()`: ms.
 */
function watchCodexModelCache({ codexHome, routed, bridgeServedAt, restartRequired, setRestartRequired, logger,
  intervalMs = 60_000, quietMs = QUIET_MS, read = readCodexModelCache, now = Date.now,
  setInterval: every = setInterval, clearInterval: stop = clearInterval }) {
  // The notice is saved with the app's settings; when a Codex last went around the bridge is not. One
  // already up at the start (from before the app restarted) counts as a list around the bridge now:
  // with none seen, no list could clear it, and the notice has no button (2026-11-12). One that a setup
  // step raised is cleared by the catalog check first, once the bridge serves the models.
  let modifiedAt = null, skippedAt = restartRequired() ? now() : null, busy = false;
  const check = async () => {
    if (busy || !routed()) return;
    busy = true;
    try {
      const cache = await read(codexHome);
      if (!cache || cache.modifiedAt === modifiedAt) return;
      modifiedAt = cache.modifiedAt;
      if (cache.webModels) {
        if (skippedAt !== null && cache.fetchedAt - skippedAt >= quietMs && restartRequired()) {
          skippedAt = null;
          setRestartRequired(false);
          logger?.info?.("codex.model_cache_through_bridge", { clientVersion: cache.clientVersion });
        }
        return;
      }
      if (!codexSkipsBridge(cache, await bridgeServedAt())) return;
      skippedAt = cache.fetchedAt;
      if (!restartRequired()) {
        setRestartRequired(true);
        logger?.warn?.("codex.model_cache_skips_bridge", { clientVersion: cache.clientVersion, fetchedAt: new Date(cache.fetchedAt).toISOString() });
      }
    } catch {
      // The next minute tries again.
    } finally {
      busy = false;
    }
  };
  const timer = every(() => void check(), intervalMs);
  timer?.unref?.();
  return { check, stop: () => stop(timer) };
}

module.exports = { readCodexModelCache, codexSkipsBridge, watchCodexModelCache, QUIET_MS };
