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
const bundleRoot = path.join(root, "desktop-electron/vendor/bundled/cpa-plugins");
const readBundle = () => JSON.parse(fs.readFileSync(path.join(bundleRoot, "BUNDLE.json"), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The Cline Pass switcher and CPA Auto Review are parts of Provider Manager, the one plugin CPA loads.
test("Cline Pass ships inside Provider Manager: its DLL matches BUNDLE.json and the managed loader installs it", (t) => {
  const bundle = readBundle();
  assert.equal(bundle.id, "cpa-provider-manager");
  assert.match(bundle.source.repository, /cpa_provider_manager$/);
  assert.match(bundle.changes.join("\n"), /Cline Pass/);
  assert.deepEqual(Object.keys(bundle.platforms), ["win32/x64"], "one platform asset");
  const asset = bundle.platforms["win32/x64"];
  assert.equal(path.basename(asset.path), `cpa-provider-manager-v${bundle.version}.dll`);
  const dll = fs.readFileSync(path.join(bundleRoot, asset.path));
  assert.equal(dll.length, asset.size);
  assert.equal(sha256(dll), asset.sha256);
  if (process.platform === "win32" && process.arch === "x64") {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "cline-plugin-install-"));
    t.after(() => fs.rmSync(state, { recursive: true, force: true }));
    const installed = installBundledCommandCodePlugin(state);
    assert.deepEqual(installed.map((file) => path.basename(file)), [path.basename(asset.path)], "CPA gets Provider Manager alone");
    assert.equal(sha256(fs.readFileSync(installed[0])), asset.sha256);
  }
});

test("CPA Auto Review is Provider Manager's autoreview part: its folder is imported and hand-installed copies go to Trash", (t) => {
  const asset = readBundle().platforms["win32/x64"];
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "auto-review-plugin-install-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const config = runtimeConfiguration(state, "management-fixture".repeat(3), "proxy-fixture".repeat(4));
  assert.match(config, /^    cpa-provider-manager:\n      enabled: true$/m);
  assert.doesNotMatch(config, /^    codex-review-account-selector:/m, "the retired plugin has no configs entry");
  assert.ok(config.includes(`        autoreview: ${JSON.stringify(path.join(state, "codex-review-account-selector-data"))}`),
    "its selection is imported from its own folder");
  if (process.platform === "win32" && process.arch === "x64") {
    const directory = path.join(state, "plugins", "windows", "amd64");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "codex-review-account-selector-v0.1.0-codingtools.5.dll"), "hand-installed 0.1.0");
    fs.writeFileSync(path.join(directory, "codex-review-account-selector-v0.2.1-codingtools.1.dll"), "previously bundled 0.2.1");
    const data = path.join(state, "codex-review-account-selector-data");
    fs.mkdirSync(data, { recursive: true });
    const selection = JSON.stringify({ selectedAuthId: "primary-fixture", fallbacks: [{ authId: "fallback-fixture", model: "codex-auto-review" }] });
    fs.writeFileSync(path.join(data, "selection.json"), selection);
    const installed = installBundledCommandCodePlugin(state);
    assert.deepEqual(installed.map((file) => path.basename(file)), [path.basename(asset.path)]);
    assert.deepEqual(fs.readdirSync(directory), [path.basename(asset.path)],
      "the retired reviewer is moved aside, so it can't claim its provider before Provider Manager");
    const trash = path.join(state, "Trash", "plugins");
    const [retired] = fs.readdirSync(trash);
    assert.match(retired, /^\d+-retired$/);
    assert.deepEqual(fs.readdirSync(path.join(trash, retired)).sort(),
      ["codex-review-account-selector-v0.1.0-codingtools.5.dll", "codex-review-account-selector-v0.2.1-codingtools.1.dll"]);
    assert.equal(fs.readFileSync(path.join(data, "selection.json"), "utf8"), selection,
      "the user's primary and fallback settings stay for Provider Manager to import");
  }
});

test("managed CPA enables the Cline part using the owned runtime/data directory without account keys", (t) => {
  const scratch = path.join(root, "aiTemp", "cline-pass-integration");
  fs.mkdirSync(scratch, { recursive: true });
  const state = fs.mkdtempSync(path.join(scratch, "adapter-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const config = runtimeConfiguration(state, "management-fixture".repeat(3), "proxy-fixture".repeat(4));
  assert.match(config, /^    cpa-provider-manager:\n      enabled: true$/m);
  assert.doesNotMatch(config, /^    cline-pass-switcher:/m, "the retired plugin has no configs entry");
  assert.match(config, new RegExp(`^      cline:\\n        runtime-executable: ${escapeRegExp(JSON.stringify(process.execPath))}$`, "m"),
    "managed runtime must be explicit");
  assert.ok(config.includes(`      data-dir: ${JSON.stringify(path.join(state, "cpa-provider-manager-data"))}`));
  assert.ok(config.includes(`        cline: ${JSON.stringify(path.join(state, "cline-pass-switcher-data"))}`), "its former data is imported");
  const marker = JSON.parse(fs.readFileSync(path.join(state, "auth", "cline-pass-switcher.json"), "utf8"));
  assert.deepEqual(marker, { type: "provider-manager", kind: "cline", kindType: "cline", switcher: true, label: "Cline Pass" },
    "the local Cline provider is a Provider Manager account of kind cline");
  assert.doesNotMatch(config, /CLINE_PASS_KEY|sk_[a-f0-9]{64}/);
});

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
