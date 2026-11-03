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

const PLUGIN_FILE = /^([a-z0-9][a-z0-9_-]*?)(?:-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))?\.dll$/i;
const DOWNLOAD_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
const MAX_PLUGIN_BYTES = 128 * 1024 * 1024;
const CHECK_TTL_MS = 30 * 60_000;
const UPDATES_FILE = "plugin-updates.json";

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
  let token;

  async function githubToken() {
    if (token !== undefined) return token;
    token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || await ghToken(spawnImpl);
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
        : { at: now(), error: "No release yet" };
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
      note: check?.reason || "Switches to the new version once it passes a health check, or goes back to this one.",
      error: check?.error || null, updating: updating.has("cpa") || component?.updateOperation?.state === "installing",
      releaseUrl: latest ? `https://github.com/router-for-me/CLIProxyAPI/releases/tag/${check?.tag || `v${latest}`}` : null,
    };
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
    const latest = release.version;
    if (source.rebuilt) {
      const newer = Boolean(plugin.version && compare(baseVersion(latest), baseVersion(plugin.version)) > 0);
      return { ...base, latest, releaseUrl: release.url, updateAvailable: newer,
        note: newer ? "Built for Coding Tools from this repository: the new version arrives in an app update." : "Built for Coding Tools from this repository." };
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
    const current = cli.status();
    const installed = current.installed ? current.version : null;
    const item = { ...base, installed, updating: base.updating || Boolean(current.installing) };
    const release = await latestRelease(TOOL_SOURCES["antigravity-cli"], force);
    if (release.error) return { ...item, error: release.error };
    const latest = release.version;
    const shown = { ...item, latest, releaseUrl: release.url };
    if (!installed) return { ...shown, note: "Not installed: install it on the Antigravity CLI page." };
    const newer = compare(latest, installed) > 0;
    const target = newer ? antigravityTarget(cli, release) : null;
    return { ...shown, updateAvailable: newer, canUpdate: Boolean(target),
      note: newer && !target ? "This release has no build to install here: it arrives in an app update." : null };
  }

  /** winget's own install (a Packages folder or its Links shim): the one `winget upgrade` can update. */
  const fromWinget = (file) => platform === "win32" && /[\\/]WinGet[\\/](Packages|Links)[\\/]/iu.test(String(file || ""));

  async function rtkItem(force) {
    const base = toolBase("rtk");
    if (!rtk) return { ...base, note: "Starts with the app." };
    const current = await rtk.status();
    const item = { ...base, installed: current.version || null, updating: base.updating || Boolean(current.installing) };
    const release = await latestRelease(TOOL_SOURCES.rtk, force);
    if (release.error) return { ...item, error: release.error };
    const shown = { ...item, latest: release.version, releaseUrl: release.url };
    if (!item.installed) return { ...shown, note: "Not installed: install it on the RTK page." };
    const newer = compare(release.version, item.installed) > 0;
    const winget = fromWinget(current.path) && typeof rtk.upgrade === "function";
    return { ...shown, updateAvailable: newer, canUpdate: newer && winget,
      note: !newer ? null : winget ? "Updates with winget (rtk-ai.rtk)." : "Installed without winget: update it the way you installed it." };
  }

  async function list({ refresh = false } = {}) {
    const items = [await cpaItem(refresh), await antigravityItem(refresh), await rtkItem(refresh)];
    for (const plugin of await installedPlugins()) items.push(await pluginItem(plugin, refresh));
    return { items, checkedAt: new Date(now()).toISOString() };
  }

  async function updateAntigravity() {
    const cli = antigravityCli();
    if (!cli) throw new Error("The Antigravity CLI hasn't started yet");
    const release = await latestRelease(TOOL_SOURCES["antigravity-cli"], true);
    if (release.error) throw new Error(release.error);
    const target = antigravityTarget(cli, release);
    if (!target) throw new Error("This release has no build to install here");
    const from = cli.status().version;
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

  async function updatePlugin(id) {
    const plugin = (await installedPlugins()).find((item) => item.id === id);
    const source = PLUGIN_SOURCES[id];
    if (!plugin || !source || source.rebuilt) throw new Error("This plugin can't be updated from GitHub");
    const release = await latestRelease(source, true);
    if (release.error) throw new Error(release.error);
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
    await restartCpa();
  }

  async function update(itemId) {
    const key = String(itemId || "");
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
        await updatePlugin(key.slice("cpa-plugin:".length));
      } else {
        throw new Error("Unknown app plugin");
      }
    } finally {
      updating.delete(key);
    }
    return list({ refresh: true });
  }

  return { list, update };
}

module.exports = { PLUGIN_SOURCES, TOOL_SOURCES, parsePluginFile, readPluginUpdates, baseVersion, createAppPlugins };
