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
