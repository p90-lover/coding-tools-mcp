"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const {
  preparePackageResources,
} = require("../scripts/prepare-package-resources.cjs");

const PRODUCT_VERSION = "0.6.0-rc.1";
const SOURCE_SHA = "a".repeat(40);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function writeFile(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
}

function fixtureRoot(label) {
  return path.join(
    repositoryRoot,
    "aiTemp",
    "Trash",
    "package-resource-preparation-tests",
    `${label}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  );
}

function createFixture(label, overrides = {}) {
  const root = fixtureRoot(label);
  const desktopRoot = path.join(root, "desktop-electron");
  const runtimeRoot = path.join(desktopRoot, "build", "runtime");
  const outputRoot = path.join(desktopRoot, "build", "package-resources");
  const inputs = path.join(root, "aiTemp", "input");
  const headlessBinary = path.join(inputs, "coding-tools-headless.exe");
  const tunnelBinary = path.join(inputs, "tunnel-client.exe");
  const noticesPath = path.join(root, "third_party", "THIRD_PARTY_NOTICES.md");

  writeFile(path.join(runtimeRoot, "manifest.json"), `${JSON.stringify({
    schemaVersion: 2,
    appVersion: PRODUCT_VERSION,
    platform: "win32",
    arch: "x64",
  }, null, 2)}\n`);
  writeFile(
    path.join(runtimeRoot, "THIRD_PARTY_NOTICES.txt"),
    "codex-chatgpt-web dependencies include MIT and Apache-2.0 components.\n",
  );
  writeFile(path.join(runtimeRoot, "app", "cli.js"), "console.log('fixture runtime');\n");
  writeFile(headlessBinary, Buffer.from("MZfixture-headless"));
  writeFile(tunnelBinary, Buffer.from("MZfixture-tunnel-client-0.0.12"));
  writeFile(noticesPath, [
    "# Third-party notices",
    "",
    "## codex-chatgpt-web",
    "",
    "Pinned at v5.0.6 under the MIT license.",
    "",
  ].join("\n"));

  return {
    repositoryRoot: root,
    desktopRoot,
    runtimeRoot,
    outputRoot,
    headlessBinary,
    tunnelBinary,
    noticesPath,
    sourceSha: SOURCE_SHA,
    platform: "win32",
    arch: "x64",
    now: () => new Date("2026-09-15T02:00:00.000Z"),
    nonce: () => "fixture",
    ...overrides,
  };
}

function componentBytes(outputRoot, component) {
  return fs.readFileSync(path.join(outputRoot, ...component.path.split("/")));
}

test("composes the exact Windows payload and preserves the prior resource directory", () => {
  const options = createFixture("complete");
  writeFile(path.join(options.outputRoot, "old-resource.txt"), "retain this prior output\n");

  const result = preparePackageResources(options);
  const manifestPath = path.join(options.outputRoot, "coding-tools", "package-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assert.equal(result.outputRoot, options.outputRoot);
  assert.ok(result.preservedPath);
  assert.equal(fs.readFileSync(path.join(result.preservedPath, "old-resource.txt"), "utf8"), "retain this prior output\n");
  assert.equal(fs.existsSync(path.join(options.outputRoot, "old-resource.txt")), false);
  assert.equal(
    path.relative(path.join(options.repositoryRoot, "aiTemp", "Trash"), result.preservedPath).startsWith(".."),
    false,
  );

  assert.deepEqual(manifest.product, {
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
  });
  assert.deepEqual(manifest.source, {
    repository: "p90-lover/coding-tools-mcp",
    sha: SOURCE_SHA,
  });
  assert.deepEqual(manifest.upstream, {
    repository: "miuuyy/codex-chatgpt-web",
    version: "v5.0.6",
    commit: "e85e3693fdb4e3e033348c08df0298c20fcdb612",
  });
  assert.deepEqual(
    manifest.components.map((component) => component.id),
    [
      "migration-manifest",
      "rollback-manifest",
      "runtime-manifest",
      "rust-headless",
      "third-party-notices",
      "tunnel-client",
    ],
  );
  for (const component of manifest.components) {
    const bytes = componentBytes(options.outputRoot, component);
    assert.equal(component.size, bytes.length, component.id);
    assert.equal(component.sha256, sha256(bytes), component.id);
  }

  const migration = JSON.parse(fs.readFileSync(path.join(options.outputRoot, "migration", "manifest.json"), "utf8"));
  assert.deepEqual(migration, {
    schema: 1,
    sourceVersion: "0.4.10",
    targetVersion: PRODUCT_VERSION,
  });
  const rollback = JSON.parse(fs.readFileSync(path.join(options.outputRoot, "rollback", "manifest.json"), "utf8"));
  assert.deepEqual(rollback, {
    schema: 1,
    stableVersion: "0.4.10",
    mode: "reference",
    releaseTag: "v0.4.10",
    assetName: "Coding.Tools.MCP_0.4.10_x64-setup.exe",
    size: 6461938,
    sha256: "3c3f60262672556ae113a8cccbc671e7b559bb7106392333cd4a0628471427d1",
  });
  const notices = fs.readFileSync(path.join(options.outputRoot, "coding-tools", "THIRD_PARTY_NOTICES.md"), "utf8");
  for (const marker of ["codex-chatgpt-web", "MIT", "Apache-2.0"]) assert.match(notices, new RegExp(marker));
  assert.equal(fs.readFileSync(path.join(options.outputRoot, "coding-tools", "coding-tools-headless.exe")).subarray(0, 2).toString("ascii"), "MZ");
  assert.equal(fs.readFileSync(path.join(options.outputRoot, "native", "tunnel-client.exe")).subarray(0, 2).toString("ascii"), "MZ");
});

test("fails closed on a non-Windows binary before replacing prior output", () => {
  const options = createFixture("invalid-binary");
  writeFile(path.join(options.outputRoot, "old-resource.txt"), "still active\n");
  writeFile(options.headlessBinary, Buffer.from("not-a-windows-executable"));

  assert.throws(
    () => preparePackageResources(options),
    /PACKAGE_RESOURCE_BINARY_FORMAT_MISMATCH.*coding-tools-headless/i,
  );
  assert.equal(fs.readFileSync(path.join(options.outputRoot, "old-resource.txt"), "utf8"), "still active\n");
});

test("rejects an invalid source identity before staging or preserving output", () => {
  const options = createFixture("invalid-source", { sourceSha: "not-a-commit" });
  writeFile(path.join(options.outputRoot, "old-resource.txt"), "still active\n");

  assert.throws(
    () => preparePackageResources(options),
    /PACKAGE_RESOURCE_SOURCE_SHA_INVALID/,
  );
  assert.equal(fs.readFileSync(path.join(options.outputRoot, "old-resource.txt"), "utf8"), "still active\n");
});

test("package and runtime preparation use repository aiTemp retention without destructive cleanup", () => {
  const composer = fs.readFileSync(path.join(repositoryRoot, "desktop-electron", "scripts", "prepare-package-resources.cjs"), "utf8");
  const runtimePreparation = fs.readFileSync(path.join(repositoryRoot, "desktop-electron", "scripts", "prepare-runtime.cjs"), "utf8");
  const runtimeBuilder = fs.readFileSync(path.join(repositoryRoot, "runtime-web", "scripts", "build-runtime-bundle.ts"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "desktop-electron", "package.json"), "utf8"));

  for (const [label, source] of [
    ["package composer", composer],
    ["runtime preparation", runtimePreparation],
    ["runtime builder", runtimeBuilder],
  ]) {
    assert.doesNotMatch(source, /\b(?:rmSync|unlinkSync)\s*\(/, `${label} must not delete files`);
    assert.doesNotMatch(source, /fs\.(?:rm|unlink)\s*\(/, `${label} must not delete files`);
    assert.doesNotMatch(source, /process\.exit\s*\(/, `${label} must unwind through retention`);
  }
  assert.match(composer, /aiTemp/);
  assert.match(composer, /Trash/);
  assert.match(runtimePreparation, /aiTemp/);
  assert.match(runtimePreparation, /Trash/);
  assert.equal(manifest.scripts["build:package-resources"], "node scripts/prepare-package-resources.cjs");
  for (const script of ["package", "package:mac", "package:win", "package:linux"]) {
    assert.match(manifest.scripts[script], /build:runtime/);
    assert.match(manifest.scripts[script], /build:package-resources/);
  }
  assert.deepEqual(manifest.build.extraResources, [
    {
      from: "build/package-resources",
      to: ".",
    },
  ]);
});
