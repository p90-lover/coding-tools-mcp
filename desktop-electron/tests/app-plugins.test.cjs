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

/** A fake GitHub: the release lists per repository, branch heads, and asset bytes behind a redirect. */
function fakeGitHub({ releases, assets = {}, branches = {}, compares = {}, defaultBranches = {} }) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, auth: init.headers?.Authorization ?? null });
    const list = /^\/repos\/([^/]+\/[^/]+)\/releases$/.exec(url.pathname);
    if (url.hostname === "api.github.com" && list) {
      return releases[list[1]] ? json(releases[list[1]]) : json({ message: "Not Found" }, 404);
    }
    // A branch's head commit, and how far it is ahead of a commit ({ head, ahead } per "owner/name@branch").
    const branch = /^\/repos\/([^/]+\/[^/]+)\/branches\/([^/]+)$/.exec(url.pathname);
    if (url.hostname === "api.github.com" && branch) {
      const known = branches[`${branch[1]}@${branch[2]}`];
      return known ? json({ name: branch[2], commit: { sha: known.head } }) : json({ message: "Not Found" }, 404);
    }
    // A repository's default branch ("owner/name": "main").
    const repository = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname);
    if (url.hostname === "api.github.com" && repository) {
      return defaultBranches[repository[1]] ? json({ default_branch: defaultBranches[repository[1]] }) : json({ message: "Not Found" }, 404);
    }
    // A commit against a release tag ({ "owner/name@<commit>...<tag>": ahead }).
    const tagged = /^\/repos\/([^/]+\/[^/]+)\/compare\/([0-9a-f]+)\.\.\.(.+)$/.exec(url.pathname);
    const taggedAhead = tagged ? compares[`${tagged[1]}@${tagged[2]}...${decodeURIComponent(tagged[3])}`] : undefined;
    if (url.hostname === "api.github.com" && taggedAhead !== undefined) return json({ status: "ahead", ahead_by: taggedAhead, behind_by: 0 });
    const compare = /^\/repos\/([^/]+\/[^/]+)\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(url.pathname);
    if (url.hostname === "api.github.com" && compare) {
      const known = Object.entries(branches).find(([key, value]) => key.startsWith(`${compare[1]}@`) && value.head === compare[3])?.[1];
      return known ? json({ status: "ahead", ahead_by: known.ahead, behind_by: 0 }) : json({ message: "Not Found" }, 404);
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

function setup({ releases, assets, branches, compares, defaultBranches, bundle = null, files = {}, cpa = { version: "8.0.46", latest: "8.0.51", available: true }, antigravityCli = () => null, rtk = null, aoManifest = null }) {
  const root = tempRoot("app-plugins");
  const stateDir = path.join(root, "cpa");
  const pluginDir = path.join(stateDir, "plugins", "windows", "amd64");
  fs.mkdirSync(pluginDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(pluginDir, name), body);
  const github = fakeGitHub({ releases, assets, branches, compares, defaultBranches });
  // The app's BUNDLE.json of shipped plugin builds: none unless a test gives one.
  const pluginBundleFile = path.join(root, "BUNDLE.json");
  if (bundle) fs.writeFileSync(pluginBundleFile, JSON.stringify(bundle));
  const aoRoot = path.join(root, "agent-orchestrator");
  if (aoManifest) {
    fs.mkdirSync(aoRoot, { recursive: true });
    fs.writeFileSync(path.join(aoRoot, "manifest.json"), JSON.stringify(aoManifest));
  }
  const updates = [];
  let restarts = 0;
  const services = {
    managedComponentsSnapshot: () => ({ components: [{ id: "cpa", version: cpa.version, update: null }] }),
    checkManagedComponentUpdate: async () => ({ id: "cpa", current: cpa.version, latest: cpa.latest, tag: `v${cpa.latest}`, available: cpa.available }),
    updateManagedComponent: async (id, options) => { updates.push([id, options]); return { swapped: true, from: cpa.version, to: cpa.latest }; },
  };
  const plugins = createAppPlugins({
    cpaStateDir: stateDir, services: () => services, restartCpa: async () => { restarts += 1; }, antigravityCli, rtk, agentOrchestratorRoot: () => aoRoot,
    fetchImpl: github.fetchImpl, env: { GH_TOKEN: "ghp_testtoken0123456789abcdef" }, spawnImpl: () => { throw new Error("no gh"); },
    platform: "win32", arch: "x64", logger: { info() {} }, pluginBundleFile,
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
      "cline-pass-switcher-v0.1.0-codingtools.10.dll": "switcher",
      "someone-else-v1.0.0.dll": "unknown",
    },
    releases: {
      // A prerelease and a draft are skipped; the newest stable release is the one offered.
      "p90-lover/cpa_provider_manager": [release("v0.3.0", [], { prerelease: true }), release("v0.2.9", [], { draft: true }),
        release("v0.2.2", [{ id: 7, name: "cpa-provider-manager-v0.2.2.dll", size: dll.length, digest: `sha256:${sha(dll)}` }])],
      "sperictao/cpa-plugin-commandcode-go": [release("v1.1.0", [{ id: 9, name: "commandcode-go-v1.1.0.so", size: 3, digest: `sha256:${sha("x")}` }])],
      "munmunjaklin458-afk/cline-pass-switcher": [],
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
  assert.equal(commandcode.viaAppUpdate, true);
  // No release for a private repository read without access: said plainly, nothing offered.
  assert.equal(byId["cpa-plugin:cpa-helper"].error, "Not found on GitHub");
  assert.match(byId["cpa-plugin:someone-else"].note, /repository isn't known/);
  // A repository with no release yet is not a failure: nothing to compare with.
  const switcher = byId["cpa-plugin:cline-pass-switcher"];
  assert.deepEqual([switcher.latest, switcher.error, switcher.updateAvailable], [null, null, false]);
  // The token went to api.github.com only.
  assert.ok(github.calls.every((call) => call.auth === null || new URL(call.url).hostname === "api.github.com"));
});

test("a rebuild is compared by the upstream commit it was built from, not by its own version", async () => {
  // 0.8.107 (2026-11-10): Grok login 0.1.0-codingtools.2 is built from grok2api, whose releases are
  // 3.x, so comparing versions offered "3.1.8" forever, even after rebuilding from it.
  const grokCommit = "7c889a960e2638341b4dae9a5c81af0e0f38c87f";
  const clineCommit = "02538a3137a08948a94f26f17dd4aeff8c029ed1";
  const clineHead = "9a8b7c6d".padEnd(40, "e");
  const helperHead = "bb2287a".padEnd(40, "0");
  const bundle = {
    id: "commandcode-go", version: "1.0.0-codingtools.3", source: { commit: "444ee977daaa96e6fa6ef5155b14cac3a6f9cdc3" },
    grok: { id: "grok-login-provider", version: "0.1.0-codingtools.2", source: { commit: grokCommit } },
    cline: { id: "cline-pass-switcher", version: "0.1.0-codingtools.10", source: { commit: clineCommit } },
    helper: { id: "cpa-helper", version: "0.1.1", source: { commit: "bb2287a" } },
  };
  const files = {
    "grok-login-provider-v0.1.0-codingtools.2.dll": "grok",
    "cline-pass-switcher-v0.1.0-codingtools.10.dll": "cline",
    "cpa-helper-v0.1.1.dll": "helper",
  };
  const rows = async (grokAhead) => {
    const context = setup({
      files, bundle,
      releases: { "chenyme/grok2api": [release("v3.1.8")], "munmunjaklin458-afk/cline-pass-switcher": [], "p90-lover/cpa-helper-plugin": [] },
      compares: { [`chenyme/grok2api@${grokCommit}...v3.1.8`]: grokAhead },
      defaultBranches: { "munmunjaklin458-afk/cline-pass-switcher": "main", "p90-lover/cpa-helper-plugin": "main" },
      branches: { "munmunjaklin458-afk/cline-pass-switcher@main": { head: clineHead, ahead: 2 }, "p90-lover/cpa-helper-plugin@main": { head: helperHead, ahead: 0 } },
    });
    const { items } = await context.plugins.list();
    return Object.fromEntries(items.map((item) => [item.id, item]));
  };
  const behind = await rows(24);
  const grok = behind["cpa-plugin:grok-login-provider"];
  assert.deepEqual([grok.installed, grok.latest, grok.updateAvailable, grok.viaAppUpdate, grok.canUpdate, grok.error],
    ["0.1.0-codingtools.2", "3.1.8", true, true, false, null]);
  assert.equal(grok.note, "Built from 7c889a9; v3.1.8 has 24 newer commits.");
  assert.match(grok.releaseUrl, /\/chenyme\/grok2api\/compare\/7c889a960e26\.\.\.v3\.1\.8$/);
  // Rebuilt from that release (or later): nothing to offer, whatever the versions say.
  const current = (await rows(0))["cpa-plugin:grok-login-provider"];
  assert.deepEqual([current.latest, current.updateAvailable, current.viaAppUpdate, current.note], ["3.1.8", false, false, "Built from 7c889a9, v3.1.8 or later."]);
  // No release upstream: its default branch. Neither row was a silent null.
  const cline = behind["cpa-plugin:cline-pass-switcher"];
  assert.deepEqual([cline.latest, cline.updateAvailable, cline.viaAppUpdate, cline.canUpdate], ["9a8b7c6", true, true, false]);
  assert.equal(cline.note, "Built from 02538a3; main has 2 newer commits (no release yet).");
  // CPA Helper ships with the app: nothing here to auto-update.
  const helper = behind["cpa-plugin:cpa-helper"];
  assert.deepEqual([helper.updateAvailable, helper.canUpdate, helper.autoUpdatable, helper.autoUpdate], [false, false, false, false]);
  assert.equal(helper.note, "Built from bb2287a, main's latest (no release yet).");
});

test("a rebuild that isn't the copy the app ships, or whose repository has no release, still says so", async () => {
  const context = setup({
    files: { "grok-login-provider-v0.1.0-codingtools.9.dll": "hand-built", "cline-pass-switcher-v0.1.0-codingtools.10.dll": "cline" },
    bundle: { grok: { id: "grok-login-provider", version: "0.1.0-codingtools.2", source: { commit: "7c889a960e2638341b4dae9a5c81af0e0f38c87f" } } },
    releases: { "chenyme/grok2api": [release("v0.1.0")], "munmunjaklin458-afk/cline-pass-switcher": [] },
  });
  const byId = Object.fromEntries((await context.plugins.list()).items.map((item) => [item.id, item]));
  // A hand-built copy isn't the bundled build: compared by version, as before.
  const grok = byId["cpa-plugin:grok-login-provider"];
  assert.deepEqual([grok.latest, grok.updateAvailable, grok.error], ["0.1.0", false, null]);
  assert.equal(context.github.calls.some((call) => call.url.includes("/compare/")), false);
  // No bundled build and no release: a note, not a blank row.
  assert.equal(byId["cpa-plugin:cline-pass-switcher"].note, "Updates with the app; its repository has no release yet.");
});

test("Agent Orchestrator shows the commit built into the app against its fork's main branch", async () => {
  const built = "265e9a39e73a173e3c15766a8dbf4a918548f33b";
  const head = "7c1d2e0f".padEnd(40, "a");
  const context = setup({ releases: {}, aoManifest: { repository: "p90-lover/agent-orchestrator", commit: built },
    branches: { "p90-lover/agent-orchestrator@main": { head, ahead: 3 } } });
  const ao = (await context.plugins.list()).items.find((item) => item.id === "agent-orchestrator");
  assert.deepEqual([ao.kind, ao.installed, ao.latest, ao.updateAvailable, ao.canUpdate, ao.viaAppUpdate], ["service", "265e9a3", "7c1d2e0", true, false, true]);
  assert.equal(ao.note, "3 new commits on main.");
  assert.match(ao.releaseUrl, /\/compare\/265e9a39e73a\.\.\.7c1d2e0faaaa$/);
  // Built from main's head: nothing to compare.
  const current = setup({ releases: {}, aoManifest: { repository: "p90-lover/agent-orchestrator", commit: built },
    branches: { "p90-lover/agent-orchestrator@main": { head: built, ahead: 0 } } });
  const same = (await current.plugins.list()).items.find((item) => item.id === "agent-orchestrator");
  assert.deepEqual([same.latest, same.updateAvailable, same.note], ["265e9a3", false, null]);
  assert.equal(current.github.calls.some((call) => call.url.includes("/compare/")), false);
  // A development copy with no AO build.
  const none = (await setup({ releases: {} }).plugins.list()).items.find((item) => item.id === "agent-orchestrator");
  assert.deepEqual([none.installed, none.note], [null, "Not built into this copy of the app."]);
});

test("Update all installs every update it can, CPA last, and keeps going past a failure", async () => {
  const good = Buffer.from("provider manager 0.2.2");
  const releases = {
    "p90-lover/cpa_provider_manager": [release("v0.2.2", [{ id: 7, name: "cpa-provider-manager-v0.2.2.dll", size: good.length, digest: `sha256:${sha(good)}` }])],
    "p90-lover/cpa_auto_review": [release("v0.3.0", [{ id: 8, name: "codex-review-account-selector-v0.3.0.dll", size: 3, digest: `sha256:${sha("bad")}` }])],
    "sperictao/cpa-plugin-commandcode-go": [release("v1.1.0")],
  };
  const files = { "cpa-provider-manager-v0.2.1.dll": "old", "codex-review-account-selector-v0.2.0.dll": "old", "commandcode-go-v1.0.0-codingtools.3.dll": "built" };
  const context = setup({ releases, files, assets: { 7: good, 8: Buffer.from("not it") } });
  const { results, items } = await context.plugins.updateAll();
  assert.deepEqual(results.map((entry) => [entry.id, entry.ok]),
    [["cpa-plugin:codex-review-account-selector", false], ["cpa-plugin:cpa-provider-manager", true], ["cpa", true]]);
  assert.match(results[0].error, /SHA-256/);
  assert.deepEqual(context.updates, [["cpa", { swap: true }]]);
  // CPA's own switch restarted it with the new plugin: no second restart.
  assert.equal(context.restarts(), 0);
  assert.equal(items.find((item) => item.id === "cpa-plugin:cpa-provider-manager").installed, "0.2.2");
  // A rebuild that arrives with the app is left alone.
  assert.ok(!results.some((entry) => entry.id === "cpa-plugin:commandcode-go"));

  // Plugins alone: CPA restarts once for all of them.
  const plugins = setup({ releases, files: { "cpa-provider-manager-v0.2.1.dll": "old" }, assets: { 7: good }, cpa: { version: "8.0.51", latest: "8.0.51", available: false } });
  const second = await plugins.plugins.updateAll();
  assert.deepEqual(second.results.map((entry) => entry.ok), [true]);
  assert.equal(plugins.restarts(), 1);
});

test("auto-update is kept per item and installs only the items that have it on, on a timer", async () => {
  const good = Buffer.from("provider manager 0.2.2");
  const releases = {
    "p90-lover/cpa_provider_manager": [release("v0.2.2", [{ id: 7, name: "cpa-provider-manager-v0.2.2.dll", size: good.length, digest: `sha256:${sha(good)}` }])],
    "sperictao/cpa-plugin-commandcode-go": [release("v1.1.0")],
  };
  const files = { "cpa-provider-manager-v0.2.1.dll": "old", "commandcode-go-v1.0.0-codingtools.3.dll": "built" };
  const context = setup({ releases, files, assets: { 7: good } });
  const before = Object.fromEntries((await context.plugins.list()).items.map((item) => [item.id, item]));
  assert.deepEqual([before.cpa.autoUpdatable, before.cpa.autoUpdate], [true, false]);
  // What ships in an app update can't be auto-updated here.
  assert.equal(before["agent-orchestrator"].autoUpdatable, false);
  assert.equal(before["cpa-plugin:commandcode-go"].autoUpdatable, false);
  await assert.rejects(context.plugins.setAutoUpdate("cpa-plugin:commandcode-go", true), /updates with the app/);
  // Nothing on: a pass installs nothing.
  assert.deepEqual((await context.plugins.autoUpdateNow()).results, []);
  assert.equal(fs.existsSync(path.join(context.pluginDir, "cpa-provider-manager-v0.2.2.dll")), false);

  const { items } = await context.plugins.setAutoUpdate("cpa-plugin:cpa-provider-manager", true);
  assert.equal(items.find((item) => item.id === "cpa-plugin:cpa-provider-manager").autoUpdate, true);
  const saved = JSON.parse(fs.readFileSync(path.join(context.root, "app-plugins.json"), "utf8"));
  assert.deepEqual(saved.autoUpdate, { "cpa-plugin:cpa-provider-manager": true });

  // The timer's pass installs that plugin and leaves CPA (auto-update off) alone.
  const timers = [];
  const stop = context.plugins.startAutoUpdates({ firstMs: 10, everyMs: 20, setTimer: (run, ms) => { timers.push({ run, ms }); return timers.length; }, clearTimer() {} });
  assert.deepEqual(timers.map((timer) => timer.ms), [10]);
  await timers[0].run();
  assert.ok(fs.existsSync(path.join(context.pluginDir, "cpa-provider-manager-v0.2.2.dll")));
  assert.deepEqual(context.updates, []);
  assert.equal(context.restarts(), 1, "CPA restarts once to load the new plugin");
  assert.deepEqual(timers.map((timer) => timer.ms), [10, 20], "and checks again later");
  stop();

  // A fresh start reads the saved choice; turning it off forgets it.
  const again = createAppPlugins({ cpaStateDir: context.stateDir, services: () => ({ managedComponentsSnapshot: () => ({ components: [] }), checkManagedComponentUpdate: async () => ({}) }),
    restartCpa: async () => {}, fetchImpl: async () => new Response("{}", { status: 404 }), env: { GH_TOKEN: "ghp_testtoken0123456789abcdef" },
    platform: "win32", arch: "x64", logger: { info() {} } });
  assert.equal((await again.list()).items.find((item) => item.id === "cpa-plugin:cpa-provider-manager").autoUpdate, true);
  await again.setAutoUpdate("cpa-plugin:cpa-provider-manager", false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(context.root, "app-plugins.json"), "utf8")).autoUpdate, {});
});

test("auto-update switches flipped at once are both saved, with no staging file left behind", async () => {
  const good = Buffer.from("provider manager 0.2.2");
  const releases = { "p90-lover/cpa_provider_manager": [release("v0.2.2", [{ id: 7, name: "cpa-provider-manager-v0.2.2.dll", size: good.length, digest: `sha256:${sha(good)}` }])] };
  const context = setup({ releases, files: { "cpa-provider-manager-v0.2.1.dll": "old" }, assets: { 7: good } });
  // Two clicks before the first save finishes: they used to share one staging file (ENOENT on the
  // second rename) and both start from the same old settings, so one change was lost.
  await Promise.all([
    context.plugins.setAutoUpdate("cpa", true),
    context.plugins.setAutoUpdate("cpa-plugin:cpa-provider-manager", true),
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(context.root, "app-plugins.json"), "utf8")).autoUpdate,
    { cpa: true, "cpa-plugin:cpa-provider-manager": true });
  assert.deepEqual(fs.readdirSync(context.root).filter((name) => name.endsWith(".tmp")), []);
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
  assert.equal(before.note, null);
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

// CPA loads one plugin, Provider Manager; its build is the one BUNDLE.json describes.
const providerManager = () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, "../vendor/bundled/cpa-plugins/BUNDLE.json"), "utf8"));
  assert.equal(bundle.id, "cpa-provider-manager");
  return { version: bundle.version, asset: bundle.platforms["win32/x64"], file: path.basename(bundle.platforms["win32/x64"].path) };
};

