"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createAppPlugins, parsePluginFile, baseVersion } = require("../electron/app-plugins.cjs");
const { installBundledCommandCodePlugin } = require("../electron/cpa-managed.cjs");

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const tempRoot = (name) => fs.mkdtempSync(path.join(__dirname, `../../aiTemp/${name}-`));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake GitHub: the release lists per repository, and asset bytes behind a redirect. */
function fakeGitHub({ releases, assets = {} }) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, auth: init.headers?.Authorization ?? null });
    const list = /^\/repos\/([^/]+\/[^/]+)\/releases$/.exec(url.pathname);
    if (url.hostname === "api.github.com" && list) {
      return releases[list[1]] ? json(releases[list[1]]) : json({ message: "Not Found" }, 404);
    }
    // GitHub's latest: the first stable, non-draft release of the list.
    const latest = /^\/repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(url.pathname);
    if (url.hostname === "api.github.com" && latest) {
      const found = releases[latest[1]]?.find((item) => !item.draft && !item.prerelease);
      return found ? json(found) : json({ message: "Not Found" }, 404);
    }
    // A release download (the Antigravity CLI's public archive URL), then its redirect.
    if (url.hostname === "github.com" && /\/releases\/download\//.test(url.pathname)) {
      return new Response(null, { status: 302, headers: { location: `https://objects.githubusercontent.com/asset/${url.pathname.split("/").pop()}` } });
    }
    const asset = /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/.exec(url.pathname);
    if (url.hostname === "api.github.com" && asset) {
      return new Response(null, { status: 302, headers: { location: `https://objects.githubusercontent.com/asset/${asset[1]}?sig=1` } });
    }
    if (url.hostname === "objects.githubusercontent.com") return new Response(assets[url.pathname.split("/").pop()]);
    return new Response("unexpected", { status: 500 });
  };
  return { fetchImpl, calls };
}

function setup({ releases, assets, files = {}, cpa = { version: "8.0.46", latest: "8.0.51", available: true }, antigravityCli = () => null, rtk = null }) {
  const root = tempRoot("app-plugins");
  const stateDir = path.join(root, "cpa");
  const pluginDir = path.join(stateDir, "plugins", "windows", "amd64");
  fs.mkdirSync(pluginDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(pluginDir, name), body);
  const github = fakeGitHub({ releases, assets });
  const updates = [];
  let restarts = 0;
  const services = {
    managedComponentsSnapshot: () => ({ components: [{ id: "cpa", version: cpa.version, update: null }] }),
    checkManagedComponentUpdate: async () => ({ id: "cpa", current: cpa.version, latest: cpa.latest, tag: `v${cpa.latest}`, available: cpa.available }),
    updateManagedComponent: async (id, options) => { updates.push([id, options]); return { swapped: true, from: cpa.version, to: cpa.latest }; },
  };
  const plugins = createAppPlugins({
    cpaStateDir: stateDir, services: () => services, restartCpa: async () => { restarts += 1; }, antigravityCli, rtk,
    fetchImpl: github.fetchImpl, env: { GH_TOKEN: "ghp_testtoken0123456789abcdef" }, spawnImpl: () => { throw new Error("no gh"); },
    platform: "win32", arch: "x64", logger: { info() {} },
  });
  return { root, stateDir, pluginDir, plugins, github, updates, restarts: () => restarts };
}

