"use strict";

/**
 * App plugins (Connections > App plugins): what the app runs from other projects, the version
 * installed and the latest on GitHub, and an update where one can be installed safely.
 *
 * - CPA (CLIProxyAPI) updates through its managed-component updater (checksums, a side-by-side
 *   install, a health-checked switch that rolls back).
 * - CPA's plugins are the DLLs in CPA's plugins folder, bundled or added by hand. A plugin whose
 *   repository publishes `<id>-v<version>.dll` with GitHub's SHA-256 digest is downloaded,
 *   checked against that digest, put beside the old one (which goes to Trash) and recorded in
 *   plugin-updates.json, so CPA's start keeps it over an older bundled copy.
 * - Plugins rebuilt for Coding Tools from someone else's repository show that repository's latest
 *   version; its releases have no Windows build of ours, so a new one arrives in an app update.
 * - The Antigravity CLI updates to the latest release's archive for this platform, checked against
 *   GitHub's size and SHA-256 and unpacked with the pinned install's archive checks
 *   (antigravity-cli.cjs update).
 * - RTK, installed with winget, updates with `winget upgrade` (rtk.cjs upgrade). Its releases are
 *   mostly dev-* prereleases, so both read GitHub's latest stable release.
 * - Agent Orchestrator is built into the app from a pinned commit of its fork (the manifest.json
 *   beside the daemon). It is compared with the fork's main branch; a newer AO arrives in an app update.
 * - Update all installs every update that can be installed here, CPA last: plugin DLLs load when
 *   CPA starts, so CPA restarts once for all of them (its own update restarts it anyway).
 * - Auto-update is the person's choice per item (app-plugins.json beside CPA's state folder): a
 *   check soon after start and then every few hours installs the updates of the items that have it
 *   on, the same way Update all does. What ships in an app update can't be auto-updated here.
 *
 * Private repositories (the p90-lover plugins) need a GitHub token: GH_TOKEN/GITHUB_TOKEN, or the
 * signed-in `gh` CLI. The token goes only to api.github.com, never to a download host.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { compareVersions } = require("./update.cjs");
const { releaseManifest, platformAsset } = require("./antigravity-cli.cjs");

const PLUGIN_SOURCES = Object.freeze({
  "cpa-helper": { name: "CPA Helper", repository: "p90-lover/cpa-helper-plugin" },
  "codex-review-account-selector": { name: "CPA Auto Review", repository: "p90-lover/cpa_auto_review" },
  "cpa-provider-manager": { name: "CPA Provider Manager", repository: "p90-lover/cpa_provider_manager" },
  "commandcode-go": { name: "CommandCode", repository: "sperictao/cpa-plugin-commandcode-go", rebuilt: true },
  "auth-commandcode": { name: "CommandCode login", repository: "UNICKCHENG/cliproxyapi-plugins", tagPrefix: "auth-commandcode-v", rebuilt: true },
  "grok-login-provider": { name: "Grok login", repository: "chenyme/grok2api", rebuilt: true },
  "cline-pass-switcher": { name: "Cline Pass switcher", repository: "munmunjaklin458-afk/cline-pass-switcher", rebuilt: true },
});

/** Tools agents run, read from GitHub's latest stable release (`latest`). */
const TOOL_SOURCES = Object.freeze({
  "antigravity-cli": { name: "Antigravity CLI", repository: "google-antigravity/antigravity-cli", latest: true },
  rtk: { name: "RTK", repository: "rtk-ai/rtk", latest: true },
});

/** Agent Orchestrator's fork: the branch the app's pinned AO commit is built from. */
const AO_SOURCE = Object.freeze({ repository: "p90-lover/agent-orchestrator", branch: "main" });
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;

const PLUGIN_FILE = /^([a-z0-9][a-z0-9_-]*?)(?:-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))?\.dll$/i;
const DOWNLOAD_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
const MAX_PLUGIN_BYTES = 128 * 1024 * 1024;
const CHECK_TTL_MS = 30 * 60_000;
const UPDATES_FILE = "plugin-updates.json";
const SETTINGS_FILE = "app-plugins.json";
const AUTO_FIRST_MS = 5 * 60_000;
const AUTO_EVERY_MS = 6 * 60 * 60_000;