test("CPA's start keeps a plugin updated from GitHub while it is newer than the bundled copy",
  { skip: process.platform !== "win32" || process.arch !== "x64" }, (t) => {
    const root = tempRoot("app-plugins-bundle");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const state = path.join(root, "cpa");
    const dir = path.join(state, "plugins", "windows", "amd64");
    fs.mkdirSync(dir, { recursive: true });
    const bundled = providerManager();
    // Newer than any bundled build.
    const newer = "cpa-provider-manager-v99.0.0.dll";
    const updated = "cpa-provider-manager 99.0.0 from GitHub";
    fs.writeFileSync(path.join(dir, newer), updated);
    fs.writeFileSync(path.join(state, "plugin-updates.json"), JSON.stringify({
      schemaVersion: 1, plugins: { "cpa-provider-manager": { version: "99.0.0", file: newer, sha256: sha(updated) } },
    }));
    const installed = installBundledCommandCodePlugin(state);
    assert.deepEqual(installed, [path.join(dir, newer)]);
    assert.equal(fs.existsSync(path.join(dir, bundled.file)), false, `the bundled ${bundled.version} isn't copied over it`);
    // A changed file is no longer the checked update: the bundled copy comes back.
    fs.writeFileSync(path.join(dir, newer), "changed");
    assert.deepEqual(installBundledCommandCodePlugin(state), [path.join(dir, bundled.file)]);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith("cpa-provider-manager-")), [bundled.file]);
    assert.equal(sha(fs.readFileSync(path.join(dir, bundled.file))), bundled.asset.sha256);
  });

