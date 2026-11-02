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
    const asset = /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/.exec(url.pathname);
    if (url.hostname === "api.github.com" && asset) {
      return new Response(null, { status: 302, headers: { location: `https://objects.githubusercontent.com/asset/${asset[1]}?sig=1` } });
    }
    if (url.hostname === "objects.githubusercontent.com") return new Response(assets[url.pathname.split("/").pop()]);
    return new Response("unexpected", { status: 500 });
  };
  return { fetchImpl, calls };
}

function setup({ releases, assets, files = {}, cpa = { version: "8.0.46", latest: "8.0.51", available: true } }) {
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
    cpaStateDir: stateDir, services: () => services, restartCpa: async () => { restarts += 1; },
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
