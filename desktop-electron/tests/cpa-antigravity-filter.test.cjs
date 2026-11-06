"use strict";
require("./support/temp-dirs.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const yaml = globalThis.Bun?.YAML ?? require("js-yaml");
const parse = yaml.parse ?? yaml.load;
const stringify = yaml.stringify ?? yaml.dump;
const { runtimeConfiguration, installBundledCommandCodePlugin } = require("../electron/cpa-managed.cjs");
const root = path.resolve(__dirname, "../..");
const id = "antigravity-coding-filter";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-antigravity-filter-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("managed CPA defaults to rewriting and preserves custom filter settings on repeated refresh", (t) => {
  const state = fixture(t);
  const config = parse(runtimeConfiguration(state, "m".repeat(40), "p".repeat(40)));
  assert.deepEqual(config.plugins.configs[id], {
    enabled: true, priority: 1, mode: "rewrite", use_default_keywords: true, custom_mappings: {},
  });
  const custom = { enabled: false, priority: 7, mode: "block", use_default_keywords: false,
    custom_mappings: { "Claude Code": "Antigravity", "My Agent": "Antigravity" } };
  config.plugins.configs[id] = custom;
  for (let i = 0; i < 2; i++) {
    fs.writeFileSync(path.join(state, "config.yaml"), stringify(config));
    Object.assign(config, parse(runtimeConfiguration(state, "m".repeat(40), "p".repeat(40))));
    assert.deepEqual(config.plugins.configs[id], custom);
  }
  config.plugins.configs[id] = [];
  fs.writeFileSync(path.join(state, "config.yaml"), stringify(config));
  assert.throws(() => runtimeConfiguration(state, "m".repeat(40), "p".repeat(40)), /invalid/);
});

test("the pinned Antigravity filter DLL is bundled and installed with its matching digest", (t) => {
  const bundleRoot = path.join(root, "desktop-electron/vendor/bundled/cpa-plugins");
  const record = JSON.parse(fs.readFileSync(path.join(bundleRoot, "BUNDLE.json"))).antigravityFilter;
  assert.equal(record.id, id);
  assert.equal(record.source.commit, "bed909ef1ed9a73543324113de67f49312572058");
  const asset = record.platforms["win32/x64"];
  const bytes = fs.readFileSync(path.join(bundleRoot, asset.path));
  assert.equal(bytes.length, asset.size);
  assert.equal(bytes.subarray(0, 2).toString(), "MZ");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
  assert.match(fs.readFileSync(path.join(root, "desktop-electron/vendor/cpa-plugins", id, "LICENSE"), "utf8"), /MIT License/);
  if (process.platform === "win32" && process.arch === "x64") {
    const installed = installBundledCommandCodePlugin(fixture(t)).find(file => path.basename(file) === path.basename(asset.path));
    assert.ok(installed);
    assert.equal(createHash("sha256").update(fs.readFileSync(installed)).digest("hex"), asset.sha256);
  }
});

test("CPA v8 registers the native DLL with rewrite configuration", {
  skip: !process.env.CPA_TEST_EXE, timeout: 25000,
}, async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-antigravity-native-"));
  let child, exited;
  t.after(async () => {
    if (child) { child.kill(); await exited; }
    fs.rmSync(state, { recursive: true, force: true });
  });
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const management = "fixture-management-".repeat(3);
  const config = parse(runtimeConfiguration(state, management, "fixture-proxy-".repeat(4)));
  config.port = port;
  config.plugins.configs = { [id]: config.plugins.configs[id] };
  const pluginDir = path.join(state, "plugins/windows/amd64");
  fs.mkdirSync(pluginDir, { recursive: true });
  const bundleRoot = path.join(root, "desktop-electron/vendor/bundled/cpa-plugins");
  const asset = JSON.parse(fs.readFileSync(path.join(bundleRoot, "BUNDLE.json"))).antigravityFilter.platforms["win32/x64"];
  fs.copyFileSync(path.join(bundleRoot, asset.path), path.join(pluginDir, path.basename(asset.path)));
  const configPath = path.join(state, "config.yaml");
  fs.writeFileSync(configPath, stringify(config));
  child = spawn(process.env.CPA_TEST_EXE, ["--config", configPath], { cwd: state, windowsHide: true, stdio: "pipe" });
  exited = once(child, "exit");
  let logs = "";
  child.stdout.on("data", value => { logs = (logs + value).slice(-4000); });
  child.stderr.on("data", value => { logs = (logs + value).slice(-4000); });
  let response;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) assert.fail(`CPA exited: ${logs}`);
    try {
      response = await fetch(`http://127.0.0.1:${port}/v0/management/plugins`, {
        headers: { Authorization: `Bearer ${management}` }, signal: AbortSignal.timeout(400),
      });
      if (response.ok) break;
    } catch { /* loopback startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(response?.ok, `CPA did not become ready: ${logs}`);
  const payload = await response.json();
  const plugins = Array.isArray(payload) ? payload : payload.plugins;
  assert.ok(Array.isArray(plugins), JSON.stringify(payload));
  const plugin = plugins.find(value => value.id === id);
  assert.ok(plugin, JSON.stringify(payload));
  assert.equal(plugin.registered, true, JSON.stringify(plugin));
  assert.equal(plugin.effective_enabled, true, JSON.stringify(plugin));
});