/** A plugin DLL's id and version, from its file name (`<id>-v<version>.dll` or `<id>.dll`). */
function parsePluginFile(name) {
  const match = PLUGIN_FILE.exec(String(name));
  return match ? { id: match[1], version: match[2] || null } : null;
}

/** -1, 0 or 1; versions that aren't x.y.z[-pre] compare as equal (nothing to offer). */
function compare(left, right) {
  try { return compareVersions(left, right); } catch { return 0; }
}

/** A "-codingtools.N" rebuild compares with its upstream by the version it was built from. */
const baseVersion = (version) => String(version || "").replace(/-codingtools\.\d+$/u, "");

// Every read and write here is async: they run on Electron main from the sidebar's list and its
// Update button, and a synchronous call on the busy disk holds every window (main-sync-calls.test.cjs).
async function readPluginUpdates(stateDir) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(path.join(stateDir, UPDATES_FILE), "utf8"));
    return parsed && typeof parsed.plugins === "object" && parsed.plugins ? parsed : { schemaVersion: 1, plugins: {} };
  } catch { return { schemaVersion: 1, plugins: {} }; }
}

async function writePluginUpdates(stateDir, record) {
  const target = path.join(stateDir, UPDATES_FILE);
  const staging = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(staging, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(staging, target);
}

/** `gh auth token` (the user's signed-in GitHub CLI), or null. Never logged. */
function ghToken(spawnImpl = spawn) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawnImpl("gh", ["auth", "token"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, 5_000);
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const token = out.trim();
      resolve(code === 0 && /^[A-Za-z0-9_]{20,255}$/u.test(token) ? token : null);
    });
  });
}

