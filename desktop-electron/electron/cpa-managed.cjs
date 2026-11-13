"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { watchCpaPluginModels } = require("./cpa-plugin-models.cjs");
const { cpaLongRunYamlLines } = require("./cpa-codex-long-run.cjs");

const RUNTIME_MARKER = "CPA_RUNTIME.json";
const MAX_ARCHIVE_LIST_BYTES = 16 * 1024 * 1024;
// Windows' bundled bsdtar, as antigravity-cli.cjs uses. A GNU tar earlier on PATH (Git's, when the
// app was started from a Git or Claude Code shell) reads "G:\...\cpa.zip" as host "G": every CPA
// start failed "tar: Cannot connect to G: resolve failed", so a new CPA never replaced the old one.
const tarBinary = (platform = process.platform) => (platform === "win32"
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar");

function requiredAbsolutePath(value, label) {
  const resolved = path.resolve(String(value || ""));
  if (!path.isAbsolute(resolved) || !String(value || "").trim()) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolved;
}

function assertInside(root, candidate, label) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  if (!relative || relative === ".") return target;
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped the managed CPA root`);
  }
  return target;
}

function runChecked(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: MAX_ARCHIVE_LIST_BYTES,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim().slice(-2_000);
    throw new Error(`${executable} failed (${result.status ?? "unknown"})${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function validateArchive(artifact) {
  const listing = runChecked(tarBinary(), ["-tf", artifact]).stdout;
  const entries = String(listing || "").split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0) throw new Error("CPA release archive is empty");
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    const segments = normalized.split("/").filter(Boolean);
    if (normalized.startsWith("/")
      || /^[A-Za-z]:/u.test(normalized)
      || segments.includes("..")
      || normalized.includes("\0")) {
      throw new Error("CPA release archive contains an unsafe path");
    }
  }

  const verbose = runChecked(tarBinary(), ["-tvf", artifact]).stdout;
  for (const line of String(verbose || "").split(/\r?\n/u).filter(Boolean)) {
    const type = line.trimStart()[0];
    if (type === "l" || type === "h") {
      throw new Error("CPA release archive contains a link entry");
    }
  }
}

function findRuntimeBinary(directory) {
  const matches = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) throw new Error("CPA runtime contains a symbolic link");
      if (stat.isDirectory()) {
        visit(candidate);
        continue;
      }
      const normalized = entry.name.toLowerCase();
      if (stat.isFile() && (normalized === "cli-proxy-api" || normalized === "cli-proxy-api.exe")) {
        matches.push(candidate);
      }
    }
  };
  visit(directory);
  if (matches.length !== 1) {
    throw new Error(`CPA release archive must contain exactly one runtime binary; found ${matches.length}`);
  }
  return matches[0];
}

// Whether anything holds the port, by trying to bind it in a child (this check is synchronous):
// under half a second, and unlike netstat it misses no listener. Owners are looked up only when it
// is taken; a probe that cannot tell (exit other than 0) counts as taken.
const BIND_PROBE = "const s=require(\"node:net\").createServer();"
  + "s.once(\"error\",(e)=>{process.exitCode=e.code===\"EADDRINUSE\"?3:4});"
  + "s.listen(Number(process.argv.at(-1)),\"127.0.0.1\",()=>s.close())";
function portTaken(port, { runSync, options }) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  return runSync(process.execPath, ["-e", BIND_PROBE, "--", String(Number(port))], { ...options, env }).status !== 0;
}