const release = (tag, assets = [], extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/x/releases/tag/${tag}`, assets, ...extra });

test("a plugin's id and version come from its DLL's name", () => {
  assert.deepEqual(parsePluginFile("cpa-provider-manager-v0.2.1.dll"), { id: "cpa-provider-manager", version: "0.2.1" });
  assert.deepEqual(parsePluginFile("cline-pass-switcher-v0.1.0-codingtools.10.dll"), { id: "cline-pass-switcher", version: "0.1.0-codingtools.10" });
  assert.deepEqual(parsePluginFile("hand-made.dll"), { id: "hand-made", version: null });
  assert.equal(parsePluginFile("notes.txt"), null);
  assert.equal(baseVersion("1.0.0-codingtools.3"), "1.0.0");
});

test("App plugins lists CPA and each plugin with its installed and latest GitHub version", async () => {
  const dll = Buffer.from("provider manager 0.2.2");
  const { plugins, github } = setup({
    files: {
      "cpa-provider-manager-v0.2.1.dll": "old",
      "commandcode-go-v1.0.0-codingtools.3.dll": "ours",
      "cpa-helper-v0.1.1.dll": "helper",
      "someone-else-v1.0.0.dll": "unknown",
    },
    releases: {
      // A prerelease and a draft are skipped; the newest stable release is the one offered.
      "p90-lover/cpa_provider_manager": [release("v0.3.0", [], { prerelease: true }), release("v0.2.9", [], { draft: true }),
        release("v0.2.2", [{ id: 7, name: "cpa-provider-manager-v0.2.2.dll", size: dll.length, digest: `sha256:${sha(dll)}` }])],
      "sperictao/cpa-plugin-commandcode-go": [release("v1.1.0", [{ id: 9, name: "commandcode-go-v1.1.0.so", size: 3, digest: `sha256:${sha("x")}` }])],
    },
  });
  const { items } = await plugins.list();
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));
  assert.deepEqual([byId.cpa.installed, byId.cpa.latest, byId.cpa.canUpdate], ["8.0.46", "8.0.51", true]);
  const manager = byId["cpa-plugin:cpa-provider-manager"];
  assert.deepEqual([manager.installed, manager.latest, manager.updateAvailable, manager.canUpdate], ["0.2.1", "0.2.2", true, true]);
  // A rebuild for Coding Tools shows its upstream's version, but the update comes with the app.
  const commandcode = byId["cpa-plugin:commandcode-go"];
  assert.deepEqual([commandcode.latest, commandcode.updateAvailable, commandcode.canUpdate], ["1.1.0", true, false]);
  assert.match(commandcode.note, /app update/);
  // No release for a private repository read without access: said plainly, nothing offered.
  assert.equal(byId["cpa-plugin:cpa-helper"].error, "Not found on GitHub");
  assert.match(byId["cpa-plugin:someone-else"].note, /repository isn't known/);
  // The token went to api.github.com only.
  assert.ok(github.calls.every((call) => call.auth === null || new URL(call.url).hostname === "api.github.com"));
});

test("a plugin update downloads the DLL, checks GitHub's SHA-256, keeps the old one in Trash and restarts CPA", async () => {
  const dll = Buffer.from("provider manager 0.2.2");
  const context = setup({
    files: { "cpa-provider-manager-v0.2.1.dll": "old" },
    releases: { "p90-lover/cpa_provider_manager": [release("v0.2.2", [{ id: 7, name: "cpa-provider-manager-v0.2.2.dll", size: dll.length, digest: `sha256:${sha(dll)}` }])] },
    assets: { 7: dll },
  });
  const { items } = await context.plugins.update("cpa-plugin:cpa-provider-manager");
  assert.deepEqual(fs.readdirSync(context.pluginDir), ["cpa-provider-manager-v0.2.2.dll"]);
  assert.equal(fs.readFileSync(path.join(context.pluginDir, "cpa-provider-manager-v0.2.2.dll"), "utf8"), "provider manager 0.2.2");
  const trash = path.join(context.stateDir, "Trash", "plugins");
  assert.deepEqual(fs.readdirSync(path.join(trash, fs.readdirSync(trash)[0])), ["cpa-provider-manager-v0.2.1.dll"]);
  const record = JSON.parse(fs.readFileSync(path.join(context.stateDir, "plugin-updates.json"), "utf8"));
  assert.deepEqual([record.plugins["cpa-provider-manager"].version, record.plugins["cpa-provider-manager"].sha256], ["0.2.2", sha(dll)]);
  assert.equal(context.restarts(), 1);
  assert.equal(items.find((item) => item.id === "cpa-plugin:cpa-provider-manager").installed, "0.2.2");
  // The redirect to the download host carried no token.
  const download = context.github.calls.find((call) => call.url.startsWith("https://objects.githubusercontent.com/"));
  assert.equal(download.auth, null);
});

test("a download that doesn't match GitHub's SHA-256 changes nothing", async () => {
  const context = setup({
    files: { "cpa-provider-manager-v0.2.1.dll": "old" },
    releases: { "p90-lover/cpa_provider_manager": [release("v0.2.2", [{ id: 7, name: "cpa-provider-manager-v0.2.2.dll", size: 8, digest: `sha256:${sha("expected")}` }])] },
    assets: { 7: Buffer.from("tampered") },
  });
  await assert.rejects(context.plugins.update("cpa-plugin:cpa-provider-manager"), /doesn't match GitHub's SHA-256/);
  assert.deepEqual(fs.readdirSync(context.pluginDir), ["cpa-provider-manager-v0.2.1.dll"]);
  assert.equal(fs.existsSync(path.join(context.stateDir, "plugin-updates.json")), false);
  assert.deepEqual(fs.readdirSync(path.join(context.stateDir, "plugin-downloads")), []);
  assert.equal(context.restarts(), 0);
});

test("CPA updates through its own updater, and a rebuild can't be updated from GitHub", async () => {
  const context = setup({ files: { "grok-login-provider-v0.1.0-codingtools.2.dll": "ours" }, releases: { "chenyme/grok2api": [release("v2.0.0")] } });
  await context.plugins.update("cpa");
  assert.deepEqual(context.updates, [["cpa", { swap: true }]]);
  await assert.rejects(context.plugins.update("cpa-plugin:grok-login-provider"), /can't be updated from GitHub/);
});

/** An installed Antigravity CLI (pinned 1.0.0, already unpacked) and the archive of a newer release. */
function antigravity(root) {
  const { createAntigravityCli, tarBinary } = require("../electron/antigravity-cli.cjs");
  const payload = path.join(root, "agy-payload");
  fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload, "antigravity.exe"), "agy 1.1.0");
  const archivePath = path.join(root, "agy.zip");
  require("node:child_process").execFileSync(tarBinary(), ["-a", "-cf", archivePath, "-C", payload, "antigravity.exe"]);
  const archive = fs.readFileSync(archivePath);
  const manifestPath = path.join(root, "agy-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ id: "antigravity-cli", name: "Antigravity CLI", version: "1.0.0", command: "agy",
    repository: "google-antigravity/antigravity-cli", platforms: { win32: { x64: {
      fileName: "agy_cli_windows_x64.zip", size: 1, sha256: "0".repeat(64), executable: "antigravity.exe" } } } }));
  const toolsRoot = path.join(root, "tools");
  const home = path.join(toolsRoot, "antigravity-cli", "1.0.0");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "antigravity.exe"), "agy 1.0.0");
  fs.writeFileSync(path.join(home, "CODING_TOOLS_TOOL.json"), JSON.stringify({ id: "antigravity-cli", version: "1.0.0", executable: "antigravity.exe" }));
  const make = (fetchImpl) => createAntigravityCli({ toolsRoot, manifestPath, platform: "win32", arch: "x64",
    confirm: async () => { throw new Error("an update is the person's click: no second prompt"); }, getWorkspaces: async () => [], fetchImpl, logger: {} });
  return { archive, toolsRoot, make };
}

const agyRelease = (tag, archive, digest = `sha256:${sha(archive)}`) => release(tag,
  [{ id: 31, name: "agy_cli_windows_x64.zip", size: archive.length, digest }, { id: 32, name: "agy_cli_linux_x64.tar.gz", size: 10, digest: `sha256:${sha("l")}` }]);

test("the Antigravity CLI updates to GitHub's latest release, checked against its SHA-256, and then runs that version",
  { skip: process.platform !== "win32" }, async () => {
    const root = tempRoot("app-plugins-agy");
    const { archive, toolsRoot, make } = antigravity(root);
    let cli;
    const context = setup({
      // A newer prerelease isn't offered; GitHub's latest is the stable 1.1.0 (tags have no "v").
      releases: { "google-antigravity/antigravity-cli": [release("1.2.0", [], { prerelease: true }), agyRelease("1.1.0", archive)] },
      assets: { "agy_cli_windows_x64.zip": archive },
      antigravityCli: () => cli,
    });
    cli = make(context.github.fetchImpl);
    const before = (await context.plugins.list()).items.find((item) => item.id === "antigravity-cli");
    assert.deepEqual([before.kind, before.installed, before.latest, before.updateAvailable, before.canUpdate], ["tool", "1.0.0", "1.1.0", true, true]);
    const { items } = await context.plugins.update("antigravity-cli");
    assert.equal(items.find((item) => item.id === "antigravity-cli").installed, "1.1.0");
    assert.deepEqual([cli.status().version, cli.status().pinned], ["1.1.0", "1.0.0"]);
    const executable = path.join(toolsRoot, "antigravity-cli", "1.1.0", "antigravity.exe");
    assert.equal(cli.executable(), executable);
    assert.match(fs.readFileSync(path.join(toolsRoot, "bin", "agy.cmd"), "utf8"), /1\.1\.0.*antigravity\.exe/s);
    assert.equal(fs.existsSync(path.join(toolsRoot, "antigravity-cli", "1.0.0")), false, "the old build went to Trash");
    // The pinned install doesn't take the CLI back to 1.0.0.
    assert.equal((await cli.install()).version, "1.1.0");
    // The token went to api.github.com only: the archive came from GitHub's public download.
    assert.ok(context.github.calls.every((call) => call.auth === null || new URL(call.url).hostname === "api.github.com"));
    assert.ok(context.github.calls.some((call) => call.url === "https://github.com/google-antigravity/antigravity-cli/releases/download/1.1.0/agy_cli_windows_x64.zip"));
  });

test("an Antigravity CLI release that doesn't match GitHub's SHA-256, or has no build here, changes nothing",
  { skip: process.platform !== "win32" }, async () => {
    const root = tempRoot("app-plugins-agy-bad");
    const { archive, toolsRoot, make } = antigravity(root);
    let cli;
    const context = setup({
      releases: { "google-antigravity/antigravity-cli": [agyRelease("1.1.0", archive, `sha256:${sha("something else")}`)] },
      assets: { "agy_cli_windows_x64.zip": archive },
      antigravityCli: () => cli,
    });
    cli = make(context.github.fetchImpl);
    await assert.rejects(context.plugins.update("antigravity-cli"), /pinned checksum/);
    assert.equal(cli.status().version, "1.0.0");
    assert.deepEqual(fs.readdirSync(path.join(toolsRoot, "antigravity-cli")).filter((name) => !name.startsWith(".")), ["1.0.0"]);
    // A release without this platform's archive is shown, but there's nothing to install.
    const bare = setup({ releases: { "google-antigravity/antigravity-cli": [release("1.1.0", [])] }, antigravityCli: () => cli });
    const item = (await bare.plugins.list()).items.find((entry) => entry.id === "antigravity-cli");
    assert.deepEqual([item.updateAvailable, item.canUpdate], [true, false]);
    await assert.rejects(bare.plugins.update("antigravity-cli"), /no build to install here/);
  });

/** RTK's service as App plugins sees it: `winget upgrade` moves it to `upgradeTo`. */
function fakeRtk({ version = "1.0.1", file = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\rtk-ai.rtk_Microsoft.Winget.Source_8wekyb3d8bbwe\\rtk.exe", upgradeTo = "1.1.0", code = 0 } = {}) {
  const upgrades = [];
  const state = { version };
  return {
    upgrades,
    rtk: {
      status: async () => ({ installed: true, installing: false, path: file, version: state.version }),
      upgrade: async () => {
        upgrades.push(state.version);
        if (upgradeTo) state.version = upgradeTo;
        return { code, output: code ? "No available upgrade found." : "Successfully installed", status: { version: state.version } };
      },
    },
  };
}

test("RTK shows GitHub's newest stable release past its dev prereleases and updates with winget", async () => {
  const { rtk, upgrades } = fakeRtk();
  const context = setup({
    releases: { "rtk-ai/rtk": [release("dev-1.2.0-rc.607", [], { prerelease: true }), release("dev-1.2.0-rc.606", [], { prerelease: true }), release("v1.1.0")] },
    rtk,
  });
  const before = (await context.plugins.list()).items.find((item) => item.id === "rtk");
  assert.deepEqual([before.kind, before.installed, before.latest, before.canUpdate], ["tool", "1.0.1", "1.1.0", true]);
  assert.match(before.note, /winget/);
  const { items } = await context.plugins.update("rtk");
  assert.deepEqual(upgrades, ["1.0.1"]);
  const after = items.find((item) => item.id === "rtk");
  assert.deepEqual([after.installed, after.updateAvailable], ["1.1.0", false]);
});

test("RTK installed without winget isn't upgraded with it, and a winget with nothing newer says so", async () => {
  const releases = { "rtk-ai/rtk": [release("v1.1.0")] };
  const cargo = fakeRtk({ file: "C:\\Users\\me\\.cargo\\bin\\rtk.exe" });
  const manual = setup({ releases, rtk: cargo.rtk });
  const item = (await manual.plugins.list()).items.find((entry) => entry.id === "rtk");
  assert.deepEqual([item.updateAvailable, item.canUpdate], [true, false]);
  assert.match(item.note, /without winget/);
  await assert.rejects(manual.plugins.update("rtk"), /wasn't installed with winget/);
  assert.deepEqual(cargo.upgrades, []);
  // winget's catalog can trail GitHub: no newer rtk there is an error, not "updated".
  const stale = fakeRtk({ upgradeTo: null, code: 0x8A15002B });
  await assert.rejects(setup({ releases, rtk: stale.rtk }).plugins.update("rtk"), /winget didn't update rtk 1\.0\.1 .*No available upgrade found/);
});

test("CPA's start keeps a plugin updated from GitHub while it is newer than the bundled copy",
  { skip: process.platform !== "win32" || process.arch !== "x64" }, () => {
    const state = path.join(tempRoot("app-plugins-bundle"), "cpa");
    const dir = path.join(state, "plugins", "windows", "amd64");
    fs.mkdirSync(dir, { recursive: true });
    const updated = "cpa-helper 0.1.2 from GitHub";
    fs.writeFileSync(path.join(dir, "cpa-helper-v0.1.2.dll"), updated);
    const record = (version, file, digest) => fs.writeFileSync(path.join(state, "plugin-updates.json"),
      JSON.stringify({ schemaVersion: 1, plugins: { "cpa-helper": { version, file, sha256: digest } } }));
    record("0.1.2", "cpa-helper-v0.1.2.dll", sha(updated));
    const installed = installBundledCommandCodePlugin(state);
    assert.ok(installed.includes(path.join(dir, "cpa-helper-v0.1.2.dll")));
    assert.equal(fs.existsSync(path.join(dir, "cpa-helper-v0.1.1.dll")), false, "the bundled 0.1.1 isn't copied over it");
    // A changed file is no longer the checked update: the bundled copy comes back.
    fs.writeFileSync(path.join(dir, "cpa-helper-v0.1.2.dll"), "changed");
    installBundledCommandCodePlugin(state);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith("cpa-helper-")), ["cpa-helper-v0.1.1.dll"]);
  });
