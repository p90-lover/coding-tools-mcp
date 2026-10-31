"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { readStateFile, writeStateFile } = require("./durable-state.cjs");
const { terminateOwnedProcessTree } = require("./process-tree.cjs");
const { publicUrlMap } = require("./five-stack-cross-use.cjs");
const { buildLoopbackMesh, loopbackMeshEnvironment, persistLoopbackMesh } = require("./loopback-mesh.cjs");

const STORE_VERSION = 1;
const SERVICE_IDS = Object.freeze(["cpa"]);
const SERVICE_ID_SET = new Set(SERVICE_IDS);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const CALLER_KEY = /^[A-Za-z0-9_-]{32,}$/;
const DEFAULT_INSPECT_TIMEOUT_MS = 12_000;
const STOP_TIMEOUT_MS = 5_000;
const KEEP_ALIVE_POLL_MS = 20_000;
const KEEP_ALIVE_LEASE_WRITE_MS = 5 * 60_000;
const KEEP_ALIVE_BACKOFF_CAP_MS = 60_000;
const KEEP_ALIVE_STABLE_RESET_MS = 120_000;
const PASEO_STALE_MS = 90_000;
const HTTP_STALE_MS = 120_000;

const DEFAULTS = Object.freeze({
  cpa: Object.freeze({
    name: "CPA / CLIProxyAPI",
    endpoint: "http://127.0.0.1:8317/",
    home: "",
    executable: "",
    arguments: [],
    enabled: true,
    autoStart: false,
    keepAlive: false,
  }),
  paseo: Object.freeze({
    name: "Paseo",
    endpoint: "http://127.0.0.1:6768/",
    executionEndpoint: "ws://127.0.0.1:6768/ws",
    home: "",
    executable: process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm",
    arguments: process.platform === "win32"
      ? ["/d", "/s", "/c", "npm", "run", "dev:server"]
      : ["run", "dev:server"],
    enabled: true,
    autoStart: false,
    keepAlive: false,
  }),
  anneal: Object.freeze({
    name: "Anneal",
    endpoint: "http://127.0.0.1:3000/",
    executionEndpoint: "http://127.0.0.1:3000/",
    home: "",
    executable: process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm",
    arguments: process.platform === "win32"
      ? ["/d", "/s", "/c", "npm", "run", "dev:web"]
      : ["run", "dev:web"],
    enabled: true,
    autoStart: false,
    keepAlive: false,
  }),
});

function requiredServiceId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!SERVICE_ID_SET.has(id)) throw new Error(`Unknown external service: ${id || "missing"}`);
  return id;
}

function optionalText(value, maximum = 2_048) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Text value is invalid");
  const normalized = value.trim();
  if (!normalized) return "";
  if (normalized.length > maximum) throw new Error("Text value is too long");
  return normalized;
}

function normalizeArguments(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Service arguments must be an array");
  if (value.length > 64) throw new Error("Service argument limit exceeded");
  return value.map((argument) => {
    if (typeof argument !== "string") throw new Error("Service arguments must be strings");
    if (argument.includes("\0")) throw new Error("Service arguments must not contain null bytes");
    if (argument.length > 2_048) throw new Error("Service argument is too long");
    return argument;
  });
}

function normalizeLoopbackServiceEndpoint(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("External service endpoint must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("External service endpoints must use HTTP or HTTPS");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("External services are restricted to loopback hosts");
  }
  if (parsed.username || parsed.password) {
    throw new Error("External service endpoints must not contain credentials");
  }
  parsed.search = "";
  parsed.hash = "";
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
}