// The processes owning a socket on the port, from two sources. netstat can leave listeners out: on
// 2026-10-29 it listed 12 listeners in all and never CPA's on 8317, so a stale CPA was seen only
// through its clients' connections; with none (the old app had quit) it was missed, and the new CPA
// failed "address in use". Get-NetTCPConnection lists that listener (state 0) with its owner.
function portOwners(port, { runSync, system32, options }) {
  const owners = new Set();
  const powershell = path.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
  const query = `Get-NetTCPConnection -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }`;
  const sockets = runSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", query], options);
  if (sockets.status === 0) {
    for (const line of String(sockets.stdout || "").split(/\r?\n/u)) owners.add(Number(line.trim()));
  }
  const listing = runSync(path.join(system32, "NETSTAT.EXE"), ["-ano", "-p", "TCP"], options);
  for (const columns of String(listing.stdout || "").split(/\r?\n/u).map((line) => line.trim().split(/\s+/u))) {
    if (columns[0] === "TCP" && /:(\d+)$/u.exec(columns[1] || "")?.[1] === String(port)) owners.add(Number(columns[4]));
  }
  return [...owners].filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

// The pid of a CPA runtime holding the CPA port, else null (Windows only). Any socket on the port
// counts, not only the listener: a CPA that lost its listener still served the clients whose
// keep-alive connections it held (the 0.8.31 CPA on 2026-10-29, firewall-blocked, did exactly this).
function cpaOnPort(port, { runSync = spawnSync, platform = process.platform } = {}) {
  if (platform !== "win32") return null;
  const system32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const options = { encoding: "utf8", windowsHide: true, timeout: 15_000 };
  if (!portTaken(port, { runSync, options })) return null;
  for (const pid of portOwners(port, { runSync, system32, options })) {
    const task = runSync(path.join(system32, "tasklist.exe"), ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], options);
    const image = /^"([^"]+)"/u.exec(String(task.stdout || "").trim())?.[1];
    if (image?.toLowerCase() === "cli-proxy-api.exe") return pid;
  }
  return null;
}

// CPA outlives the app, and an update or an older app's own start can leave one on the port. This
// one then exits at once ("address in use") while the old one keeps serving: on 2026-10-29 a CPA
// from 0.8.31 (8.0.32, blocked by the firewall, the old proxy route) outlived two updates. Run
// only starts a CPA the app chose not to adopt, so a CPA still on the port is ended first.
function endStaleCpa(port, { runSync = spawnSync, platform = process.platform, waitMs = 5_000 } = {}) {
  const stale = cpaOnPort(port, { runSync, platform });
  if (!stale) return null;
  const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
  const killed = runSync(taskkill, ["/PID", String(stale), "/T", "/F"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (killed.status !== 0) {
    // Said, not thrown: the new CPA still starts, and its "address in use" follows this line.
    const reason = String(killed.stderr || killed.error?.message || `exit ${killed.status}`).trim();
    console.error(`Could not end the earlier CPA (pid ${stale}) on port ${port}: ${reason}`);
    return null;
  }
  let holder = stale;
  for (const deadline = Date.now() + waitMs; Date.now() < deadline && (holder = cpaOnPort(port, { runSync, platform }));) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  console.error(holder
    ? `Ended the earlier CPA (pid ${stale}), but pid ${holder} still holds port ${port}`
    : `Ended the earlier CPA (pid ${stale}) that still held port ${port}`);
  return stale;
}

function markerPath(home) {
  return path.join(home, "runtime", RUNTIME_MARKER);
}

function prepare(homeValue, stateValue, artifactValue) {
  const home = requiredAbsolutePath(homeValue, "CPA managed home");
  requiredAbsolutePath(stateValue, "CPA state root");
  const artifact = requiredAbsolutePath(artifactValue, "CPA release archive");
  assertInside(home, artifact, "CPA release archive");
  if (!fs.statSync(artifact).isFile()) throw new Error("CPA release archive is not a file");

  const runtimeRoot = path.join(home, "runtime");
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  validateArchive(artifact);
  runChecked(tarBinary(), ["-xf", artifact, "-C", runtimeRoot]);

  const executable = findRuntimeBinary(runtimeRoot);
  assertInside(runtimeRoot, executable, "CPA runtime binary");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o700);
  const relativeExecutable = path.relative(runtimeRoot, executable);
  writePrivateFileAtomic(markerPath(home), `${JSON.stringify({
    schemaVersion: 1,
    executable: relativeExecutable,
  }, null, 2)}\n`);
}

function requiredSecret(name, minimumLength = 32) {
  const value = String(process.env[name] || "").trim();
  if (value.length < minimumLength || value.includes("\0")) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

// Every Go plugin is built with Go 1.26.10/1.27.3 or later: before them, crypto/x509 trusted chains
// through distrusted intermediates (CVE-2026-111943, the leaked emSign CA keys).
// CPA loads one plugin, Provider Manager (p90-lover/cpa_provider_manager). Everything the other
// plugins did is a part of it: CPA Helper (usage, costs, Codex quota scheduler, keeper), CPA Auto
// Review (codex-auto-review), and the Cline Pass, CommandCode Go, CommandCode and Grok accounts as
// account kinds. CPA gives a plugin one auth identifier, so those accounts are provider-manager auth
// files with a "kind" (migrateAuthFiles).
const COMMANDCODE_PLUGINS = [
  { id: "cpa-provider-manager", file: "cpa-provider-manager-v0.7.0.dll", sha256: "c5b47f39878791119b1c1dfd996cc88a3bb0c8d5a4e1426932287ed8d4ebd231" },
];

// The plugins Provider Manager replaced. Their DLLs and config blocks are removed: a stale plugin
// left loading would still claim its old provider id, and every id here sorts before
// cpa-provider-manager, so CPA would hand it the accounts first.
const RETIRED_PLUGINS = Object.freeze(["cline-pass-switcher", "commandcode-go", "auth-commandcode", "cpa-helper",
  "grok-login-provider", "codex-review-account-selector", "codex-auto-review"]);

// Each former plugin's part in Provider Manager: its config block becomes the part's section and
// its data folder is imported once from legacy-data-dirs.
const PROVIDER_MANAGER_PARTS = Object.freeze({
  "cpa-helper": { part: "helper", data: "cpa-helper-data" },
  "codex-review-account-selector": { part: "autoreview", data: "codex-review-account-selector-data" },
  "cline-pass-switcher": { part: "cline", data: "cline-pass-switcher-data" },
  "commandcode-go": { part: "commandcode-go" },
  "auth-commandcode": { part: "commandcode" },
  "grok-login-provider": { part: "grok" },
});

// Auth file types that became Provider Manager account kinds (the kind's name is its old type).
const ACCOUNT_KINDS = Object.freeze(["cline", "commandcode-go", "commandcode", "grok"]);

/** Provider Manager's private folder; each part keeps its state in a subfolder named after it. */
function providerManagerDataDir(state) {
  return path.join(state, "cpa-provider-manager-data");
}

/** Plugins updated from GitHub by App plugins (app-plugins.cjs), by id; {} when there are none. */
function updatedPlugins(state) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(state, "plugin-updates.json"), "utf8"));
    return record && typeof record.plugins === "object" && record.plugins ? record.plugins : {};
  } catch { return {}; }
}