function createAppPlugins({
  cpaStateDir,
  services,
  restartCpa,
  // The Antigravity CLI service, made with the backend (null until it starts), and RTK's.
  antigravityCli = () => null,
  rtk = null,
  // The folder holding AO's daemon and its build manifest.json (null before the backend starts).
  agentOrchestratorRoot = () => null,
  // Where the auto-update choices are kept: beside CPA's state folder by default.
  settingsDir = null,
  logger = console,
  fetchImpl = fetch,
  env = process.env,
  spawnImpl = spawn,
  platform = process.platform,
  arch = process.arch,
  now = () => Date.now(),
}) {
  if (!cpaStateDir || !path.isAbsolute(cpaStateDir)) throw new Error("App plugins need CPA's state folder");
  const pluginDir = path.join(cpaStateDir, "plugins", "windows", "amd64");
  const releases = new Map();
  const updating = new Set();
  const settingsFile = path.join(settingsDir || path.dirname(cpaStateDir), SETTINGS_FILE);
  let token;
  let settings = null;

  async function readSettings() {
    if (settings) return settings;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(settingsFile, "utf8"));
      settings = { schemaVersion: 1, autoUpdate: parsed && typeof parsed.autoUpdate === "object" && parsed.autoUpdate ? parsed.autoUpdate : {} };
    } catch { settings = { schemaVersion: 1, autoUpdate: {} }; }
    return settings;
  }

  /** An item the app can install updates for, so auto-update means something: not one that ships in an app update. */
  const autoUpdatable = (item) => item.id === "cpa" || item.id === "antigravity-cli" || item.id === "rtk"
    || (item.kind === "cpa-plugin" && Boolean(PLUGIN_SOURCES[item.id.slice("cpa-plugin:".length)]) && !PLUGIN_SOURCES[item.id.slice("cpa-plugin:".length)].rebuilt);

  // One lookup however many checks ask at once: the list checks every item together.
  function githubToken() {
    token ??= Promise.resolve(env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || ghToken(spawnImpl));
    return token;
  }

  async function github(pathname) {
    const auth = await githubToken();
    const response = await fetchImpl(`https://api.github.com${pathname}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Coding-Tools",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) throw new Error(auth ? "Not found on GitHub" : "Private on GitHub: sign in with `gh auth login`");
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    return response.json();
  }

  /** The newest non-draft, non-prerelease release (with the tag prefix of a shared repository). */
  async function latestRelease(source, force) {
    const key = `${source.repository}#${source.tagPrefix || ""}`;
    const cached = releases.get(key);
    if (!force && cached && now() - cached.at < CHECK_TTL_MS) return cached;
    let entry;
    try {
      const prefix = source.tagPrefix || "";
      // GitHub's own latest: the newest stable release, however many prereleases came after it.
      const release = source.latest
        ? await github(`/repos/${source.repository}/releases/latest`)
        : (await github(`/repos/${source.repository}/releases?per_page=30`).then((list) => (Array.isArray(list) ? list : [])))
          .find((item) => !item.draft && !item.prerelease && String(item.tag_name || "").startsWith(prefix));
      entry = release
        ? { at: now(), tag: release.tag_name, version: release.tag_name.slice(prefix.length).replace(/^v/u, ""), url: release.html_url, assets: release.assets || [] }
        : { at: now(), none: true };
    } catch (error) {
      entry = { at: now(), error: error instanceof Error ? error.message : String(error) };
    }
    releases.set(key, entry);
    return entry;
  }

  /** How far `branch` is ahead of `commit`: { head, ahead, url }, or { error }. */
  async function branchAhead(repository, branch, commit, force) {
    const key = `${repository}@${branch}..${commit}`;
    const cached = releases.get(key);
    if (!force && cached && now() - cached.at < CHECK_TTL_MS) return cached;
    let entry;
    try {
      const head = String((await github(`/repos/${repository}/branches/${encodeURIComponent(branch)}`))?.commit?.sha || "");
      if (!/^[0-9a-f]{40}$/u.test(head)) throw new Error("GitHub gave no commit for the branch");
      const ahead = head === commit ? 0
        : Number((await github(`/repos/${repository}/compare/${commit}...${head}?per_page=1`))?.ahead_by) || 0;
      entry = { at: now(), head, ahead, url: ahead ? `https://github.com/${repository}/compare/${commit.slice(0, 12)}...${head.slice(0, 12)}`
        : `https://github.com/${repository}/commit/${commit}` };
    } catch (error) {
      entry = { at: now(), error: error instanceof Error ? error.message : String(error) };
    }
    releases.set(key, entry);
    return entry;
  }

  async function installedPlugins() {
    if (platform !== "win32" || arch !== "x64") return [];
    let names = [];
    try { names = (await fs.promises.readdir(pluginDir)).filter((name) => name.toLowerCase().endsWith(".dll")); } catch { return []; }
    const byId = new Map();
    for (const name of names) {
      const parsed = parsePluginFile(name);
      if (!parsed) continue;
      const known = byId.get(parsed.id);
      // Two copies of one plugin (a hand-installed one beside ours): the newer is the one shown.
      if (!known || compare(parsed.version, known.version) > 0) byId.set(parsed.id, { ...parsed, file: name });
    }
    return [...byId.values()];
  }

  /** The DLL a release offers for this plugin version, with the digest GitHub computed for it. */
  function releaseDll(release, id) {
    const asset = release.assets?.find((item) => item.name === `${id}-v${release.version}.dll`);
    const sha256 = /^sha256:([a-f0-9]{64})$/u.exec(String(asset?.digest || ""))?.[1];
    return asset && sha256 && asset.size > 0 && asset.size <= MAX_PLUGIN_BYTES ? { ...asset, sha256 } : null;
  }

  async function cpaItem(force) {
    const component = services()?.managedComponentsSnapshot?.()?.components?.find((item) => item.id === "cpa");
    let check = component?.update || null;
    if (force || !check) {
      try { check = await services().checkManagedComponentUpdate("cpa"); } catch (error) {
        check = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    const installed = component?.version || null;
    const latest = check?.latest || null;
    // The updater's own answer: it also leaves out a version that failed its health check here.
    const available = Boolean(installed && latest && check?.available);
    return {
      id: "cpa", kind: "service", name: "CPA (CLIProxyAPI)", repository: "router-for-me/CLIProxyAPI",
      installed, latest, updateAvailable: available, canUpdate: available,
      note: check?.reason || null,
      error: check?.error || null, updating: updating.has("cpa") || component?.updateOperation?.state === "installing",
      releaseUrl: latest ? `https://github.com/router-for-me/CLIProxyAPI/releases/tag/${check?.tag || `v${latest}`}` : null,
    };
  }

  async function agentOrchestratorItem(force) {
    const base = {
      id: "agent-orchestrator", kind: "service", name: "Agent Orchestrator", repository: AO_SOURCE.repository,
      installed: null, latest: null, updateAvailable: false, canUpdate: false, note: null, error: null, updating: false, releaseUrl: null,
    };
    const root = agentOrchestratorRoot();
    let manifest = null;
    try { manifest = root ? JSON.parse(await fs.promises.readFile(path.join(root, "manifest.json"), "utf8")) : null; } catch { /* not built */ }
    const commit = /^[0-9a-f]{40}$/u.test(String(manifest?.commit || "")) ? manifest.commit : null;
    if (!commit) return { ...base, note: "Not built into this copy of the app." };
    const repository = REPOSITORY.test(String(manifest.repository || "")) ? manifest.repository : AO_SOURCE.repository;
    const item = { ...base, repository, installed: commit.slice(0, 7) };
    const head = await branchAhead(repository, AO_SOURCE.branch, commit, force);
    if (head.error) return { ...item, error: head.error };
    return { ...item, latest: head.head.slice(0, 7), releaseUrl: head.url, updateAvailable: head.ahead > 0, viaAppUpdate: head.ahead > 0,
      note: head.ahead ? `${head.ahead} new commit${head.ahead === 1 ? "" : "s"} on ${AO_SOURCE.branch}.` : null };
  }

  async function pluginItem(plugin, force) {
    const source = PLUGIN_SOURCES[plugin.id];
    const base = {
      id: `cpa-plugin:${plugin.id}`, kind: "cpa-plugin", name: source?.name || plugin.id, file: plugin.file,
      repository: source?.repository || null, installed: plugin.version, latest: null,
      updateAvailable: false, canUpdate: false, note: null, error: null, updating: updating.has(`cpa-plugin:${plugin.id}`), releaseUrl: null,
    };
    if (!source) return { ...base, note: "Added by hand; its GitHub repository isn't known." };
    const release = await latestRelease(source, force);
    if (release.error) return { ...base, error: release.error };
    // Nothing published yet: nothing to compare with, and not a failure.
    if (release.none) return base;
    const latest = release.version;
    if (source.rebuilt) {
      const newer = Boolean(plugin.version && compare(baseVersion(latest), baseVersion(plugin.version)) > 0);
      // Built for Coding Tools from this repository: a newer version arrives in an app update.
      return { ...base, latest, releaseUrl: release.url, updateAvailable: newer, viaAppUpdate: newer };
    }
    const newer = !plugin.version || compare(latest, plugin.version) > 0;
    const dll = newer ? releaseDll(release, plugin.id) : null;
    return { ...base, latest, releaseUrl: release.url, updateAvailable: newer, canUpdate: Boolean(dll),
      note: newer && !dll ? "This release has no Windows build to install." : null };
  }

  const toolBase = (id) => ({
    id, kind: "tool", name: TOOL_SOURCES[id].name, repository: TOOL_SOURCES[id].repository, installed: null, latest: null,
    updateAvailable: false, canUpdate: false, note: null, error: null, updating: updating.has(id), releaseUrl: null,
  });

  /** The manifest the latest Antigravity CLI release installs from here, or null when it has no build for this platform. */
  function antigravityTarget(cli, release) {
    if (typeof cli?.update !== "function" || !cli.manifest) return null;
    try {
      const target = releaseManifest(cli.manifest, { tag_name: release.tag, assets: release.assets });
      platformAsset(target, platform, arch);
      return target;
    } catch { return null; }
  }

  async function antigravityItem(force) {
    const base = toolBase("antigravity-cli");
    const cli = antigravityCli();
    if (!cli) return { ...base, note: "Starts with Agent Orchestrator." };
    // Read off the main thread where the CLI offers it (its synchronous scan held every window).
    const current = typeof cli.statusAsync === "function" ? await cli.statusAsync() : cli.status();
    const installed = current.installed ? current.version : null;
    const item = { ...base, installed, updating: base.updating || Boolean(current.installing) };
    const release = await latestRelease(TOOL_SOURCES["antigravity-cli"], force);
    if (release.error || release.none) return { ...item, error: release.error || "No release on GitHub yet" };
    const latest = release.version;
    const shown = { ...item, latest, releaseUrl: release.url };
    if (!installed) return { ...shown, note: "Install it on the Antigravity CLI page." };
    const newer = compare(latest, installed) > 0;
    const target = newer ? antigravityTarget(cli, release) : null;
    // A release without a build for this platform arrives in an app update.
    return { ...shown, updateAvailable: newer, canUpdate: Boolean(target), viaAppUpdate: newer && !target };
  }

  /** winget's own install (a Packages folder or its Links shim): the one `winget upgrade` can update. */
  const fromWinget = (file) => platform === "win32" && /[\\/]WinGet[\\/](Packages|Links)[\\/]/iu.test(String(file || ""));

  async function rtkItem(force) {
    const base = toolBase("rtk");
    if (!rtk) return { ...base, note: "Starts with the app." };
    const current = await rtk.status();
    const item = { ...base, installed: current.version || null, updating: base.updating || Boolean(current.installing) };
    const release = await latestRelease(TOOL_SOURCES.rtk, force);
    if (release.error || release.none) return { ...item, error: release.error || "No release on GitHub yet" };
    const shown = { ...item, latest: release.version, releaseUrl: release.url };
    if (!item.installed) return { ...shown, note: "Install it on the RTK page." };
    const newer = compare(release.version, item.installed) > 0;
    const winget = fromWinget(current.path) && typeof rtk.upgrade === "function";
    return { ...shown, updateAvailable: newer, canUpdate: newer && winget,
      note: newer && !winget ? "Installed without winget: update it the way you installed it." : null };
  }

  // Every item is checked at once: one after another, a cold check waited on each GitHub call in turn.
  async function list({ refresh = false } = {}) {
    const plugins = await installedPlugins();
    const [items, { autoUpdate }] = await Promise.all([Promise.all([cpaItem(refresh), agentOrchestratorItem(refresh), antigravityItem(refresh), rtkItem(refresh),
      ...plugins.map((plugin) => pluginItem(plugin, refresh))]), readSettings()]);
    for (const item of items) {
      item.autoUpdatable = autoUpdatable(item);
      item.autoUpdate = item.autoUpdatable && autoUpdate[item.id] === true;
    }
    return { items, checkedAt: new Date(now()).toISOString() };
  }

  async function updateAntigravity() {
    const cli = antigravityCli();
    if (!cli) throw new Error("The Antigravity CLI hasn't started yet");
    const release = await latestRelease(TOOL_SOURCES["antigravity-cli"], true);
    if (release.error || release.none) throw new Error(release.error || "No release on GitHub yet");
    const target = antigravityTarget(cli, release);
    if (!target) throw new Error("This release has no build to install here");
    const from = (typeof cli.statusAsync === "function" ? await cli.statusAsync() : cli.status()).version;
    const status = await cli.update(target);
    if (status?.version !== target.version) throw new Error(`The Antigravity CLI is still ${status?.version ?? from}`);
    logger.info?.("app-plugins.updated", { plugin: "antigravity-cli", from, to: target.version });
  }

  async function updateRtk() {
    if (!rtk || typeof rtk.upgrade !== "function") throw new Error("RTK can't be updated from here");
    const before = await rtk.status();
    if (!fromWinget(before.path)) throw new Error("RTK wasn't installed with winget: update it the way you installed it");
    const { code, output, status } = await rtk.upgrade();
    const after = status?.version || null;
    // winget answers non-zero when it has nothing newer (its catalog can trail GitHub): the version says what happened.
    if (!after || compare(after, before.version) <= 0) {
      throw new Error(`winget didn't update rtk ${before.version} (exit ${code})${output ? `: ${output.split(/\r?\n/u).filter(Boolean).pop()}` : ""}`);
    }
    logger.info?.("app-plugins.updated", { plugin: "rtk", from: before.version, to: after });
  }

  /** Streams one release asset to `target`, following GitHub's redirect without the token. */
  async function download(repository, asset, target) {
    const auth = await githubToken();
    let url = new URL(`https://api.github.com/repos/${repository}/releases/assets/${asset.id}`);
    for (let hop = 0; hop < 5; hop += 1) {
      const onApi = url.hostname === "api.github.com";
      if (url.protocol !== "https:" || !(onApi || DOWNLOAD_HOSTS.has(url.hostname))) throw new Error("The download left GitHub");
      const response = await fetchImpl(url, {
        redirect: "manual",
        headers: { Accept: "application/octet-stream", "User-Agent": "Coding-Tools", ...(onApi && auth ? { Authorization: `Bearer ${auth}` } : {}) },
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (response.status >= 300 && response.status < 400) {
        url = new URL(response.headers.get("location"), url);
        continue;
      }
      if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status})`);
      const hash = crypto.createHash("sha256");
      const out = fs.createWriteStream(target, { mode: 0o600 });
      let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_PLUGIN_BYTES) throw new Error("The download is larger than a plugin can be");
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
        }
      } finally {
        await new Promise((resolve) => out.end(resolve));
      }
      if (hash.digest("hex") !== asset.sha256) throw new Error("The download doesn't match GitHub's SHA-256 for it");
      return;
    }
    throw new Error("Too many redirects");
  }

  async function updatePlugin(id, restart = true) {
    const plugin = (await installedPlugins()).find((item) => item.id === id);
    const source = PLUGIN_SOURCES[id];
    if (!plugin || !source || source.rebuilt) throw new Error("This plugin can't be updated from GitHub");
    const release = await latestRelease(source, true);
    if (release.error || release.none) throw new Error(release.error || "No release on GitHub yet");
    if (plugin.version && compare(release.version, plugin.version) <= 0) return;
    const dll = releaseDll(release, id);
    if (!dll) throw new Error("This release has no Windows build to install");
    const downloads = path.join(cpaStateDir, "plugin-downloads");
    await fs.promises.mkdir(downloads, { recursive: true, mode: 0o700 });
    const staging = path.join(downloads, `${now()}-${dll.name}.part`);
    try {
      await download(source.repository, dll, staging);
      // A DLL CPA has loaded can be renamed but not deleted: the old copies move to Trash.
      const old = (await fs.promises.readdir(pluginDir)).filter((name) => parsePluginFile(name)?.id === id && name !== dll.name);
      const trash = path.join(cpaStateDir, "Trash", "plugins", `${now()}-${id}`);
      if (old.length) await fs.promises.mkdir(trash, { recursive: true, mode: 0o700 });
      for (const name of old) await fs.promises.rename(path.join(pluginDir, name), path.join(trash, name));
      await fs.promises.rename(staging, path.join(pluginDir, dll.name));
    } finally {
      await fs.promises.rm(staging, { force: true });
    }
    const record = await readPluginUpdates(cpaStateDir);
    record.plugins[id] = { version: release.version, file: dll.name, sha256: dll.sha256, repository: source.repository, installedAt: new Date(now()).toISOString() };
    await writePluginUpdates(cpaStateDir, record);
    logger.info?.("app-plugins.updated", { plugin: id, from: plugin.version, to: release.version });
    if (restart) await restartCpa();
  }

  /** Installs one update; a plugin restarts CPA unless `restart` is false (Update all restarts it once). */
  async function install(key, restart = true) {
    if (updating.has(key)) throw new Error("This update is already running");
    updating.add(key);
    try {
      if (key === "cpa") {
        const result = await services().updateManagedComponent("cpa", { swap: true });
        if (result?.rolledBack) throw new Error(`CPA ${result.to} failed its health check, so CPA ${result.from} stays: ${result.error}`);
      } else if (key === "antigravity-cli") {
        await updateAntigravity();
      } else if (key === "rtk") {
        await updateRtk();
      } else if (key.startsWith("cpa-plugin:")) {
        await updatePlugin(key.slice("cpa-plugin:".length), restart);
      } else {
        throw new Error("Unknown app plugin");
      }
    } finally {
      updating.delete(key);
    }
  }

  async function update(itemId) {
    await install(String(itemId || ""));
    return list({ refresh: true });
  }

  /**
   * Every update that can be installed here (or only those `pick` keeps), one at a time, CPA last.
   * A failure doesn't stop the rest; `results` says what happened to each.
   */
  async function updateAll(pick = () => true) {
    const { items } = await list({ refresh: true });
    const due = items.filter((item) => item.updateAvailable && item.canUpdate && !item.updating && pick(item))
      .sort((left, right) => Number(left.id === "cpa") - Number(right.id === "cpa"));
    const results = [];
    let pluginsChanged = false;
    let cpaRestarted = false;
    for (const item of due) {
      try {
        await install(item.id, false);
        if (item.kind === "cpa-plugin") pluginsChanged = true;
        if (item.id === "cpa") cpaRestarted = true;
        results.push({ id: item.id, name: item.name, ok: true, from: item.installed, to: item.latest });
      } catch (error) {
        results.push({ id: item.id, name: item.name, ok: false, from: item.installed, to: item.latest, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (pluginsChanged && !cpaRestarted) {
      try { await restartCpa(); } catch (error) {
        results.push({ id: "cpa", name: "CPA restart", ok: false, error: `The new plugins load when CPA next starts: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return { ...(await list({ refresh: due.length > 0 })), results };
  }

  /** Turns auto-update on or off for one item. */
  async function setAutoUpdate(itemId, enabled) {
    const key = String(itemId || "");
    const { items } = await list();
    const item = items.find((entry) => entry.id === key);
    if (!item) throw new Error("Unknown app plugin");
    if (!item.autoUpdatable) throw new Error(`${item.name} updates with the app`);
    const current = await readSettings();
    const autoUpdate = { ...current.autoUpdate };
    if (enabled === true) autoUpdate[key] = true; else delete autoUpdate[key];
    const next = { schemaVersion: 1, autoUpdate };
    await fs.promises.mkdir(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
    const staging = `${settingsFile}.${process.pid}.tmp`;
    await fs.promises.writeFile(staging, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(staging, settingsFile);
    settings = next;
    logger.info?.("app-plugins.auto_update", { plugin: key, enabled: enabled === true });
    return list();
  }

  /** One auto-update pass: installs the updates of the items with auto-update on. */
  async function autoUpdateNow() {
    const { autoUpdate } = await readSettings();
    if (!Object.values(autoUpdate).some(Boolean)) return { results: [] };
    const result = await updateAll((item) => item.autoUpdate);
    if (result.results.length) logger.info?.("app-plugins.auto_updated", { results: result.results.map(({ id, ok, from, to }) => ({ id, ok, from, to })) });
    return result;
  }

  /** Checks soon after start, then every few hours; returns a stop function. Never two passes at once. */
  function startAutoUpdates({ firstMs = AUTO_FIRST_MS, everyMs = AUTO_EVERY_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let timer = null;
    let stopped = false;
    const schedule = (ms) => {
      if (stopped) return;
      timer = setTimer(run, ms);
      timer?.unref?.();
    };
    async function run() {
      try { await autoUpdateNow(); } catch (error) {
        logger.warn?.("app-plugins.auto_update_failed", { message: error instanceof Error ? error.message : String(error) });
      }
      schedule(everyMs);
    }
    schedule(firstMs);
    return () => { stopped = true; if (timer) clearTimer(timer); };
  }

  return { list, update, updateAll: () => updateAll(), setAutoUpdate, autoUpdateNow, startAutoUpdates };
}

module.exports = { PLUGIN_SOURCES, TOOL_SOURCES, parsePluginFile, readPluginUpdates, baseVersion, createAppPlugins };
