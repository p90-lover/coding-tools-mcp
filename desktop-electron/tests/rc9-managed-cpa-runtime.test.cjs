"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");

function file(relativePath) {
  return path.join(repositoryRoot, relativePath);
}

function read(relativePath) {
  return fs.readFileSync(file(relativePath), "utf8");
}

function requireFile(relativePath) {
  const target = file(relativePath);
  assert.equal(fs.existsSync(target), true, `missing ${relativePath}`);
  return target;
}

test("managed CPA keeps saved user settings and extra plugin registrations while replacing owned bindings", () => {
  const { runtimeConfiguration } = require("../electron/cpa-managed.cjs");
  const yaml = globalThis.Bun?.YAML ?? require("js-yaml");
  const state = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "cpa-config-preserve-"));
  try {
    fs.writeFileSync(path.join(state, "config.yaml"), JSON.stringify({
      host: "0.0.0.0", port: 9999, "auth-dir": "/old/auth", "api-keys": ["old-key"],
      "proxy-url": "http://old.invalid", "remote-management": { "allow-remote": true, "secret-key": "old-secret" },
      "disable-cooling": true, "request-retry": 8, debug: true, "logging-to-file": true,
      "claude-api-key": [{ "api-key": "provider-fixture", "base-url": "https://provider.example" }],
      oauth: { "auth-dir": "/old/oauth", providers: { custom: { enabled: true } } },
      plugins: { enabled: false, dir: "/old/plugins", configs: {
        "cline-pass-switcher": { enabled: false, "data-dir": "/old/cline" },
        "codex-review-account-selector": { enabled: true, strategy: "saved-user-setting" },
      } },
    }));
    const output = runtimeConfiguration(state, "m".repeat(36), "p".repeat(36));
    const config = (yaml.parse ?? yaml.load)(output);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8317);
    assert.equal(config["auth-dir"], path.join(state, "auth"));
    assert.deepEqual(config["api-keys"], ["p".repeat(36)]);
    assert.equal(config["remote-management"]["allow-remote"], false);
    assert.equal(config["remote-management"]["secret-key"], "m".repeat(36));
    assert.equal(config["proxy-url"] ?? "", "", "a stale saved proxy cannot replace the managed route");
    assert.equal(config.plugins.enabled, true);
    assert.equal(config.plugins.dir, path.join(state, "plugins"));
    assert.equal(config.plugins.configs["cline-pass-switcher"].enabled, true);
    assert.equal(config.plugins.configs["cline-pass-switcher"]["data-dir"], path.join(state, "cline-pass-switcher-data"));
    assert.deepEqual(config.plugins.configs["codex-review-account-selector"], { enabled: true, strategy: "saved-user-setting" });
    assert.equal(config["disable-cooling"], true);
    assert.equal(config["request-retry"], 8);
    assert.equal(config.debug, true);
    assert.equal(config["logging-to-file"], false, "an older build's saved file logging is turned off");
    assert.equal(config["claude-api-key"][0]["api-key"], "provider-fixture");
    assert.equal(config.oauth["auth-dir"], path.join(state, "auth"));
    assert.equal(config.oauth.providers.custom.enabled, true);
  } finally { fs.rmSync(state, { recursive: true, force: true }); }
});

test("managed CPA writes no main.log and removes the ones an older build left", () => {
  const { runtimeConfiguration, removeOldMainLogs } = require("../electron/cpa-managed.cjs");
  const yaml = globalThis.Bun?.YAML ?? require("js-yaml");
  const state = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "cpa-config-logs-"));
  try {
    const config = (yaml.parse ?? yaml.load)(runtimeConfiguration(state, "m".repeat(36), "p".repeat(36)));
    assert.equal(config["logging-to-file"], false);
    assert.equal(config["request-log"], false);
    const logs = path.join(state, "logs");
    for (const name of ["main.log", "main-2026-10-18T02-24-10.083.log", "error-v1-chat-completions-2026-10-20T23-06-07.log"]) {
      fs.writeFileSync(path.join(logs, name), "x\n");
    }
    removeOldMainLogs(state);
    // A failed request's error log is kept: it is written only when one fails.
    assert.deepEqual(fs.readdirSync(logs), ["error-v1-chat-completions-2026-10-20T23-06-07.log"]);
    removeOldMainLogs(path.join(state, "missing"));
  } finally { fs.rmSync(state, { recursive: true, force: true }); }
});