/**
 * x.y.z[-pre] ordering, as update.cjs compares app releases (a release outranks its prereleases,
 * prereleases compare numerically). Kept here: this file runs unpacked as CPA's adapter, and
 * everything it requires has to be unpacked with it.
 */
function newerVersion(candidate, current) {
  const parse = (value) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || "").trim());
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (const index of [1, 2, 3]) {
    if (Number(a[index]) !== Number(b[index])) return Number(a[index]) > Number(b[index]);
  }
  if ((a[4] || null) === (b[4] || null)) return false;
  if (!a[4]) return true;
  if (!b[4]) return false;
  return a[4].localeCompare(b[4], "en", { numeric: true }) > 0;
}

function installBundledCommandCodePlugin(state) {
  if (process.platform !== "win32" || process.arch !== "x64") return [];
  const bundle = path.join(__dirname, "..", "vendor", "bundled", "cpa-plugins", "windows", "amd64");
  const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const sources = COMMANDCODE_PLUGINS.map((plugin) => ({
    ...plugin, source: path.join(bundle, plugin.file),
  }));
  for (const plugin of sources) {
    if (digest(plugin.source) !== plugin.sha256) throw new Error(`Bundled ${plugin.id} CPA plugin hash mismatch`);
  }

  const directory = path.join(state, "plugins", "windows", "amd64");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Regular files only: anything else under such a name stays, and must not make an empty Trash
  // folder at every start.
  const retired = fs.readdirSync(directory).filter((name) => RETIRED_PLUGINS.some((id) => (
    name === `${id}.dll` || (name.startsWith(`${id}-v`) && name.endsWith(".dll"))))
    && fs.lstatSync(path.join(directory, name)).isFile());
  if (retired.length) {
    const archive = path.join(state, "Trash", "plugins", `${Date.now()}-retired`);
    fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
    for (const name of retired) fs.renameSync(path.join(directory, name), path.join(archive, name));
  }
  const updates = updatedPlugins(state);
  return sources.map((plugin) => {
    // A plugin updated from GitHub (Connections > App plugins) stays while it is newer than the
    // bundled copy and is still the file that was checked; an app update bringing a newer one wins.
    const updated = updates[plugin.id];
    const bundledVersion = plugin.file.slice(plugin.id.length + 2, -".dll".length);
    const updatedPath = typeof updated?.file === "string" && path.basename(updated.file) === updated.file
      && updated.file.startsWith(`${plugin.id}-v`) && updated.file.endsWith(".dll") ? path.join(directory, updated.file) : null;
    const keepUpdate = Boolean(updatedPath && /^[a-f0-9]{64}$/.test(String(updated.sha256))
      && newerVersion(updated.version, bundledVersion) && fs.existsSync(updatedPath)
      && fs.lstatSync(updatedPath).isFile() && digest(updatedPath) === updated.sha256);
    const file = keepUpdate ? updated.file : plugin.file;
    const target = path.join(directory, file);
    const stat = fs.existsSync(target) ? fs.lstatSync(target) : null;
    if (stat && !stat.isFile()) throw new Error(`${plugin.id} CPA plugin path is not a regular file`);
    const current = keepUpdate || (stat && digest(target) === plugin.sha256);
    const old = fs.readdirSync(directory).filter((name) => (
      (name === `${plugin.id}.dll` || (name.startsWith(`${plugin.id}-v`) && name.endsWith(".dll")))
      && (name !== file || !current)
    ));
    if (old.length) {
      const archive = path.join(state, "Trash", "plugins", `${Date.now()}-${plugin.id}`);
      fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
      for (const name of old) {
        const previous = path.join(directory, name);
        if (!fs.lstatSync(previous).isFile()) throw new Error(`${plugin.id} CPA plugin path is not a regular file`);
        fs.renameSync(previous, path.join(archive, name));
      }
    }
    if (!current) fs.copyFileSync(plugin.source, target, fs.constants.COPYFILE_EXCL);
    return target;
  });
}