test("CPA's bundled Provider Manager replaces an older checked update with the pinned DLL",
  { skip: process.platform !== "win32" || process.arch !== "x64" }, (t) => {
    const root = tempRoot("app-plugins-provider-manager");
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const state = path.join(root, "cpa");
    const dir = path.join(state, "plugins", "windows", "amd64");
    fs.mkdirSync(dir, { recursive: true });
    const older = "cpa-provider-manager 0.0.1 from GitHub";
    fs.writeFileSync(path.join(dir, "cpa-provider-manager-v0.0.1.dll"), older);
    fs.writeFileSync(path.join(state, "plugin-updates.json"), JSON.stringify({
      schemaVersion: 1,
      plugins: { "cpa-provider-manager": { version: "0.0.1", file: "cpa-provider-manager-v0.0.1.dll", sha256: sha(older) } },
    }));
    const { asset, file } = providerManager();
    const installed = installBundledCommandCodePlugin(state);
    const target = path.join(dir, file);
    assert.deepEqual(installed, [target]);
    assert.equal(sha(fs.readFileSync(target)), asset.sha256);
    assert.equal(fs.statSync(target).size, asset.size);
    assert.equal(fs.existsSync(path.join(dir, "cpa-provider-manager-v0.0.1.dll")), false);
    const trash = path.join(state, "Trash", "plugins");
    assert.deepEqual(fs.readdirSync(trash).map((name) => fs.readdirSync(path.join(trash, name))), [["cpa-provider-manager-v0.0.1.dll"]],
      "the older copy is kept in Trash");
  });