test("invalid saved CPA YAML is refused without replacing it or exposing its source", () => {
  const { runtimeConfiguration } = require("../electron/cpa-managed.cjs");
  const state = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "cpa-config-invalid-"));
  try {
    const target = path.join(state, "config.yaml");
    for (const source of ["api-keys: [PRIVATE_FIXTURE_SECRET", "- item", "plugins:\n  configs: []", "oauth: []"]) {
      fs.writeFileSync(target, source);
      assert.throws(() => runtimeConfiguration(state, "m".repeat(36), "p".repeat(36)), error => {
        assert.equal(error.message, "Saved CPA configuration is invalid; it was not replaced");
        return true;
      });
      assert.equal(fs.readFileSync(target, "utf8"), source);
    }
  } finally { fs.rmSync(state, { recursive: true, force: true }); }
});

test("CPA is the fifth app-managed component and external service", () => {
  const managed = read("desktop-electron/electron/managed-components.cjs");
  const external = read("desktop-electron/electron/external-services.cjs");
  const combined = read("desktop-electron/electron/managed-external-services.cjs");
  const types = read("desktop-electron/src/types.ts");
  const surface = read("desktop-electron/src/features/ExternalServicesSurface.tsx");

  assert.match(managed, /COMPONENT_IDS[\s\S]*["']cpa["']/);
  assert.match(external, /SERVICE_IDS[\s\S]*["']cpa["']/);
  assert.match(combined, /(?:["']cpa["']|\bcpa):\s*Object\.freeze\(\{\s*endpoint:\s*["']http:\/\/127\.0\.0\.1:8317\/["']/);
  assert.match(types, /ExternalServiceId\s*=\s*[\s\S]*["']cpa["']/);
  assert.match(surface, /cpa:\s*\[["']CPA \/ CLIProxyAPI["']/);
  assert.match(surface, /Start CPA \/ CLIProxyAPI/);
});

test("CPA uses checksum-pinned official v8.0.32 binaries on every supported desktop platform", () => {
  const manifestPath = requireFile("desktop-electron/vendor/managed-components/cpa.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assert.equal(manifest.id, "cpa");
  assert.equal(manifest.name, "CPA / CLIProxyAPI");
  assert.equal(manifest.repository, "router-for-me/CLIProxyAPI");
  assert.equal(manifest.version, "8.0.32");
  assert.equal(manifest.strategy, "release-binary");
  assert.equal(manifest.loopbackOnly, true);
  assert.equal(manifest.health.endpoint, "http://127.0.0.1:8317/v1/models");
  assert.equal(manifest.health.authorization, "Bearer {secret:proxyApiKey}");

  const expected = {
    win32: {
      x64: ["CLIProxyAPI_8.0.32_windows_amd64.zip", "df364b1f2dc9fe357f6a481bfb8a4066c3e5f5ef4ad7abfe45e59b4cec547c18"],
      arm64: ["CLIProxyAPI_8.0.32_windows_aarch64.zip", "9e83b3f19f3359b52a1fe7acc763ed9285698a46d49caec650943d5b67e82010"],
    },
    linux: {
      x64: ["CLIProxyAPI_8.0.32_linux_amd64.tar.gz", "082a4a38d9470c070ac85ab2d9c4a2aa51f9a7ee19831c3b811e26fe5b7480a7"],
      arm64: ["CLIProxyAPI_8.0.32_linux_aarch64.tar.gz", "76aac452dd224490ea5ea1ea0224199d7a410f14ef39a087b81893d15c62f363"],
    },
    darwin: {
      x64: ["CLIProxyAPI_8.0.32_darwin_amd64.tar.gz", "c327f421d995692f6590a752abd449db5e71df61803b7041e4d3bd59cd1e1bd8"],
      arm64: ["CLIProxyAPI_8.0.32_darwin_aarch64.tar.gz", "48fe6a391a01e730ee6ebe3f1609ff92578a97a7a9a44579013ca8f3a6d58d51"],
    },
  };

  for (const [platform, architectures] of Object.entries(expected)) {
    for (const [architecture, [fileName, sha256]] of Object.entries(architectures)) {
      const asset = manifest.platforms?.[platform]?.[architecture];
      assert.equal(asset?.fileName, fileName, `${platform}/${architecture} filename`);
      assert.equal(asset?.sha256, sha256, `${platform}/${architecture} SHA-256`);
      assert.equal(
        asset?.url,
        `https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.32/${fileName}`,
        `${platform}/${architecture} URL`,
      );
    }
  }
});

test("the managed CPA adapter extracts safely and generates a private loopback-only runtime configuration", () => {
  const adapterPath = requireFile("desktop-electron/electron/cpa-managed.cjs");
  const source = fs.readFileSync(adapterPath, "utf8");

  assert.match(source, /command === ["']prepare["']/);
  assert.match(source, /command === ["']run["']/);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /remote-management:/);
  assert.match(source, /allow-remote: false/);
  assert.match(source, /disable-control-panel: false/);
  assert.match(source, /disable-auto-update-panel: true/);
  assert.match(source, /cpaLongRunYamlLines/);
  assert.match(read("desktop-electron/electron/cpa-codex-long-run.cjs"), /keepalive-seconds: 15/);
  assert.match(source, /CODING_TOOLS_CPA_MANAGEMENT_KEY/);
  assert.match(source, /CODING_TOOLS_CPA_PROXY_API_KEY/);
  assert.match(source, /--config/);
  assert.match(source, /--no-browser/);
  assert.match(source, /writePrivateFileAtomic/);
  assert.doesNotMatch(source, /\b(?:rm|rmdir|unlink|shred|Remove-Item|del)\b/iu);
});

test("CPA management credentials stay central and are not required on every provider account", () => {
  const bootstrap = read("desktop-electron/electron/provider-bootstrap.cjs");
  const providerNetwork = read("desktop-electron/electron/provider-network.cjs");
  const managedExternal = read("desktop-electron/electron/managed-external-services.cjs");
  const main = read("desktop-electron/electron/main.cjs");

  assert.match(bootstrap, /function setProviderCpaConnection\(/);
  assert.match(bootstrap, /getCpaConnection:/);
  assert.match(providerNetwork, /getCpaConnection/);
  assert.match(providerNetwork, /const managed = getCpaConnection\?\.\(\)/);
  assert.match(managedExternal, /function cpaConnection\(\)/);
  assert.match(managedExternal, /managementKey/);
  assert.match(managedExternal, /proxyApiKey/);
  assert.match(main, /setProviderCpaConnection\(\(\) => externalServicesController\?\.cpaConnection\(\)\)/);
});

test("a healthy managed CPA probe remains ready instead of being overwritten as starting", () => {
  const source = read("desktop-electron/electron/managed-external-services.cjs");
  assert.match(
    source,
    /status:\s*service\.status === "error"[\s\S]*?service\.status === "ready"[\s\S]*?"ready"[\s\S]*?:\s*"starting"/,
  );
});

test("packaging keeps the CPA adapter executable outside app.asar and preserves the no-delete contract", () => {
  const manifest = JSON.parse(read("desktop-electron/package.json"));
  assert.ok(manifest.build.asarUnpack.includes("electron/cpa-managed.cjs"));
  assert.ok(manifest.build.asarUnpack.includes("vendor/bundled/cpa-plugins/**"));
  assert.ok(manifest.build.asarUnpack.includes("electron/cpa-codex-long-run.cjs"));
  assert.ok(manifest.build.asarUnpack.includes("electron/atomic-file.cjs"));
  // The adapter runs from app.asar.unpacked, so every local module it requires must be unpacked too.
  for (const [, name] of read("desktop-electron/electron/cpa-managed.cjs").matchAll(/require\("\.\/([^"]+)"\)/g)) {
    assert.ok(manifest.build.asarUnpack.includes(`electron/${name}`), `electron/${name} is unpacked for the CPA adapter`);
  }

  const workflow = read(".github/workflows/rc9-managed-cpa-runtime.yml");
  assert.match(workflow, /git diff --diff-filter=D/);
  assert.match(workflow, /rc9-managed-cpa-runtime\.test\.cjs/);
  assert.match(workflow, /cpa-oauth-adapter\.test\.cjs/);
  assert.match(workflow, /managed-components-runtime\.test\.cjs/);
});