/** A former provider plugin's auth file as a Provider Manager account of that kind; others unchanged. */
function stampAccountKind(file) {
  if (!file || typeof file !== "object" || Array.isArray(file) || !ACCOUNT_KINDS.includes(file.type)) return file;
  return { ...file, type: "provider-manager", kind: file.type, kindType: file.type };
}

/**
 * Rewrites the auth files of the retired provider plugins as Provider Manager accounts
 * (`type: grok` becomes `type: provider-manager, kind: grok, kindType: grok`); Provider Manager hands
 * each kind its file back as it was. Each original goes to Trash first. Idempotent: a stamped file,
 * a file of another type, or one that isn't JSON is left alone.
 */
function migrateAuthFiles(state) {
  const authDirectory = path.join(state, "auth");
  let names = [];
  try { names = fs.readdirSync(authDirectory).filter((name) => name.toLowerCase().endsWith(".json")); } catch { return 0; }
  let archive = null;
  let moved = 0;
  for (const name of names) {
    const file = path.join(authDirectory, name);
    let parsed;
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { continue; }
    const stamped = stampAccountKind(parsed);
    if (stamped === parsed) continue;
    if (!archive) {
      archive = path.join(state, "Trash", "auth", `${Date.now()}-provider-manager-kinds`);
      fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
    }
    fs.copyFileSync(file, path.join(archive, name));
    writePrivateFileAtomic(file, `${JSON.stringify(stamped, null, 2)}\n`);
    moved += 1;
  }
  return moved;
}

/**
 * The plugin configs CPA gets: the saved ones without the retired plugins, and Provider Manager's
 * block: its saved keys (sync-minutes, proxy-url, ...) under the managed ones. A managed section
 * replaces the saved one whole, as a managed plugin block always did, so a removed setting (an
 * outbound proxy) never lingers. A part nothing manages keeps its saved section, or starts from its
 * former plugin's saved block without the keys that are Provider Manager's now.
 */
