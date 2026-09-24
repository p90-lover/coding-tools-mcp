"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const {
  REQUIRED_ASAR_FILES,
  REQUIRED_MODULE_FILES,
  REQUIRED_MODULE_SHIMS,
  REQUIRED_COMPONENTS,
  inspectExtractedApplication,
  findWindowsInstaller,
  forbiddenName,
  bundledRouterVendorPath,
  bundledRuntimeVendorPath,
  bundledUpstreamSourcePath,
} = require("../scripts/verify-package.cjs");

const PRODUCT_VERSION = "0.7.0-rc.13";
const SOURCE_SHA = "a".repeat(40);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function safeStamp(label) {
  return `${label}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function writeFile(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
}

function runtimeBundleId(files) {
  const digest = crypto.createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(String(file.size));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function createRuntime(resourcesRoot) {
  const runtimeRoot = path.join(resourcesRoot, "runtime");
  const entries = new Map([
    ["app/browser-helper.cjs", Buffer.from("module.exports = {};\n")],
    ["app/cli.js", Buffer.from("console.log('fixture runtime');\n")],
    ["bin/codex-chatgpt-web.cmd", Buffer.from("@echo off\r\n")],
    ["LICENSE", Buffer.from("MIT fixture license\n")],
    ["LICENSES/dependency.txt", Buffer.from("dependency license\n")],
    ["runtime/bun.exe", Buffer.from("MZfixture-bun-runtime")],
    ["THIRD_PARTY_NOTICES.txt", Buffer.from("codex-chatgpt-web MIT notices\n")],
  ]);
  for (const [relativePath, bytes] of entries) {
    writeFile(path.join(runtimeRoot, ...relativePath.split("/")), bytes);
  }
  const files = [...entries]
    .map(([relativePath, bytes]) => ({
      path: relativePath,
      size: bytes.length,
      sha256: sha256(bytes),
    }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  writeFile(path.join(runtimeRoot, "manifest.json"), `${JSON.stringify({
    schemaVersion: 2,
    appVersion: PRODUCT_VERSION,
    bundleId: runtimeBundleId(files),
    bunVersion: "1.4.0",
    platform: "win32",
    arch: "x64",
    launcher: "bin/codex-chatgpt-web.cmd",
    entrypoint: "app/cli.js",
    playwright: "1.58.2",
    files,
  }, null, 2)}\n`);
}

function createPackageFixture(label, mutate) {
  const appRoot = path.join(
    repositoryRoot,
    "aiTemp",
    "Trash",
    "package-verifier-tests",
    safeStamp(label),
    "app",
  );
  const resourcesRoot = path.join(appRoot, "resources");
  fs.mkdirSync(resourcesRoot, { recursive: true });
  writeFile(path.join(appRoot, "Coding Tools.exe"), Buffer.from("MZfixture-launcher"));
  createRuntime(resourcesRoot);

  const componentBytes = new Map([
    ["coding-tools/coding-tools-headless.exe", Buffer.from("MZfixture-rust-headless")],
    ["coding-tools/THIRD_PARTY_NOTICES.md", Buffer.from("Coding Tools, codex-chatgpt-web, MIT and Apache-2.0 notices\n")],
    ["migration/manifest.json", Buffer.from(`${JSON.stringify({
      schema: 1,
      sourceVersion: "0.4.10",
      targetVersion: PRODUCT_VERSION,
    }, null, 2)}\n`)],
    ["native/tunnel-client.exe", Buffer.from("MZfixture-tunnel-client-0.0.12")],
    ["rollback/manifest.json", Buffer.from(`${JSON.stringify({
      schema: 1,
      stableVersion: "0.4.10",
      mode: "reference",
      releaseTag: "v0.4.10",
      assetName: "Coding.Tools.MCP_0.4.10_x64-setup.exe",
      size: 6461938,
      sha256: "3c3f60262672556ae113a8cccbc671e7b559bb7106392333cd4a0628471427d1",
    }, null, 2)}\n`)],
  ]);
  for (const [relativePath, bytes] of componentBytes) {
    writeFile(path.join(resourcesRoot, ...relativePath.split("/")), bytes);
  }
  for (const relativePath of REQUIRED_MODULE_FILES) {
    writeFile(path.join(resourcesRoot, ...relativePath.split("/")), Buffer.from("module.exports = {};\n"));
    writeFile(
      path.join(resourcesRoot, ...relativePath.replace(/^app-handler\//, "app-modules/").split("/")),
      Buffer.from("module.exports = {};\n"),
    );
  }
  for (const relativePath of REQUIRED_MODULE_SHIMS) {
    writeFile(path.join(resourcesRoot, ...relativePath.split("/")), Buffer.from("module.exports = {};\n"));
  }

  const componentVersions = new Map([
    ["runtime-manifest", PRODUCT_VERSION],
    ["rust-headless", PRODUCT_VERSION],
    ["tunnel-client", "0.0.12"],
    ["third-party-notices", PRODUCT_VERSION],
    ["migration-manifest", PRODUCT_VERSION],
    ["rollback-manifest", "0.4.10"],
  ]);
  const components = Object.entries(REQUIRED_COMPONENTS)
    .map(([id, relativePath]) => {
      const absolutePath = path.join(resourcesRoot, ...relativePath.split("/"));
      const bytes = fs.readFileSync(absolutePath);
      return {
        id,
        path: relativePath,
        version: componentVersions.get(id),
        size: bytes.length,
        sha256: sha256(bytes),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  writeFile(path.join(resourcesRoot, "coding-tools", "package-manifest.json"), `${JSON.stringify({
    schema: 1,
    product: {
      name: "Coding Tools",
      version: PRODUCT_VERSION,
      app_id: "dev.codingtools.fullharness",
      platform: "win32",
      arch: "x64",
      installer: {
        kind: "nsis",
        scope: "current-user",
        allow_elevation: false,
      },
    },
    source: {
      repository: "p90-lover/coding-tools-mcp",
      sha: SOURCE_SHA,
    },
    upstream: {
      repository: "miuuyy/codex-chatgpt-web",
      version: "v5.0.6",
      commit: "e85e3693fdb4e3e033348c08df0298c20fcdb612",
    },
    components,
  }, null, 2)}\n`);

  if (mutate) mutate({ appRoot, resourcesRoot });
  return { appRoot, resourcesRoot };
}

function appManifest(overrides = {}) {
  return {
    name: "coding-tools-full-harness-desktop",
    version: PRODUCT_VERSION,
    build: {
      appId: "dev.codingtools.fullharness",
      productName: "Coding Tools",
      nsis: {
        perMachine: false,
        allowElevation: false,
      },
    },
    ...overrides,
  };
}

function packageOptions(overrides = {}) {
  return {
    appManifest: appManifest(),
    expectedSourceSha: SOURCE_SHA,
    asarEntries: [...REQUIRED_ASAR_FILES],
    ...overrides,
  };
}

test("accepts an exact package contract with verified runtime, sidecar, tunnel, migration, rollback, and notices", () => {
  const { appRoot } = createPackageFixture("complete");
  const result = inspectExtractedApplication(appRoot, packageOptions());
  assert.equal(result.ok, true);
  assert.equal(result.productVersion, PRODUCT_VERSION);
  assert.equal(result.sourceSha, SOURCE_SHA);
  assert.equal(result.runtime.bundleId.length, 64);
  assert.deepEqual(result.componentIds, Object.keys(REQUIRED_COMPONENTS).sort());
  assert.deepEqual(result.secretsFound, []);
});

test("rejects a packaged component changed after the package manifest was written", () => {
  const { appRoot } = createPackageFixture("tampered", ({ resourcesRoot }) => {
    fs.appendFileSync(
      path.join(resourcesRoot, "coding-tools", "coding-tools-headless.exe"),
      Buffer.from("tampered"),
    );
  });
  assert.throws(
    () => inspectExtractedApplication(appRoot, packageOptions()),
    /PACKAGE_COMPONENT_(?:SIZE|CHECKSUM)_MISMATCH/,
  );
});

test("rejects credential-like files and never reports their contents", () => {
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  const { appRoot } = createPackageFixture("secret", ({ resourcesRoot }) => {
    writeFile(path.join(resourcesRoot, "coding-tools", ".env.production"), `OPENAI_API_KEY=${secret}\n`);
  });
  assert.throws(
    () => inspectExtractedApplication(appRoot, packageOptions()),
    (error) => {
      assert.match(error.message, /PACKAGE_SECRET_MATERIAL_FOUND/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("allows bundled five-stack .env.example templates used for first-run setup", () => {
  assert.equal(forbiddenName("resources/bundled-components/anneal/.env.example"), null);
  assert.equal(forbiddenName("resources/five-stack-runtime/anneal/source/.env.example"), null);
  assert.equal(forbiddenName("resources/bundled-components/paseo/packages/server/.env.example"), null);
  assert.equal(forbiddenName("resources/coding-tools/.env"), "environment-file");
  assert.equal(forbiddenName("resources/coding-tools/.env.production"), "environment-file");
  const { appRoot } = createPackageFixture("env-example", ({ resourcesRoot }) => {
    writeFile(path.join(resourcesRoot, "bundled-components", "anneal", ".env.example"), "GITHUB_TOKEN=\n");
    writeFile(path.join(resourcesRoot, "bundled-components", "commandcode-proxy", ".env.example"), "PORT=9090\n");
    writeFile(path.join(resourcesRoot, "bundled-components", "paseo", "packages", "server", ".env.example"), "PASEO_LISTEN=127.0.0.1:6768\n");
    writeFile(path.join(resourcesRoot, "five-stack-runtime", "anneal", "source", ".env.example"), "GITHUB_TOKEN=\n");
  });
  const result = inspectExtractedApplication(appRoot, packageOptions());
  assert.equal(result.ok, true);
  assert.deepEqual(result.secretsFound, []);
});

test("rejects the retained Tauri identity masquerading as the Electron candidate", () => {
  const { appRoot } = createPackageFixture("identity");
  assert.throws(
    () => inspectExtractedApplication(appRoot, packageOptions({
      appManifest: appManifest({
        version: "0.4.10",
        build: {
          appId: "com.codingtools.mcp.desktop",
          productName: "Coding Tools MCP",
          nsis: { perMachine: true, allowElevation: true },
        },
      }),
    })),
    /PACKAGE_APP_IDENTITY_MISMATCH/,
  );
});

test("rejects an installer contract that permits elevation", () => {
  const { appRoot } = createPackageFixture("elevated-installer", ({ resourcesRoot }) => {
    const manifestPath = path.join(resourcesRoot, "coding-tools", "package-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.product.installer.allow_elevation = true;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  });
  assert.throws(
    () => inspectExtractedApplication(appRoot, packageOptions()),
    /PACKAGE_MANIFEST_IDENTITY_MISMATCH/,
  );
});

test("rejects a package that omits a required desktop ASAR module", () => {
  const { appRoot } = createPackageFixture("missing-required-asar");
  const requiredModule = "electron/runtime-supervisor.cjs";
  assert.ok(REQUIRED_ASAR_FILES.includes(requiredModule));
  assert.throws(
    () => inspectExtractedApplication(appRoot, packageOptions({
      asarEntries: REQUIRED_ASAR_FILES.filter((entry) => entry !== requiredModule),
    })),
    /PACKAGE_ASAR_REQUIRED_FILE_MISSING/,
  );
});

test("rejects a package that omits in-process module handlers next to app.asar", () => {
  const { appRoot } = createPackageFixture("missing-modules-host", ({ resourcesRoot }) => {
    fs.rmSync(path.join(resourcesRoot, "app-handler", "host.cjs"));
  });
  assert.ok(REQUIRED_MODULE_FILES.includes("app-handler/host.cjs"));
  assert.ok(REQUIRED_ASAR_FILES.includes("app-handler/host.cjs"));
  assert.throws(
    () => inspectExtractedApplication(appRoot, packageOptions()),
    /PACKAGE_MODULES_HOST/,
  );
});

test("rejects a package that omits the modules host shim next to app.asar", () => {
  const { appRoot } = createPackageFixture("missing-modules-shim", ({ resourcesRoot }) => {
    fs.rmSync(path.join(resourcesRoot, "modules", "host.cjs"));
  });
  assert.ok(REQUIRED_MODULE_SHIMS.includes("modules/host.cjs"));
  assert.throws(
    () => inspectExtractedApplication(appRoot, packageOptions()),
    /PACKAGE_MODULES_SHIM/,
  );
});

test("rejects a rollback reference whose checksum does not match the published v0.4.10 Windows asset", () => {
  const { appRoot } = createPackageFixture("rollback-checksum", ({ resourcesRoot }) => {
    const rollbackPath = path.join(resourcesRoot, "rollback", "manifest.json");
    const rollback = JSON.parse(fs.readFileSync(rollbackPath, "utf8"));
    rollback.sha256 = "c".repeat(64);
    const rollbackBytes = Buffer.from(`${JSON.stringify(rollback, null, 2)}\n`);
    fs.writeFileSync(rollbackPath, rollbackBytes);

    const packageManifestPath = path.join(resourcesRoot, "coding-tools", "package-manifest.json");
    const packageManifest = JSON.parse(fs.readFileSync(packageManifestPath, "utf8"));
    const component = packageManifest.components.find((entry) => entry.id === "rollback-manifest");
    component.size = rollbackBytes.length;
    component.sha256 = sha256(rollbackBytes);
    fs.writeFileSync(packageManifestPath, `${JSON.stringify(packageManifest, null, 2)}\n`);
  });
  assert.throws(
    () => inspectExtractedApplication(appRoot, packageOptions()),
    /PACKAGE_ROLLBACK_REFERENCE_INVALID/,
  );
});

test("requires exactly one versioned Windows x64 installer", () => {
  const root = path.join(
    repositoryRoot,
    "aiTemp",
    "Trash",
    "package-verifier-tests",
    safeStamp("installers"),
  );
  fs.mkdirSync(root, { recursive: true });
  const builderInstaller = `Coding.Tools_${PRODUCT_VERSION}_win_x64.exe`;
  const releaseInstaller = `Coding.Tools_${PRODUCT_VERSION}_windows_x64_setup.exe`;
  writeFile(path.join(root, builderInstaller), Buffer.from("MZone"));
  assert.equal(path.basename(findWindowsInstaller(root)), builderInstaller);
  writeFile(path.join(root, releaseInstaller), Buffer.from("MZtwo"));
  assert.throws(() => findWindowsInstaller(root), /PACKAGE_INSTALLER_COUNT_MISMATCH/);
});

test("bundled five-stack and Codex Router vendor trees do not trip the package secret scanner", () => {
  assert.equal(
    bundledRouterVendorPath("resources/bundled-runtimes/codex-router/source/.venv/Lib/site-packages/certifi/cacert.pem"),
    true,
  );
  assert.equal(
    bundledRuntimeVendorPath("resources/five-stack-runtime/codex-router/source/apps/control-center/node_modules/dotenv/README.md"),
    true,
  );
  assert.equal(
    bundledRuntimeVendorPath("resources/five-stack-runtime/codex-router/source/src/foreground-start.mjs"),
    false,
  );
  assert.equal(
    bundledUpstreamSourcePath("resources/five-stack-runtime/codex-router/source/test/routing.test.mjs"),
    true,
  );
  assert.equal(
    bundledUpstreamSourcePath("vendor/bundled/commandcode-proxy/.env.example"),
    true,
  );
  const fakeKey = "-----BEGIN PRIVATE KEY-----" + "A".repeat(80) + "-----END PRIVATE KEY-----";
  const { appRoot } = createPackageFixture("bundled-runtime-vendor", ({ resourcesRoot }) => {
    writeFile(
      path.join(resourcesRoot, "bundled-runtimes/codex-router/source/.venv/Lib/site-packages/certifi/cacert.pem"),
      "fixture-ca\n",
    );
    writeFile(
      path.join(resourcesRoot, "five-stack-runtime/codex-router/source/apps/control-center/node_modules/dotenv/README.md"),
      `${fakeKey}\n`,
    );
    writeFile(
      path.join(resourcesRoot, "five-stack-runtime/paseo/source/node_modules/example/index.js"),
      "const token = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';\n",
    );
    writeFile(
      path.join(resourcesRoot, "five-stack-runtime/codex-router/source/test/routing.test.mjs"),
      "const token = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';\n",
    );
    writeFile(
      path.join(resourcesRoot, "five-stack-runtime/codex-router/source/scripts/verify-grok-service-tier.mjs"),
      "const token = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';\n",
    );
  });
  const result = inspectExtractedApplication(appRoot, packageOptions());
  assert.equal(result.ok, true);
  assert.deepEqual(result.secretsFound, []);
});

test("live .env files still fail the package secret scanner after example templates are allowed", () => {
  const { appRoot } = createPackageFixture("live-env", ({ resourcesRoot }) => {
    writeFile(path.join(resourcesRoot, "bundled-components/anneal/.env"), "GITHUB_READ_TOKEN=secret\n");
  });
  assert.throws(
    () => inspectExtractedApplication(appRoot, packageOptions()),
    /PACKAGE_SECRET_MATERIAL_FOUND/,
  );
});
