"use strict";

/**
 * Declarative launch + visual metadata for Coding Tools app modules.
 *
 * Every `app-handler/<id>/module.json` may carry a `launch` block (how and when
 * Coding Tools brings the module up after its own core is ready) and a `visual`
 * block (how the original upstream UI is embedded under the "More" entry).
 * This file owns the defaults and validation so that neither the Electron main
 * process nor the renderer hardcodes ports, ready timeouts or ordering; a new
 * build only needs the shipped module.json files plus the persisted apps config.
 */

const STARTUP_POLICIES = Object.freeze(["auto", "installed-only", "manual"]);
const EMBED_MODES = Object.freeze(["iframe", "file", "none"]);
const DEFAULT_READY_TIMEOUT_MS = 45_000;
const MAX_READY_TIMEOUT_MS = 15 * 60_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const LAUNCH_DEFAULTS = Object.freeze({
  order: 100,
  autoStart: true,
  startupPolicy: "auto",
  installOnStartup: true,
  dependsOn: Object.freeze([]),
  requires: Object.freeze(["core-runtime"]),
  readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
});

const VISUAL_DEFAULTS = Object.freeze({
  embed: "none",
  endpoint: "",
  manifest: "",
  initialSection: "",
  controls: Object.freeze([]),
  icon: "globe",
  navGroup: "more",
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Launch manifest numeric field is invalid");
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function stringList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`Launch manifest ${label} must be an array`);
  const seen = new Set();
  const list = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`Launch manifest ${label} entries must be non-empty strings`);
    }
    const id = entry.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    list.push(id);
  }
  return list;
}

function loopbackEndpoint(value, label) {
  if (value === undefined || value === null || value === "") return "";
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error(`Visual manifest ${label} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Visual manifest ${label} must use HTTP or HTTPS`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`Visual manifest ${label} is restricted to loopback hosts`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Visual manifest ${label} must not contain credentials`);
  }
  parsed.hash = "";
  parsed.search = "";
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
}

function normalizeLaunchManifest(moduleJson = {}) {
  const raw = isPlainObject(moduleJson.launch) ? moduleJson.launch : {};
  const startupPolicy = raw.startupPolicy === undefined ? LAUNCH_DEFAULTS.startupPolicy : String(raw.startupPolicy);
  if (!STARTUP_POLICIES.includes(startupPolicy)) {
    throw new Error(`Launch manifest startupPolicy is invalid: ${startupPolicy}`);
  }
  return Object.freeze({
    order: boundedInteger(raw.order, LAUNCH_DEFAULTS.order, { min: 0, max: 10_000 }),
    autoStart: raw.autoStart === undefined ? LAUNCH_DEFAULTS.autoStart : raw.autoStart === true,
    startupPolicy,
    installOnStartup: raw.installOnStartup === undefined
      ? LAUNCH_DEFAULTS.installOnStartup
      : raw.installOnStartup === true,
    dependsOn: Object.freeze(stringList(raw.dependsOn, "dependsOn")),
    requires: Object.freeze(raw.requires === undefined ? [...LAUNCH_DEFAULTS.requires] : stringList(raw.requires, "requires")),
    readyTimeoutMs: boundedInteger(raw.readyTimeoutMs, LAUNCH_DEFAULTS.readyTimeoutMs, {
      min: 1_000,
      max: MAX_READY_TIMEOUT_MS,
    }),
  });
}

function normalizeVisualManifest(moduleJson = {}) {
  const raw = isPlainObject(moduleJson.visual) ? moduleJson.visual : {};
  const embed = raw.embed === undefined ? VISUAL_DEFAULTS.embed : String(raw.embed);
  if (!EMBED_MODES.includes(embed)) {
    throw new Error(`Visual manifest embed mode is invalid: ${embed}`);
  }
  return Object.freeze({
    embed,
    endpoint: loopbackEndpoint(raw.endpoint, "endpoint"),
    manifest: typeof raw.manifest === "string" ? raw.manifest.trim() : VISUAL_DEFAULTS.manifest,
    initialSection: typeof raw.initialSection === "string" ? raw.initialSection.trim() : VISUAL_DEFAULTS.initialSection,
    controls: Object.freeze(stringList(raw.controls, "controls")),
    icon: typeof raw.icon === "string" && raw.icon.trim() ? raw.icon.trim() : VISUAL_DEFAULTS.icon,
    navGroup: typeof raw.navGroup === "string" && raw.navGroup.trim() ? raw.navGroup.trim() : VISUAL_DEFAULTS.navGroup,
  });
}

/**
 * Orders module IDs by `dependsOn` (dependencies first) and then by `order`.
 * Unknown dependencies are ignored so a module can never block itself on a
 * module that is not shipped. Cycles fall back to declared order.
 */
function orderModules(launchById) {
  const ids = Object.keys(launchById);
  const byOrder = [...ids].sort((a, b) => {
    const delta = (launchById[a]?.order ?? LAUNCH_DEFAULTS.order) - (launchById[b]?.order ?? LAUNCH_DEFAULTS.order);
    return delta !== 0 ? delta : a.localeCompare(b);
  });
  const known = new Set(ids);
  const placed = [];
  const placedSet = new Set();
  const visiting = new Set();

  function visit(id) {
    if (placedSet.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const dependency of launchById[id]?.dependsOn || []) {
      if (known.has(dependency)) visit(dependency);
    }
    visiting.delete(id);
    if (!placedSet.has(id)) {
      placedSet.add(id);
      placed.push(id);
    }
  }

  for (const id of byOrder) visit(id);
  return placed;
}

module.exports = Object.freeze({
  DEFAULT_READY_TIMEOUT_MS,
  EMBED_MODES,
  LAUNCH_DEFAULTS,
  STARTUP_POLICIES,
  VISUAL_DEFAULTS,
  normalizeLaunchManifest,
  normalizeVisualManifest,
  orderModules,
});
