"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createHash } = require("node:crypto");
const { runtimeConfiguration, installBundledCommandCodePlugin } = require("../electron/cpa-managed.cjs");
const os = require("node:os");
const root = path.resolve(__dirname, "../..");
const source = path.join(root, "desktop-electron/vendor/cpa-plugins/cline-pass-switcher");
test("the full switcher and MIT notice are pinned, and its native CPA binary matches the bundle", (t) => {
  assert.ok(fs.existsSync(path.join(source, "upstream/server.js")), "missing pinned switcher server");
  assert.ok(fs.existsSync(path.join(source, "upstream/public/index.html")), "missing full switcher console");
  assert.match(fs.readFileSync(path.join(source, "upstream/LICENSE"), "utf8"), /MIT License/);
  const bundle = JSON.parse(fs.readFileSync(path.join(root, "desktop-electron/vendor/bundled/cpa-plugins/BUNDLE.json")));
  assert.equal(bundle.cline.id, "cline-pass-switcher");
  assert.equal(bundle.cline.provider, "cline");
  assert.equal(bundle.cline.source.commit, "02538a3137a08948a94f26f17dd4aeff8c029ed1");
  const asset = bundle.cline.platforms["win32/x64"];
  const dll = fs.readFileSync(path.join(root, "desktop-electron/vendor/bundled/cpa-plugins", asset.path));
  assert.equal(createHash("sha256").update(dll).digest("hex"), asset.sha256);
  if (process.platform === "win32" && process.arch === "x64") {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "cline-plugin-install-"));
    t.after(() => fs.rmSync(state, { recursive: true, force: true }));
    const installed = installBundledCommandCodePlugin(state).find(file => path.basename(file) === path.basename(asset.path));
    assert.ok(installed, "the managed loader accepts the rebuilt Cline plugin");
    assert.equal(createHash("sha256").update(fs.readFileSync(installed)).digest("hex"), asset.sha256);
  }
});

test("CPA Auto Review ships with its fallback chain and replaces a hand-installed older copy", (t) => {
  const bundle = JSON.parse(fs.readFileSync(path.join(root, "desktop-electron/vendor/bundled/cpa-plugins/BUNDLE.json")));
  assert.equal(bundle.autoReview.id, "codex-review-account-selector");
  assert.equal(bundle.autoReview.source.commit, "52239a513eb14d995d1530ce79e0b30ed6e687ea");
  const asset = bundle.autoReview.platforms["win32/x64"];
  const dll = fs.readFileSync(path.join(root, "desktop-electron/vendor/bundled/cpa-plugins", asset.path));
  assert.equal(dll.length, asset.size);
  assert.equal(createHash("sha256").update(dll).digest("hex"), asset.sha256);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "auto-review-plugin-install-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const config = runtimeConfiguration(state, "management-fixture".repeat(3), "proxy-fixture".repeat(4));
  assert.match(config, /codex-review-account-selector:\n      enabled: true/);
  assert.ok(config.includes(JSON.stringify(path.join(state, "codex-review-account-selector-data"))), "its selection stays in its own folder");
  if (process.platform === "win32" && process.arch === "x64") {
    const directory = path.join(state, "plugins", "windows", "amd64");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "codex-review-account-selector-v0.1.0-codingtools.5.dll"), "hand-installed 0.1.0");
    const installed = installBundledCommandCodePlugin(state).find(file => path.basename(file) === path.basename(asset.path));
    assert.ok(installed, "the managed loader installs CPA Auto Review");
    assert.equal(createHash("sha256").update(fs.readFileSync(installed)).digest("hex"), asset.sha256);
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.startsWith("codex-review-account-selector")), [path.basename(asset.path)],
      "the one-account 0.1.0 copy is moved aside, so CPA loads only the fallback version");
  }
});

test("managed console boots with CPA's marker and maps only its own API requests", async () => {
  const vm = require("node:vm");
  const go = fs.readFileSync(path.join(source, "plugin.go"), "utf8");
  const script = go.match(/const consoleBridge = `<script>([\s\S]*?)<\/script>`/)[1];
  const marker = "coding-tools-" + "a".repeat(48);
  const values = new Map([["managementKey", "enc:v1:fixture-encrypted-store"], ["cli-proxy-auth", "enc:v1:fixture-encrypted-store"]]);
  const calls = [];
  const window = { fetch: async (...args) => { calls.push(args); return {}; } };
  vm.runInNewContext(script, { window, URL, Headers,
    sessionStorage: { getItem: key => key === "coding-tools-cpa-session" ? marker : null }, location: new URL("http://127.0.0.1:8317/v0/resource/plugins/cline-pass-switcher/index.html"),
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
  assert.equal(values.get("cps_key"), marker);
  await window.fetch("/api/accounts", { headers: { "X-Admin-Key": "stale-switcher-key" } });
  assert.equal(calls[0][0], "/v0/management/cline-pass-switcher/api/accounts");
  assert.equal(calls[0][1].headers.get("Authorization"), "Bearer " + marker);
  assert.equal(calls[0][1].headers.has("X-Admin-Key"), false);
  await window.fetch("https://example.invalid/api/accounts");
  assert.equal(calls[1][1].headers, undefined);
});

test("managed CPA enables the Cline plugin using the owned runtime/data directory without account keys", (t) => {
  const scratch = path.join(root, "aiTemp", "cline-pass-integration");
  fs.mkdirSync(scratch, { recursive: true });
  const state = fs.mkdtempSync(path.join(scratch, "adapter-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const config = runtimeConfiguration(state, "management-fixture".repeat(3), "proxy-fixture".repeat(4));
  assert.match(config, /cline-pass-switcher:\n      enabled: true/);
  assert.ok(config.includes(JSON.stringify(process.execPath)), "managed runtime must be explicit");
  assert.ok(config.includes(JSON.stringify(path.join(state, "cline-pass-switcher-data"))));
  assert.ok(fs.existsSync(path.join(state, "auth", "cline-pass-switcher.json")), "missing local Cline provider");
  assert.doesNotMatch(config, /CLINE_PASS_KEY|sk_[a-f0-9]{64}/);
});
