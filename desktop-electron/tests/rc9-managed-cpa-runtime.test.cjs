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

test("CPA is the fifth app-managed component and external service", () => {
  const managed = read("desktop-electron/electron/managed-components.cjs");
  const external = read("desktop-electron/electron/external-services.cjs");
  const combined = read("desktop-electron/electron/managed-external-services.cjs");
  const types = read("desktop-electron/src/types.ts");
  const surface = read("desktop-electron/src/features/ExternalServicesSurface.tsx");

  assert.match(managed, /COMPONENT_IDS[\s\S]*["']cpa["']/);
  assert.match(external, /SERVICE_IDS[\s\S]*["']cpa["']/);
  assert.match(combined, /cpa:\s*Object\.freeze\(\{\s*endpoint:\s*["']http:\/\/127\.0\.0\.1:8317\/["']/);
  assert.match(types, /ExternalServiceId\s*=\s*[\s\S]*["']cpa["']/);
  assert.match(surface, /cpa:\s*\[["']CPA \/ CLIProxyAPI["']/);
  assert.match(surface, /Activate bundled CPA \/ CLIProxyAPI and Codex Router/);
});

test("CPA uses checksum-pinned official v7.3.7 binaries on every supported desktop platform", () => {
  const manifestPath = requireFile("desktop-electron/vendor/managed-components/cpa.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assert.equal(manifest.id, "cpa");
  assert.equal(manifest.name, "CPA / CLIProxyAPI");
  assert.equal(manifest.repository, "router-for-me/CLIProxyAPI");
  assert.equal(manifest.version, "7.3.7");
  assert.equal(manifest.strategy, "release-binary");
  assert.equal(manifest.loopbackOnly, true);
  assert.equal(manifest.health.endpoint, "http://127.0.0.1:8317/v1/models");
  assert.equal(manifest.health.authorization, "Bearer {secret:proxyApiKey}");

  const expected = {
    win32: {
      x64: ["CLIProxyAPI_7.3.7_windows_amd64.zip", "da5466b81beb7c769b99e26a5f6f41d9999a07be7c36be170167f10a2a6ecfc7"],
      arm64: ["CLIProxyAPI_7.3.7_windows_aarch64.zip", "e940427e0e09afe9b92b5902dc357a96581cd03bd820aaea72566b5844b493ea"],
    },
    linux: {
      x64: ["CLIProxyAPI_7.3.7_linux_amd64.tar.gz", "3391dff672abccffce5f9259b7ce1e12cee7b0a8aa3f5b2280406484f59f37ba"],
      arm64: ["CLIProxyAPI_7.3.7_linux_aarch64.tar.gz", "442aad130260cc22a75d2b230826e0b2185e92baf5ef8ae57b849ae694dddf2a"],
    },
    darwin: {
      x64: ["CLIProxyAPI_7.3.7_darwin_amd64.tar.gz", "7b20a8988afe1dff0a5f3cd3d7fd30300576d630506d747e74ce25dfc46bb2af"],
      arm64: ["CLIProxyAPI_7.3.7_darwin_aarch64.tar.gz", "15269902173e99b834b8577a520ddf8f89fbb4a224afd2230384c1890b06875f"],
    },
  };

  for (const [platform, architectures] of Object.entries(expected)) {
    for (const [architecture, [fileName, sha256]] of Object.entries(architectures)) {
      const asset = manifest.platforms?.[platform]?.[architecture];
      assert.equal(asset?.fileName, fileName, `${platform}/${architecture} filename`);
      assert.equal(asset?.sha256, sha256, `${platform}/${architecture} SHA-256`);
      assert.equal(
        asset?.url,
        `https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.3.7/${fileName}`,
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

test("packaging keeps the CPA adapter executable outside app.asar", () => {
  const manifest = JSON.parse(read("desktop-electron/package.json"));
  assert.ok(manifest.build.asarUnpack.includes("electron/cpa-managed.cjs"));
  assert.ok(manifest.build.asarUnpack.includes("electron/codex-router-original-ui.cjs"));
  assert.ok(manifest.build.asarUnpack.includes("electron/cpa-codex-long-run.cjs"));
  assert.ok(manifest.build.asarUnpack.includes("electron/atomic-file.cjs"));
  assert.ok(manifest.build.asarUnpack.includes("electron/bundled-runtimes.cjs"));
  assert.ok(manifest.build.asarUnpack.includes("vendor/bundled-runtimes/**"));
});