function mergePluginConfigs(savedConfigs, managedConfigs) {
  const plain = (value) => (isPlainObject(value) ? value : {});
  const saved = plain(savedConfigs);
  const configs = Object.fromEntries(Object.entries(saved).filter(([id]) => !RETIRED_PLUGINS.includes(id)));
  const managed = plain(managedConfigs["cpa-provider-manager"]);
  const manager = { ...plain(saved["cpa-provider-manager"]), ...managed };
  for (const [id, { part }] of Object.entries(PROVIDER_MANAGER_PARTS)) {
    if (part in manager) continue;
    const { enabled: _enabled, "data-dir": _dataDir, data_dir: _dataDirUnderscore, ...former } = plain(saved[id]);
    if (Object.keys(former).length) manager[part] = former;
  }
  return { ...configs, ...managedConfigs, "cpa-provider-manager": manager };
}

function runtimeConfiguration(state, managementKey, proxyApiKey, outboundProxyUrl = "") {
  let savedSource = "";
  try { savedSource = fs.readFileSync(path.join(state, "config.yaml"), "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT") throw new Error("Saved CPA configuration is unavailable; it was not replaced");
  }
  let saved = {};
  let yaml;
  if (savedSource.trim()) {
    yaml = globalThis.Bun?.YAML ?? require("js-yaml");
    try {
      saved = (yaml.parse ?? yaml.load)(savedSource);
      if (Object.prototype.toString.call(saved) !== "[object Object]") throw new Error();
      for (const value of [saved.plugins, saved.plugins?.configs, saved.oauth]) {
        if (value !== undefined && Object.prototype.toString.call(value) !== "[object Object]") throw new Error();
      }
      const apiKeys = saved["api-keys"];
      if (apiKeys !== undefined && !Array.isArray(apiKeys)
        && (Object.prototype.toString.call(apiKeys) !== "[object Object]"
          || Object.values(apiKeys).some((groups) => !Array.isArray(groups)))) throw new Error();
    } catch {
      throw new Error("Saved CPA configuration is invalid; it was not replaced");
    }
  }
  const authDirectory = path.join(state, "auth");
  const logDirectory = path.join(state, "logs");
  const pluginDirectory = path.resolve(state, "plugins");
  fs.mkdirSync(pluginDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  const clineAuth = path.join(authDirectory, "cline-pass-switcher.json");
  if (!fs.existsSync(clineAuth)) {
    writePrivateFileAtomic(clineAuth, `${JSON.stringify(stampAccountKind({ type: "cline", switcher: true, label: "Cline Pass" }))}\n`);
  }
  migrateAuthFiles(state);
  if (process.platform !== "win32") {
    fs.chmodSync(authDirectory, 0o700);
    fs.chmodSync(logDirectory, 0o700);
    fs.chmodSync(pluginDirectory, 0o700);
  }
  const generated = [
    "config-version: 8",
    "host: \"127.0.0.1\"",
    "port: 8317",
    `auth-dir: ${yamlString(authDirectory)}`,
    "access:",
    "  api-keys:",
    `    - ${yamlString(proxyApiKey)}`,
    ...(outboundProxyUrl ? [`proxy-url: ${yamlString(outboundProxyUrl)}`] : []),
    "remote-management:",
    "  allow-remote: false",
    `  secret-key: ${yamlString(managementKey)}`,
    "  disable-control-panel: false",
    "  disable-auto-update-panel: true",
    "plugins:",
    "  enabled: true",
    `  dir: ${yamlString(pluginDirectory)}`,
    "  configs:",
    // CPA leaves a plugin without a configs entry unregistered. Each part reads its own section; a
    // part's state lives in <data-dir>/<part>, imported once from its former plugin's folder.
    "    cpa-provider-manager:",
    "      enabled: true",
    `      data-dir: ${yamlString(providerManagerDataDir(state))}`,
    "      legacy-data-dirs:",
    ...Object.values(PROVIDER_MANAGER_PARTS).filter((entry) => entry.data)
      .map((entry) => `        ${entry.part}: ${yamlString(path.join(state, entry.data))}`),
    "      helper:",
    "        keeper_enabled: false",
    "      cline:",
    `        runtime-executable: ${yamlString(process.execPath)}`,
    ...(outboundProxyUrl ? [`        proxy-url: ${yamlString(outboundProxyUrl)}`] : []),
    // Ask OpenAI's Responses models for a reasoning summary. Claude Code never sends the
    // `thinking.display` that would make CPA request one, so its chats showed no reasoning; CPA
    // turns the summary into thinking blocks, which the agent then reports as reasoning. A default
    // only fills a field the request leaves out, so the effort the user chose is unchanged.
    "payload:",
    "  default:",
    "    - models: [{name: \"*\", protocol: \"codex\"}]",
    "      params: {\"reasoning.summary\": \"auto\"}",
    // Claude Code probes a model with max_tokens 1. CPA hands that to Codex as max_output_tokens,
    // which OpenAI refuses below 16 ("integer below minimum value"), so every probe of a GPT model
    // through a Codex account came back HTTP 400 and its chat read "CPA refused the last 4
    // requests" (seen live 2026-11-04). Only those exact values are raised; a real limit is kept.
    "  override:",
    `    - models: [${codexMinimumOutputSelectors()}]`,
    `      params: {"max_output_tokens": ${CODEX_MIN_OUTPUT_TOKENS}}`,
    "debug: false",
    "request-log: false",
    // No main.log: it took ~10 MB every two days, half of it warnings nobody reads. CPA then logs
    // to its output, which the launcher discards for a persistent CPA.
    "logging-to-file: false",
    // No request logger at all. Even with request-log off, CPA copied every request body over
    // 1 MiB (and every chunked one) into logs/request-log-parts-* in case the request failed, then
    // deleted it: a disk write per agent turn. Commercial mode only drops that logger (and the
    // error-*.log files it wrote on failures, which nothing here reads).
    "commercial-mode: true",
    "usage-statistics-enabled: true",
    ...cpaLongRunYamlLines(),
    "",
  ].join("\n");
  if (!savedSource.trim()) return generated;
  const managed = (yaml.parse ?? yaml.load)(generated);
  // User settings survive restarts; listener, client access, bundled plugin paths and file logging
  // stay managed (an older build saved logging-to-file: true; none saved commercial-mode). So do
  // config v8's grouped forms of the same security settings: a saved `server` (host 0.0.0.0, or
  // commercial-mode off), `management` or `access` block would otherwise reopen what the flat keys
  // above keep closed.
  const owned = ["config-version", "host", "port", "auth-dir", "api-keys", "proxy-url", "remote-management", "plugins", "logging-to-file",
    "commercial-mode", "server", "management", "access"];
  const retained = Object.fromEntries(Object.entries(saved).filter(([key]) => !owned.includes(key)));
  const merged = {
    ...managed, ...retained,
    plugins: { ...saved.plugins, ...managed.plugins,
      configs: mergePluginConfigs(saved.plugins?.configs, managed.plugins.configs) },
  };
  // In v8 api-keys is the upstream provider map; legacy arrays are client keys, now managed above.
  if (Object.prototype.toString.call(saved["api-keys"]) === "[object Object]") merged["api-keys"] = saved["api-keys"];
  if (saved.oauth) merged.oauth = { ...saved.oauth, "auth-dir": authDirectory };
  // CPA 8 saves the route as requests.proxy-url. Kept beside the managed one above, an old route
  // outlived every change (and a removed one stayed on).
  if (Object.prototype.toString.call(merged.requests) === "[object Object]" && "proxy-url" in merged.requests) {
    const { "proxy-url": _route, ...requests } = merged.requests;
    if (Object.keys(requests).length) merged.requests = requests;
    else delete merged.requests;
  }
  mergeManagedPayload(merged, managed.payload);
  return (yaml.stringify ?? yaml.dump)(merged);
}

const CODEX_MIN_OUTPUT_TOKENS = 16;

/** One CPA payload selector per output limit Codex refuses (1 to 15), as flow YAML. */
function codexMinimumOutputSelectors() {
  return Array.from({ length: CODEX_MIN_OUTPUT_TOKENS - 1 }, (_, index) =>
    `{name: "*", protocol: "codex", match: [{"max_output_tokens": ${index + 1}}]}`).join(", ");
}

const isPlainObject = (value) => Object.prototype.toString.call(value) === "[object Object]";

/** A payload rule's identity: its models (empty fields dropped, as CPA saves them filled in) and its params' paths. */
function payloadRuleIdentity(rule) {
  const filled = (value) => value !== undefined && value !== null && value !== ""
    && !(Array.isArray(value) && !value.length) && !(isPlainObject(value) && !Object.keys(value).length);
  const models = (Array.isArray(rule?.models) ? rule.models : []).map((model) =>
    Object.fromEntries(Object.entries(isPlainObject(model) ? model : {}).filter(([, value]) => filled(value)).sort(([a], [b]) => a.localeCompare(b))));
  return JSON.stringify([models, Object.keys(isPlainObject(rule?.params) ? rule.params : {}).sort()]);
}

/**
 * Puts the app's payload rules in the payload CPA reads. A saved `payload`, or CPA 8's grouped
 * `requests.payload` that CPA reads over the flat one, used to replace the generated rules whole,
 * so a rule added by a later build never reached an existing install. Each app rule replaces a
 * saved rule with the same identity and is otherwise added; the person's own rules stay.
 */
function mergeManagedPayload(merged, managedPayload) {
  if (!isPlainObject(managedPayload)) return;
  const grouped = isPlainObject(merged.requests) && isPlainObject(merged.requests.payload);
  const target = grouped ? merged.requests.payload : isPlainObject(merged.payload) ? merged.payload : {};
  for (const [section, rules] of Object.entries(managedPayload)) {
    if (!Array.isArray(rules)) continue;
    const identities = new Set(rules.map(payloadRuleIdentity));
    const kept = (Array.isArray(target[section]) ? target[section] : []).filter((rule) => !identities.has(payloadRuleIdentity(rule)));
    target[section] = [...kept, ...rules];
  }
  // CPA reads the grouped copy over the flat one, so a flat copy beside it would only mislead.
  if (grouped) delete merged.payload;
  else merged.payload = target;
}

/** Removes the main.log files (current and rotated) CPA wrote before file logging was turned off. */
function removeOldMainLogs(state) {
  const logDirectory = path.join(state, "logs");
  let names = [];
  try { names = fs.readdirSync(logDirectory); } catch { return; }
  for (const name of names) {
    if (/^main(-[\w.-]+)?\.log$/.test(name)) {
      try { fs.rmSync(path.join(logDirectory, name), { force: true }); } catch {}
    }
  }
}

/**
 * Overwrites a file CPA is watching without replacing it. CPA's watcher follows the file itself:
 * a temp file renamed over config.yaml is never reloaded, and no later write reaches CPA until it
 * restarts. Shorter content is padded with spaces (valid YAML) so one write covers every old byte,
 * then trimmed; CPA never sees an empty or cut-off file it could load as a keyless config.
 */
function rewriteWatchedFile(filePath, content) {
  const next = Buffer.from(content, "utf8");
  const descriptor = fs.openSync(filePath, "r+");
  try {
    const size = fs.fstatSync(descriptor).size;
    const padded = next.length < size ? Buffer.concat([next, Buffer.alloc(size - next.length, 0x20)]) : next;
    fs.writeSync(descriptor, padded, 0, padded.length, 0);
    if (padded.length !== next.length) fs.ftruncateSync(descriptor, next.length);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Brings a running CPA's config.yaml up to this build's configuration. The launcher adopts a CPA
 * an earlier build started instead of restarting it, so run() never wrote it; CPA hot-reloads the
 * file. Returns "unchanged" when the file already holds it, else "written".
 */
function refreshConfiguration(state, managementKey, proxyApiKey, outboundProxyUrl = "") {
  const configPath = path.join(state, "config.yaml");
  const next = runtimeConfiguration(state, managementKey, proxyApiKey, outboundProxyUrl);
  let current = null;
  try { current = fs.readFileSync(configPath, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (current === next) return "unchanged";
  if (current === null) writePrivateFileAtomic(configPath, next);
  else rewriteWatchedFile(configPath, next);
  return "written";
}

function refresh(stateValue) {
  const state = requiredAbsolutePath(stateValue, "CPA state root");
  const result = refreshConfiguration(
    state,
    requiredSecret("CODING_TOOLS_CPA_MANAGEMENT_KEY"),
    requiredSecret("CODING_TOOLS_CPA_PROXY_API_KEY"),
    String(process.env.CODING_TOOLS_CPA_OUTBOUND_PROXY_URL || ""),
  );
  console.log(`CPA configuration ${result}`);
}

function run(homeValue, stateValue) {
  const home = requiredAbsolutePath(homeValue, "CPA managed home");
  const state = requiredAbsolutePath(stateValue, "CPA state root");
  const marker = JSON.parse(fs.readFileSync(markerPath(home), "utf8"));
  if (marker?.schemaVersion !== 1 || typeof marker.executable !== "string") {
    throw new Error("CPA runtime marker is invalid");
  }

  const runtimeRoot = path.join(home, "runtime");
  const executable = assertInside(runtimeRoot, path.join(runtimeRoot, marker.executable), "CPA runtime binary");
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("CPA runtime binary is invalid");

  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(state, 0o700);
  installBundledCommandCodePlugin(state);
  const managementKey = requiredSecret("CODING_TOOLS_CPA_MANAGEMENT_KEY");
  const proxyApiKey = requiredSecret("CODING_TOOLS_CPA_PROXY_API_KEY");
  const configPath = path.join(state, "config.yaml");
  writePrivateFileAtomic(configPath, runtimeConfiguration(
    state, managementKey, proxyApiKey,
    String(process.env.CODING_TOOLS_CPA_OUTBOUND_PROXY_URL || ""),
  ));
  if (process.platform !== "win32") fs.chmodSync(configPath, 0o600);
  removeOldMainLogs(state);
  endStaleCpa(8317);

  const child = spawn(executable, ["--config", configPath, "--no-browser"], {
    cwd: state,
    env: { ...process.env },
    shell: false,
    windowsHide: true,
    stdio: "inherit",
  });

  const forward = (signal) => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } catch {}
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  child.once("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  // CPA outlives the app (a keep-bridge quit detaches it), and reads a plugin's models only when
  // it loads the plugin's auth file: keep the plugin model watcher running for as long as CPA.
  // The app runs one too, so a CPA started by an older wrapper is still covered.
  const pluginModels = watchCpaPluginModels({
    stateRoot: state,
    logger: { warn: (event, detail) => console.error(`${event} ${detail?.message ?? ""}`.trim()) },
    // CPA listens on the loopback port this config sets; the switcher's own route fetches the list.
    // This wrapper is its own process with no window to hold, so it fetches in place (the app's
    // off-thread worker is for Electron main).
    refresh: { baseUrl: "http://127.0.0.1:8317", managementKey, fetchImpl: fetch },
  });
  child.once("exit", (code, signal) => {
    pluginModels.stop();
    process.exitCode = Number.isInteger(code) ? code : signal ? 1 : 0;
  });
}

if (require.main === module) {
  const command = process.argv[2];
  if (command === "prepare") {
    prepare(process.argv[3], process.argv[4], process.argv[5]);
  } else if (command === "run") {
    run(process.argv[3], process.argv[4]);
  } else if (command === "refresh") {
    refresh(process.argv[3]);
  } else {
    throw new Error("CPA managed adapter command must be prepare, run or refresh");
  }
}

function helperPricesPath(stateRoot) {
  return path.join(providerManagerDataDir(requiredAbsolutePath(stateRoot, "CPA state root")), "helper", "prices.json");
}

module.exports = {
  ACCOUNT_KINDS,
  RETIRED_PLUGINS,
  cpaOnPort,
  endStaleCpa,
  helperPricesPath,
  mergePluginConfigs,
  migrateAuthFiles,
  providerManagerDataDir,
  stampAccountKind,
  prepare,
  refreshConfiguration,
  run,
  runtimeConfiguration,
  removeOldMainLogs,
  installBundledCommandCodePlugin,
};
