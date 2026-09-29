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
  assert.match(combined, /(?:["']cpa["']|\bcpa):\s*Object\.freeze\(\{\s*endpoint:\s*["']http:\/\/127\.0\.0\.1:8317\/["']/);
  assert.match(types, /ExternalServiceId\s*=\s*[\s\S]*["']cpa["']/);
  assert.match(surface, /cpa:\s*\[["']CPA \/ CLIProxyAPI["']/);
  assert.match(surface, /Start CPA \/ CLIProxyAPI/);
});

test("CPA uses checksum-pinned official v8.0.2 binaries on every supported desktop platform", () => {
  const manifestPath = requireFile("desktop-electron/vendor/managed-components/cpa.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assert.equal(manifest.id, "cpa");
  assert.equal(manifest.name, "CPA / CLIProxyAPI");
  assert.equal(manifest.repository, "router-for-me/CLIProxyAPI");
  assert.equal(manifest.version, "8.0.2");
  assert.equal(manifest.strategy, "release-binary");
  assert.equal(manifest.loopbackOnly, true);
  assert.equal(manifest.health.endpoint, "http://127.0.0.1:8317/v1/models");
  assert.equal(manifest.health.authorization, "Bearer {secret:proxyApiKey}");

  const expected = {
    win32: {
      x64: ["CLIProxyAPI_8.0.2_windows_amd64.zip", "75118e47d27d5446620a9e6b558ee54fa8377858c8c9b4cab7ba44b313aa10f2"],
      arm64: ["CLIProxyAPI_8.0.2_windows_aarch64.zip", "28818ee9a504a89a2b239e0f0a714d2d395538492a9c64fd5a010db1e960df6b"],
    },
    linux: {
      x64: ["CLIProxyAPI_8.0.2_linux_amd64.tar.gz", "7478ab50f5b59cb34911547b2b527275bd0bf64f52687588dcce65a386f244ad"],
      arm64: ["CLIProxyAPI_8.0.2_linux_aarch64.tar.gz", "e790af5d63b6bd803c4173ef0d7dc8aaf8e5d66f822d28551c45fd5112918065"],
    },
    darwin: {
      x64: ["CLIProxyAPI_8.0.2_darwin_amd64.tar.gz", "7f5d192bd92fd06d24c5e286b673e3fbd0b05fee69983729cdb20792b5a857a1"],
      arm64: ["CLIProxyAPI_8.0.2_darwin_aarch64.tar.gz", "305424f9a67e12b1e0e37f772c0f960f946f0e3c385226ab481a12e50f0621ae"],
    },
  };

  for (const [platform, architectures] of Object.entries(expected)) {
    for (const [architecture, [fileName, sha256]] of Object.entries(architectures)) {
      const asset = manifest.platforms?.[platform]?.[architecture];
      assert.equal(asset?.fileName, fileName, `${platform}/${architecture} filename`);
      assert.equal(asset?.sha256, sha256, `${platform}/${architecture} SHA-256`);
      assert.equal(
        asset?.url,
        `https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.2/${fileName}`,
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

  const workflow = read(".github/workflows/rc9-managed-cpa-runtime.yml");
  assert.match(workflow, /git diff --diff-filter=D/);
  assert.match(workflow, /rc9-managed-cpa-runtime\.test\.cjs/);
  assert.match(workflow, /cpa-oauth-adapter\.test\.cjs/);
  assert.match(workflow, /managed-components-runtime\.test\.cjs/);
});