function normalizeLoopbackExecutionEndpoint(value, serviceId) {
  const id = requiredServiceId(serviceId);
  if (id !== "paseo" && id !== "anneal") {
    throw new Error(`Service ${id} does not expose an execution endpoint`);
  }
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${DEFAULTS[id].name} execution endpoint must be a valid URL`);
  }
  const allowed = id === "paseo"
    ? new Set(["ws:", "wss:"])
    : new Set(["http:", "https:"]);
  if (!allowed.has(parsed.protocol)) {
    throw new Error(
      id === "paseo"
        ? "Paseo execution endpoint must use WebSocket (WS or WSS)"
        : "Anneal execution endpoint must use HTTP or HTTPS",
    );
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("Execution endpoints are restricted to loopback hosts");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Execution endpoints must not contain credentials, query parameters, or fragments");
  }
  if (id === "anneal" && !parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
}

function parseFallbackKey(text) {
  const bytes = Buffer.from(text.trim(), "base64");
  if (bytes.length !== 32) throw new Error("The fallback key is not 32 bytes");
  return bytes;
}

function createSecretCodec({ safeStorage, keyPath }) {
  let fallbackKey = null;

  function encryptionAvailable() {
    try {
      return Boolean(safeStorage?.isEncryptionAvailable?.());
    } catch {
      return false;
    }
  }

  function loadFallbackKey() {
    if (fallbackKey) return fallbackKey;
    // A torn key file is read from its copy; one with no usable copy is set aside, never written
    // over, so the secrets it encrypted can still be recovered by hand (durable-state.cjs).
    const read = readStateFile(keyPath, parseFallbackKey);
    if (read.value) {
      fallbackKey = read.value;
      if (read.source === "backup") writeStateFile(keyPath, `${fallbackKey.toString("base64")}\n`);
      return fallbackKey;
    }
    fallbackKey = crypto.randomBytes(32);
    writeStateFile(keyPath, `${fallbackKey.toString("base64")}\n`);
    return fallbackKey;
  }

  function encrypt(value) {
    const plain = JSON.stringify(value);
    if (encryptionAvailable()) {
      return {
        scheme: "electron-safe-storage-v1",
        data: safeStorage.encryptString(plain).toString("base64"),
      };
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", loadFallbackKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return {
      scheme: "aes-256-gcm-v1",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    };
  }

  function decrypt(envelope) {
    if (!envelope || typeof envelope !== "object") return null;
    try {
      if (envelope.scheme === "electron-safe-storage-v1" && encryptionAvailable()) {
        return JSON.parse(safeStorage.decryptString(Buffer.from(envelope.data, "base64")));
      }
      if (envelope.scheme !== "aes-256-gcm-v1") return null;
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        loadFallbackKey(),
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plain);
    } catch {
      return null;
    }
  }

  return Object.freeze({ encrypt, decrypt });
}

function initialState(env) {
  return {
    version: STORE_VERSION,
    services: Object.fromEntries(SERVICE_IDS.map((id) => {
      const defaults = DEFAULTS[id];
      const environmentHome = id === "paseo"
        ? env.CODING_TOOLS_PASEO_HOME
        : id === "anneal"
          ? env.CODING_TOOLS_ANNEAL_HOME
          : "";
      const environmentEndpoint = id === "paseo"
        ? env.CODING_TOOLS_PASEO_URL
        : id === "anneal"
          ? env.CODING_TOOLS_ANNEAL_URL
: env.CODING_TOOLS_CPA_URL;
      const environmentExecutionEndpoint = id === "paseo"
        ? env.CODING_TOOLS_PASEO_EXECUTION_URL
        : id === "anneal"
          ? env.CODING_TOOLS_ANNEAL_EXECUTION_URL
          : undefined;
      return [id, {
        ...defaults,
        endpoint: normalizeLoopbackServiceEndpoint(environmentEndpoint || defaults.endpoint),
        ...(defaults.executionEndpoint ? {
          executionEndpoint: normalizeLoopbackExecutionEndpoint(
            environmentExecutionEndpoint || defaults.executionEndpoint,
            id,
          ),
        } : {}),
        home: optionalText(environmentHome) || defaults.home,
      }];
    })),
    secrets: {},
  };
}

function normalizeState(value, env) {
  const fallback = initialState(env);
  if (!value || value.version !== STORE_VERSION || typeof value.services !== "object") return fallback;
  const services = {};
  for (const id of SERVICE_IDS) {
    const defaults = fallback.services[id];
    const input = value.services[id] && typeof value.services[id] === "object"
      ? value.services[id]
      : {};
    let endpoint = defaults.endpoint;
    try { endpoint = normalizeLoopbackServiceEndpoint(input.endpoint || defaults.endpoint); } catch {}
    let executionEndpoint = defaults.executionEndpoint;
    if (executionEndpoint) {
      try {
        executionEndpoint = normalizeLoopbackExecutionEndpoint(
          input.executionEndpoint || defaults.executionEndpoint,
          id,
        );
      } catch {}
    }
    services[id] = {
      ...defaults,
      endpoint,
      ...(executionEndpoint ? { executionEndpoint } : {}),
      home: typeof input.home === "string" ? input.home : defaults.home,
      executable: typeof input.executable === "string" ? input.executable : defaults.executable,
      arguments: Array.isArray(input.arguments)
        ? input.arguments.filter((entry) => typeof entry === "string").slice(0, 64)
        : [...defaults.arguments],
      enabled: id !== "paseo" && input.enabled !== false,
      autoStart: id !== "paseo" && input.autoStart === true,
      keepAlive: id !== "paseo" && input.keepAlive === true,
    };
  }
  return {
    version: STORE_VERSION,
    services,
    secrets: value.secrets && typeof value.secrets === "object" && Object.hasOwn(value.secrets, "cpa")
      ? { cpa: value.secrets.cpa }
      : {},
  };
}

function countModels(payload) {
  if (Array.isArray(payload)) return payload.length;
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload.data)) return payload.data.length;
  if (Array.isArray(payload.models)) return payload.models.length;
  return null;
}

function nextKeepAliveDelayMs(attempts, random = Math.random) {
  const exponent = Math.min(Math.max(Number(attempts) || 0, 0), 6);
  const base = Math.min(KEEP_ALIVE_BACKOFF_CAP_MS, 1_000 * (2 ** exponent));
  const jitter = Math.floor(random() * 250);
  return Math.max(1_000, base + jitter);
}

function staleWindowMs(id) {
  return id === "paseo" ? PASEO_STALE_MS : HTTP_STALE_MS;
}

const SNAPSHOT_RELATIVE = /^snapshots\/[a-f0-9-]{36}$/;
// The archive refusing its sources (a missing key for encrypted secrets, linked or odd files): the
// one failure that must stop startup, since going on could replace secrets nothing can decrypt.
const ARCHIVE_REFUSED = "ARCHIVE_REFUSED";
function archiveRefusal(message) {
  return Object.assign(new Error(message), { code: ARCHIVE_REFUSED });
}
// Retired services never run again: their state under integrations/state/ is frozen.
const isRetiredState = (relative) => relative.startsWith("integrations/state/");

// The retired-state entries (sources and stats) of the latest snapshot, or null when there is
// no snapshot yet or it predates recorded stats.
function archivedRetiredState(archiveRoot) {
  try {
    if (!fs.existsSync(path.join(archiveRoot, "manifest.json"))) return null;
    let destination = archiveRoot;
    const pointer = path.join(archiveRoot, "latest.json");
    if (fs.existsSync(pointer)) {
      const relative = JSON.parse(fs.readFileSync(pointer, "utf8")).relative;
      if (typeof relative !== "string" || !SNAPSHOT_RELATIVE.test(relative)) return null;
      destination = path.join(archiveRoot, relative);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, "manifest.json"), "utf8"));
    if (!manifest?.stats) return null;
    const sources = {};
    const stats = {};
    for (const [relative, source] of Object.entries(manifest.sources || {})) {
      if (!relative.startsWith("integrations/state/") || !manifest.stats[relative]) continue;
      sources[relative] = source;
      stats[relative] = manifest.stats[relative];
    }
    return Object.keys(sources).length ? { sources, stats } : null;
  } catch {
    return null;
  }
}

function archiveRetiredServicesState({ filePath, keyPath, archiveDataRoot = null }) {
  const privateRoot = path.dirname(filePath);
  if (archiveDataRoot) {
    const relative = path.relative(privateRoot, archiveDataRoot);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw archiveRefusal("Paseo archive source must remain inside private userData");
    }
  }
  const sources = {};
  // Size and mtime of each source let later launches confirm an unchanged archive without
  // reading it: retired services never run again, and their state can be a gigabyte.
  const stats = {};
  const statOf = (info) => ({ size: info.size, mtimeMs: Math.trunc(info.mtimeMs) });
  const sameStat = (a, b) => Boolean(a && b) && a.size === b.size && a.mtimeMs === b.mtimeMs;
  const sameBytes = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; } };
  function include(source, relative) {
    if (!fs.existsSync(source)) return;
    const info = fs.lstatSync(source);
    if (info.isSymbolicLink()) throw archiveRefusal("Paseo archive refuses linked state");
    if (info.isDirectory()) {
      for (const entry of fs.readdirSync(source)) include(path.join(source, entry), path.join(relative, entry));
    } else if (info.isFile()) {
      const key = relative.split(path.sep).join("/");
      sources[key] = source;
      stats[key] = statOf(info);
    } else {
      throw archiveRefusal("Paseo archive requires regular files");
    }
  }
  include(filePath, "external-services.json");
  include(keyPath, "external-services.key");
  if (archiveDataRoot) {
    include(path.join(archiveDataRoot, "managed-components.secrets.json"), "integrations/managed-components.secrets.json");
    include(path.join(archiveDataRoot, "managed-components.key"), "integrations/managed-components.key");
    // Retired state is frozen: once a snapshot has recorded it with stats, reuse those entries
    // instead of walking it again (codex-router alone holds a whole Python environment).
    const archived = archivedRetiredState(path.join(privateRoot, "archives", "retired-services"));
    if (archived) {
      Object.assign(sources, archived.sources);
      Object.assign(stats, archived.stats);
    } else {
      for (const id of ["paseo", "codex-router", "commandcode-proxy", "anneal"]) {
        include(path.join(archiveDataRoot, "state", id), `integrations/state/${id}`);
      }
    }
  }
  if (Object.keys(sources).length === 0) return null;
  const encrypted = (value) => value && typeof value === "object" && value.scheme === "aes-256-gcm-v1";
  let saved;
  try { saved = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { saved = null; }
  if (Object.values(saved?.secrets || {}).some(encrypted) && !fs.existsSync(keyPath)) {
    throw archiveRefusal("Paseo archive requires the external service key");
  }
  const managedSecrets = archiveDataRoot && path.join(archiveDataRoot, "managed-components.secrets.json");
  if (managedSecrets && fs.existsSync(managedSecrets)) {
    const stored = JSON.parse(fs.readFileSync(managedSecrets, "utf8"));
    if (Object.values(stored?.components || {}).some(encrypted)
        && !fs.existsSync(path.join(archiveDataRoot, "managed-components.key"))) {
      throw archiveRefusal("Paseo archive requires the managed component key");
    }
  }

  const archiveRoot = path.join(privateRoot, "archives", "retired-services");
  const manifestPath = path.join(archiveRoot, "manifest.json");
  let destination = archiveRoot;
  let prior = null;
  if (fs.existsSync(manifestPath)) {
    const pointer = path.join(archiveRoot, "latest.json");
    if (fs.existsSync(pointer)) {
      const relative = JSON.parse(fs.readFileSync(pointer, "utf8")).relative;
      if (typeof relative !== "string" || !SNAPSHOT_RELATIVE.test(relative)) {
        throw new Error("Paseo archive pointer is invalid");
      }
      destination = path.join(archiveRoot, relative);
    }
    const previous = JSON.parse(fs.readFileSync(path.join(destination, "manifest.json"), "utf8"));
    const keys = Object.keys(sources).sort();
    const sameSources = keys.length === Object.keys(previous.sources || {}).length
      && keys.every((relative) => previous.sources[relative] === sources[relative]);
    // The launcher rewrites external-services.json with the same content on every start, so a
    // newer mtime alone does not mean a change. The small live files are compared by content, never
    // by stats: a rewrite of the same size within the same millisecond kept size and mtime and was
    // missed (CI, 2026-10-31). Retired state is frozen and can be a gigabyte, so its stats stand
    // for it. When only mtimes moved, nothing is written: refreshing the stats in place rewrote the
    // whole manifest (~10 MB: every retired file is listed) at each start to save the next start a
    // read of two small files.
    const sameLiveContent = (relative) => sameBytes(sources[relative], path.join(destination, relative));
    if (sameSources && previous.stats && keys.every((relative) => isRetiredState(relative)
      ? sameStat(previous.stats[relative], stats[relative]) : sameLiveContent(relative))) {
      return destination;
    }
    if (sameSources && !previous.stats
        && keys.every((relative) => fs.readFileSync(sources[relative]).equals(fs.readFileSync(path.join(destination, relative))))) {
      // A manifest from before stats were recorded: confirm by content once, then record them.
      writePrivateFileAtomic(path.join(destination, "manifest.json"), JSON.stringify({ schemaVersion: 1, sources, stats }, null, 2));
      return destination;
    }
    // Where the previous snapshot's retired state physically is: its own folder, or the earlier
    // snapshot its manifest points to ("" is the archive root, the very first snapshot).
    const stateRoot = previous.stateRoot === undefined ? path.relative(archiveRoot, destination).split(path.sep).join("/") : previous.stateRoot;
    if (typeof stateRoot !== "string" || (stateRoot !== "" && !SNAPSHOT_RELATIVE.test(stateRoot))) {
      throw new Error("Paseo archive state pointer is invalid");
    }
    prior = { root: destination, stats: previous.stats || {}, stateRoot };
    destination = path.join(archiveRoot, "snapshots", crypto.randomUUID());
  }
  // A change to the small live files (external-services.json, the keys) must not re-link the
  // frozen retired state into every new snapshot: that was ~23,000 hard links on the main thread
  // before the window opened (seen live: ~10 minutes on a hard disk). When none of it changed,
  // the new snapshot holds only the live files and its manifest names where the state already is.
  const retiredKeys = Object.keys(sources).filter(isRetiredState);
  const inheritState = Boolean(prior) && retiredKeys.length > 0
    && retiredKeys.every((relative) => sameStat(prior.stats[relative], stats[relative]));
  const madeDirs = new Set();
  for (const [relative, source] of Object.entries(sources)) {
    if (inheritState && isRetiredState(relative)) continue;
    const target = path.join(destination, relative);
    if (!madeDirs.has(path.dirname(target))) {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      madeDirs.add(path.dirname(target));
    }
    // An unchanged file is hard-linked from the previous snapshot instead of copied again: retired
    // state by its stats, a live file only when its bytes match (same size and mtime is not enough).
    const holder = prior && (isRetiredState(relative) ? path.join(archiveRoot, prior.stateRoot) : prior.root);
    if (prior && (isRetiredState(relative) ? sameStat(prior.stats[relative], stats[relative]) : sameBytes(source, path.join(holder, relative)))) {
      try {
        fs.linkSync(path.join(holder, relative), target);
        continue;
      } catch {
        // Different volume or no link support: fall back to a verified copy.
      }
    }
    fs.copyFileSync(source, target);
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
    if (!fs.readFileSync(source).equals(fs.readFileSync(target))) {
      throw new Error("Paseo archive copy could not be verified");
    }
  }
  // The manifest is written last, so a snapshot folder without one was interrupted (see removeIncompleteSnapshots).
  writePrivateFileAtomic(path.join(destination, "manifest.json"), JSON.stringify({
    schemaVersion: 1, sources, stats, ...(inheritState ? { stateRoot: prior.stateRoot } : {}),
  }, null, 2));
  if (destination !== archiveRoot) {
    writePrivateFileAtomic(path.join(archiveRoot, "latest.json"), JSON.stringify({ relative: path.relative(archiveRoot, destination).split(path.sep).join("/") }));
  }
  return destination;
}

const INCOMPLETE_SNAPSHOT_GRACE_MS = 10 * 60_000;

/**
 * Removes snapshot folders an interrupted launch left behind (killing the app mid-archive used to
 * leave a ~23,000-file folder each time). The manifest is written last, so a folder without one
 * never completed, and nothing names it: latest.json and stateRoot only point at completed
 * snapshots. This runs on fs.promises, off the main thread, so it never delays startup; leaves
 * alone a folder younger than the grace period (a launch may still be writing it); and never
 * follows links: a junction or symlink entry is skipped, rm unlinks links inside rather than
 * entering them, and a hard-linked file's data stays with its other names.
 */
async function removeIncompleteSnapshots(archiveRoot, { logger = null, now = Date.now() } = {}) {
  const snapshots = path.join(archiveRoot, "snapshots");
  let entries;
  try { entries = await fs.promises.readdir(snapshots, { withFileTypes: true }); } catch { return []; }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const folder = path.join(snapshots, entry.name);
    try {
      if (await fs.promises.access(path.join(folder, "manifest.json")).then(() => true, () => false)) continue;
      if (now - (await fs.promises.lstat(folder)).mtimeMs < INCOMPLETE_SNAPSHOT_GRACE_MS) continue;
      await fs.promises.rm(folder, { recursive: true, force: true });
      removed.push(entry.name);
    } catch (error) {
      logger?.warn?.("external_services.archive_cleanup_failed", { snapshot: entry.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (removed.length) logger?.info?.("external_services.archive_incomplete_removed", { count: removed.length });
  return removed;
}

// Completed snapshots kept besides those still read: the newest few, a short history of the live files.
const KEPT_SNAPSHOTS = 2;

/**
 * Removes completed snapshots nothing reads any more. Each change to the small live files writes a
 * new snapshot with its own manifest (~10 MB: every retired file is listed), and none was ever
 * removed (seen: 48 in a month, 480 MB of manifests alone). Only the snapshot latest.json names and
 * the one its manifest's stateRoot names are read; the newest few are kept too, with whatever their
 * stateRoots name. Anything unreadable stops the pass with nothing removed. Like
 * removeIncompleteSnapshots it runs off the main thread and never follows links, and a hard-linked
 * file of a removed snapshot stays on disk under the names kept snapshots give it.
 */
async function removeSupersededSnapshots(archiveRoot, { logger = null, keep = KEPT_SNAPSHOTS } = {}) {
  const snapshots = path.join(archiveRoot, "snapshots");
  const readJson = async (file) => JSON.parse(await fs.promises.readFile(file, "utf8"));
  const kept = new Set();
  let completed;
  try {
    const latest = (await readJson(path.join(archiveRoot, "latest.json"))).relative;
    if (typeof latest !== "string" || !SNAPSHOT_RELATIVE.test(latest)) return [];
    completed = [];
    for (const entry of await fs.promises.readdir(snapshots, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const info = await fs.promises.stat(path.join(snapshots, entry.name, "manifest.json")).catch(() => null);
      if (info) completed.push({ relative: `snapshots/${entry.name}`, mtimeMs: info.mtimeMs });
    }
    // Nothing to remove: skip reading manifests (each is ~10 MB of JSON).
    if (completed.length <= keep + 1) return [];
    completed.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const read = [latest, ...completed.slice(0, keep).map((snapshot) => snapshot.relative)];
    for (const relative of read) {
      kept.add(relative);
      const { stateRoot } = await readJson(path.join(archiveRoot, relative, "manifest.json"));
      if (stateRoot === undefined || stateRoot === "") continue;
      if (typeof stateRoot !== "string" || !SNAPSHOT_RELATIVE.test(stateRoot)) return [];
      kept.add(stateRoot);
    }
  } catch {
    return [];
  }
  const removed = [];
  for (const { relative } of completed) {
    if (kept.has(relative)) continue;
    try {
      await fs.promises.rm(path.join(archiveRoot, relative), { recursive: true, force: true });
      removed.push(relative.slice("snapshots/".length));
    } catch (error) {
      logger?.warn?.("external_services.archive_cleanup_failed", { snapshot: relative, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (removed.length) logger?.info?.("external_services.archive_superseded_removed", { count: removed.length, kept: kept.size });
  return removed;
}

function createExternalServicesController({
  filePath,
  keyPath,
  archiveDataRoot = null,
  loopbackMeshPath = null,
  safeStorage = null,
  logger = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  spawnProcess = spawn,
  terminateProcessTree = terminateOwnedProcessTree,
  getProviderSnapshot = null,
  getHealthHeaders = null,
  publish = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!filePath || !keyPath) throw new Error("External service state paths are required");
  const meshFilePath = loopbackMeshPath || path.join(path.dirname(filePath), "loopback-mesh.json");
  // A backup of frozen state: failing to take it (a full disk, a folder the system would not create,
  // a file in use, an earlier snapshot's unreadable manifest) is logged and the app starts anyway.
  // Thrown here, it stopped every launch (seen: "ENOSPC ... write" and "ENOENT ... mkdir
  // ...retired-services\snapshots\<id>", 2026-10-18/19). Its own refusals (a missing key for
  // encrypted secrets, linked state) still stop startup.
  // Deferred, the live file keeps its legacy data until a later launch archives it.
  let archiveDeferred = false;
  try {
    archiveRetiredServicesState({ filePath, keyPath, archiveDataRoot });
  } catch (error) {
    if (error?.code === ARCHIVE_REFUSED) throw error;
    archiveDeferred = true;
    logger?.warn?.("external_services.archive_failed", { code: error?.code ?? null, message: error instanceof Error ? error.message : String(error) });
  }
  const archiveRoot = path.join(path.dirname(filePath), "archives", "retired-services");
  void removeIncompleteSnapshots(archiveRoot, { logger }).then(() => removeSupersededSnapshots(archiveRoot, { logger }));
  const codec = createSecretCodec({ safeStorage, keyPath });
  let state;
  let unarchivedState = null;
  // A torn file is read from its last good copy (durable-state.cjs) instead of starting over with
  // every service's settings and secrets gone.
  let parsedText = null;
  const read = readStateFile(filePath, (text) => { const value = JSON.parse(text); parsedText = text; return value; });
  // What the file holds, when it was read whole from the file itself (not its copy): write() skips
  // the same bytes. The keep-alive lease rewrote it unchanged on the first healthy check after
  // every start and every 5 minutes after, each a flushed write that held every window up to 1.8 s
  // on the hard disk (2026-10-31); nothing reads the file's time, so the rewrite kept nothing alive.
  let savedText = read.source === "file" ? parsedText : null;
  if (read.source === "backup" || read.source === "unreadable") {
    logger?.warn?.("external_services.state_recovered", {
      source: read.source, setAside: read.setAside, message: read.error instanceof Error ? read.error.message : String(read.error ?? "missing"),
    });
  }
  if (read.source === "unreadable" && archiveDeferred) throw read.error;
  try {
    if (read.value === undefined) throw Object.assign(new Error("no saved state"), { code: "ENOENT" });
    state = normalizeState(read.value, env);
    if (archiveDeferred) unarchivedState = read.value;
  } catch (error) {
    if (archiveDeferred && error?.code !== "ENOENT") throw error;
    state = initialState(env);
  }
  const processes = new Map();
  let disposed = false;
  const runtime = new Map(SERVICE_IDS.map((id) => [id, {
    status: state.services[id].enabled ? "unknown" : "disabled",
    pid: null,
    owned: false,
    startedAt: null,
    checkedAt: null,
    latencyMs: null,
    statusCode: null,
    modelCount: null,
    health: null,
    banner: null,
    alternateEndpoint: null,
    lastOkAt: null,
    lastLeaseWriteAt: 0,
    reconnectAttempts: 0,
    stableSince: null,
    error: null,
  }]));

  function write() {
    // Keep legacy recovery data in the live file until a later launch can archive it.
    const saved = unarchivedState ? {
      ...unarchivedState,
      ...state,
      services: { ...unarchivedState.services, ...state.services },
      secrets: { ...unarchivedState.secrets, ...state.secrets },
    } : state;
    const text = `${JSON.stringify(saved, null, 2)}\n`;
    if (text === savedText) return;
    writeStateFile(filePath, text);
    savedText = text;
  }

  function secretFor(id) {
    const stored = codec.decrypt(state.secrets[id]) || {};
    if (id !== "codex-router" || stored.callerKey) return stored;
    const environmentCallerKey = typeof env.CODING_TOOLS_CODEX_ROUTER_CALLER_KEY === "string"
      ? env.CODING_TOOLS_CODEX_ROUTER_CALLER_KEY.trim()
      : "";
    return CALLER_KEY.test(environmentCallerKey)
      ? { callerKey: environmentCallerKey }
      : stored;
  }

  function redactServiceSecrets(value) {
    let result = String(value || "");
    const callerKey = secretFor("codex-router").callerKey;
    if (callerKey) {
      result = result
        .split(callerKey).join("[REDACTED]")
        .split(encodeURIComponent(callerKey)).join("[REDACTED]");
    }
    return result;
  }

  function providerMetrics(id) {
    const snapshot = typeof getProviderSnapshot === "function" ? getProviderSnapshot() : null;
    const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
    const selected = id === "cpa"
      ? accounts.filter((account) => (
        !account.archivedAt && (
          account.credentialSource === "cpa"
          || String(account.loginAdapterId || "").startsWith("cpa-")
          || account.providerId === "cliproxyapi-antigravity"
        )
      ))
      : [];
    return {
      accountCount: selected.length,
      connectedAccountCount: selected.filter((account) => account.status === "connected").length,
      providerModelCount: new Set(selected.flatMap((account) => Array.isArray(account.models) ? account.models : [])).size,
    };
  }

  function project(id) {
    requiredServiceId(id);
    const config = state.services[id];
    const activity = runtime.get(id);
    return {
      id,
      name: DEFAULTS[id].name,
      endpoint: config.endpoint,
      ...(config.executionEndpoint ? { executionEndpoint: config.executionEndpoint } : {}),
      home: config.home,
      executable: config.executable,
      arguments: [...config.arguments],
      enabled: config.enabled,
      autoStart: config.autoStart,
      keepAlive: config.keepAlive === true,
      status: config.enabled ? activity.status : "disabled",
      pid: activity.pid,
      owned: activity.owned,
      startedAt: activity.startedAt,
      checkedAt: activity.checkedAt,
      latencyMs: activity.latencyMs,
      statusCode: activity.statusCode,
      modelCount: activity.modelCount,
      error: activity.error,
      banner: activity.banner || null,
      alternateEndpoint: activity.alternateEndpoint || null,
      stale: Boolean(
        config.keepAlive
        && activity.lastOkAt
        && (Date.now() - Date.parse(activity.lastOkAt || 0) > staleWindowMs(id) || activity.status === "offline" || activity.status === "error"),
      ) && activity.status !== "ready",
      reconnectAttempts: activity.reconnectAttempts || 0,
      secretConfigured: false,
      sourceConfigured: Boolean(config.home || config.executable),
      ...providerMetrics(id),
    };
  }

  function snapshot() {
    return { version: STORE_VERSION, services: SERVICE_IDS.map(project) };
  }

  function emit() {
    const value = snapshot();
    try {
      persistLoopbackMesh(meshFilePath, buildLoopbackMesh(value.services));
    } catch (error) {
      logger?.warn?.("external-service.loopback-mesh-persist-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    try { publish?.(value); } catch {}
    return value;
  }

  function configure(idValue, input = {}) {
    const id = requiredServiceId(idValue);
    if (!input || typeof input !== "object") throw new Error("External service configuration is required");
    const current = state.services[id];
    const next = {
      ...current,
      ...(input.endpoint !== undefined
        ? { endpoint: normalizeLoopbackServiceEndpoint(input.endpoint) }
        : {}),
      ...((id === "paseo" || id === "anneal") && input.executionEndpoint !== undefined
        ? { executionEndpoint: normalizeLoopbackExecutionEndpoint(input.executionEndpoint, id) }
        : {}),
      ...(input.home !== undefined ? { home: optionalText(input.home) || "" } : {}),
      ...(input.executable !== undefined ? { executable: optionalText(input.executable) || "" } : {}),
      ...(input.arguments !== undefined ? { arguments: normalizeArguments(input.arguments) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled === true } : {}),
      ...(input.autoStart !== undefined ? { autoStart: input.autoStart === true } : {}),
      ...(input.keepAlive !== undefined ? { keepAlive: input.keepAlive === true } : {}),
    };
    if (id === "paseo") Object.assign(next, { enabled: false, autoStart: false, keepAlive: false });
    state.services[id] = next;
    const activity = runtime.get(id);
    runtime.set(id, {
      ...activity,
      status: next.enabled ? "unknown" : "disabled",
      error: null,
      checkedAt: null,
    });
    write();
    emit();
    if (next.keepAlive && next.enabled) scheduleKeepAlive(id, 0);
    else clearKeepAlive(id);
    return project(id);
  }

  function healthUrl(id, endpoint = state.services[id].endpoint) {
    const configEndpoint = endpoint || state.services[id].endpoint;
    if (id === "cpa") {
      return new URL("/v1/models", configEndpoint).toString();
    }
    return configEndpoint;
  }

  async function inspect(idValue) {
    const id = requiredServiceId(idValue);
    const config = state.services[id];
    if (!config.enabled) return project(id);
    if (typeof fetchImpl !== "function") throw new Error("External service HTTP inspection is unavailable");
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_INSPECT_TIMEOUT_MS);
    timer.unref?.();
    const previous = runtime.get(id);
    try {
        const response = await fetchImpl(healthUrl(id), {
          method: "GET",
          headers: {
            accept: "application/json,text/html;q=0.8,*/*;q=0.1",
            ...(typeof getHealthHeaders === "function" ? getHealthHeaders(id) : {}),
          },
          signal: controller.signal,
        });
        let modelCount = null;
        try {
          const contentType = response.headers?.get?.("content-type") || "";
          if (contentType.includes("json")) modelCount = countModels(await response.clone().json());
        } catch {}
        const reachable = response.ok;
        runtime.set(id, {
          ...previous,
          status: reachable ? "ready" : "error",
          pid: processes.get(id)?.pid || null,
          owned: processes.has(id),
          checkedAt: now(),
          latencyMs: Date.now() - started,
          statusCode: response.status,
          modelCount,
          lastOkAt: reachable ? now() : previous.lastOkAt,
          reconnectAttempts: reachable ? 0 : (previous.reconnectAttempts || 0),
          stableSince: reachable
            ? (previous.status === "ready" ? previous.stableSince || now() : now())
            : null,
          error: reachable ? null : `HTTP ${response.status}`,
        });
    } catch (error) {
      runtime.set(id, {
        ...previous,
        status: processes.has(id) ? "starting" : "offline",
        pid: processes.get(id)?.pid || null,
        owned: processes.has(id),
        checkedAt: now(),
        health: null,
        latencyMs: Date.now() - started,
        statusCode: null,
        modelCount: null,
        error: redactServiceSecrets(error instanceof Error ? error.message : String(error)),
        reconnectAttempts: (previous.reconnectAttempts || 0) + (config.keepAlive ? 1 : 0),
        stableSince: null,
      });
    } finally {
      clearTimeout(timer);
    }
    maybeWriteKeepAliveLease(id);
    emit();
    return project(id);
  }

  async function start(idValue) {
    if (disposed) throw new Error("External services controller has been disposed");
    const id = requiredServiceId(idValue);
    const current = await inspect(id);
    if (disposed) throw new Error("External services controller has been disposed");
    if (current.status === "ready") return current;
    if (processes.has(id)) return project(id);
    const config = state.services[id];
    if (!config.enabled) throw new Error(`${DEFAULTS[id].name} is disabled`);
    if (!config.executable) throw new Error(`${DEFAULTS[id].name} executable is not configured`);
    if (config.home && !fs.existsSync(config.home)) {
      throw new Error(`${DEFAULTS[id].name} home directory does not exist`);
    }
    const child = spawnProcess(config.executable, [...config.arguments], {
      cwd: config.home || undefined,
      env: {
        ...env,
      },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.set(id, child);
    runtime.set(id, {
      ...runtime.get(id),
      status: "starting",
      pid: child.pid || null,
      owned: true,
      startedAt: now(),
      checkedAt: now(),
      error: null,
    });
    const log = (stream, chunk) => {
      const message = String(chunk || "").trim().slice(-2_000);
      if (message) logger?.debug?.(`external-service.${id}.${stream}`, { message });
    };
    child.stdout?.on?.("data", (chunk) => log("stdout", chunk));
    child.stderr?.on?.("data", (chunk) => log("stderr", chunk));
    child.once?.("error", (error) => {
      processes.delete(id);
      runtime.set(id, {
        ...runtime.get(id),
        status: "error",
        pid: null,
        owned: false,
        checkedAt: now(),
        error: error instanceof Error ? error.message : String(error),
      });
      emit();
    });
    child.once?.("exit", (code, signal) => {
      processes.delete(id);
      runtime.set(id, {
        ...runtime.get(id),
        status: "offline",
        pid: null,
        owned: false,
        checkedAt: now(),
        error: code === 0 ? null : `${DEFAULTS[id].name} exited (${code ?? signal ?? "unknown"})`,
      });
      emit();
    });
    emit();
    return project(id);
  }

  async function stop(idValue) {
    const id = requiredServiceId(idValue);
    const child = processes.get(id);
    if (!child) {
      const current = await inspect(id);
      if (current.status === "ready") {
        throw new Error(`${DEFAULTS[id].name} is externally managed and cannot be stopped by Coding Tools`);
      }
      return current;
    }
    if (child.exitCode === null && child.signalCode === null) {
      const exited = await new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const finish = (value, error = null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.removeListener?.("exit", onExit);
          child.removeListener?.("error", onError);
          if (error) reject(error);
          else resolve(value);
        };
        const onExit = () => finish(true);
        const onError = () => finish(true);
        child.once?.("exit", onExit);
        child.once?.("error", onError);
        timer = setTimeout(() => finish(false), STOP_TIMEOUT_MS);
        timer.unref?.();
        try {
          if (process.platform === "win32") terminateProcessTree(child, "SIGTERM");
          else if (child.kill("SIGTERM") === false) finish(false);
        } catch (error) {
          finish(false, process.platform === "win32" ? error : null);
        }
      });
      if (!exited && child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") terminateProcessTree(child, "SIGKILL");
        else try { child.kill("SIGKILL"); } catch {}
      }
    }
    processes.delete(id);
    runtime.set(id, {
      ...runtime.get(id),
      status: "offline",
      pid: null,
      owned: false,
      checkedAt: now(),
      error: null,
    });
    emit();
    return project(id);
  }

  async function restart(idValue) {
    const id = requiredServiceId(idValue);
    if (!processes.has(id)) {
      const current = await inspect(id);
      if (current.status === "ready") {
        throw new Error(`${DEFAULTS[id].name} is externally managed and cannot be restarted by Coding Tools`);
      }
    } else {
      await stop(id);
    }
    return start(id);
  }

  function runtimeEnvironment() {
    const cpa = state.services.cpa;
    const mesh = buildLoopbackMesh(snapshot().services);
    try { persistLoopbackMesh(meshFilePath, mesh); } catch {}
    return Object.freeze({
      ...publicUrlMap({ cpaOrigin: cpa.endpoint }),
      ...loopbackMeshEnvironment(mesh, { meshPath: meshFilePath }),
    });
  }

  function upstreamConfiguration(idValue) {
    const id = requiredServiceId(idValue);
    if (id !== "paseo" && id !== "anneal") {
      throw new Error(`Service ${id} is not an upstream UI tool`);
    }
    const config = state.services[id];
    return {
      endpoint: config.endpoint,
      executionEndpoint: config.executionEndpoint,
      home: config.home,
      executable: config.executable,
      arguments: [...config.arguments],
    };
  }

  function maybeWriteKeepAliveLease(id) {
    const config = state.services[id];
    const activity = runtime.get(id);
    if (!config?.keepAlive || activity.status !== "ready") return;
    const lastWrite = activity.lastLeaseWriteAt || 0;
    if (Date.now() - lastWrite < KEEP_ALIVE_LEASE_WRITE_MS) return;
    runtime.set(id, { ...activity, lastLeaseWriteAt: Date.now() });
    try {
      write();
    } catch (error) {
      logger?.warn?.("external-service.keep-alive-lease-persist-failed", {
        serviceId: id,
        code: error?.code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const keepAliveTimers = new Map();

  function clearKeepAlive(id) {
    const timer = keepAliveTimers.get(id);
    if (timer) clearTimeout(timer);
    keepAliveTimers.delete(id);
  }

  function scheduleKeepAlive(id, delayMs) {
    const config = state.services[id];
    if (disposed || !config?.keepAlive || !config.enabled) {
      clearKeepAlive(id);
      return;
    }
    clearKeepAlive(id);
    const timer = setTimeout(() => {
      void runKeepAlive(id);
    }, Math.max(0, delayMs));
    timer.unref?.();
    keepAliveTimers.set(id, timer);
  }

  async function runKeepAlive(id) {
    const config = state.services[id];
    if (!config?.keepAlive || !config.enabled) {
      clearKeepAlive(id);
      return;
    }
    const before = runtime.get(id);
    await inspect(id);
    const after = runtime.get(id);
    if (before.status !== after.status) {
      logger?.info?.("external-service.keep-alive", {
        serviceId: id,
        status: after.status,
        attempts: after.reconnectAttempts,
      });
    }
    if (after.status === "ready") {
      const stableMs = after.stableSince ? Date.now() - Date.parse(after.stableSince) : 0;
      if (stableMs >= KEEP_ALIVE_STABLE_RESET_MS) {
        runtime.set(id, { ...after, reconnectAttempts: 0 });
      }
      scheduleKeepAlive(id, KEEP_ALIVE_POLL_MS);
      return;
    }
    scheduleKeepAlive(id, nextKeepAliveDelayMs(after.reconnectAttempts || 1));
  }

  function startKeepAlive(idValue) {
    const id = requiredServiceId(idValue);
    const config = state.services[id];
    if (!config.keepAlive || !config.enabled) return project(id);
    scheduleKeepAlive(id, 0);
    return project(id);
  }

  function startKeepAliveSupervisors() {
    for (const id of SERVICE_IDS) {
      if (state.services[id].keepAlive && state.services[id].enabled) scheduleKeepAlive(id, 0);
    }
  }

  function dispose() {
    disposed = true;
    const failures = [];
    for (const id of SERVICE_IDS) clearKeepAlive(id);
    for (const [id, child] of processes) {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          if (process.platform === "win32") terminateProcessTree(child, "SIGTERM");
          else if (!child.killed) child.kill("SIGTERM");
        }
      } catch (error) {
        failures.push(error);
        continue;
      }
      processes.delete(id);
      runtime.set(id, {
        ...runtime.get(id),
        status: "offline",
        pid: null,
        owned: false,
        checkedAt: now(),
      });
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `External service cleanup failed: ${failures.map((error) => error.message).join("; ")}`);
    }
  }

  startKeepAliveSupervisors();

  return Object.freeze({
    snapshot,
    configure,
    inspect,
    start,
    stop,
    restart,
    runtimeEnvironment,
    loopbackMesh: () => buildLoopbackMesh(snapshot().services),
    upstreamConfiguration,
    startKeepAlive,
    startKeepAliveSupervisors,
    dispose,
  });
}

module.exports = {
  DEFAULT_INSPECT_TIMEOUT_MS,
  KEEP_ALIVE_POLL_MS,
  SERVICE_IDS,
  createExternalServicesController,
  createSecretCodec,
  nextKeepAliveDelayMs,
  removeIncompleteSnapshots,
  removeSupersededSnapshots,
  normalizeLoopbackExecutionEndpoint,
  normalizeLoopbackServiceEndpoint,
};
