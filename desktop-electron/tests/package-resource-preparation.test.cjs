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

const PRODUCT_VERSION = "0.7.0-rc.4";
const SOURCE_SHA = "a".repeat(40);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, source] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + bytes.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}


function cloudflaredManifest(platform = "windows/amd64") {
  return `${JSON.stringify({
    version: "2026.7.2",
    release_url: "https://github.com/cloudflare/cloudflared/releases/tag/2026.7.2",
    release_commit: "8679787525edc8575b2948a7c4a50b6292c6d426",
    platforms: [platform],
  })}\n`;
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
  const tunnelArchive = path.join(inputs, "tunnel-client-v0.0.12-windows-amd64.zip");
  const noticesPath = path.join(root, "third_party", "THIRD_PARTY_NOTICES.md");
  const licenseName = "tunnel-client-v0.0.12-windows-amd64-licenses.txt";
  const spdxName = "tunnel-client-v0.0.12-windows-amd64.spdx.json";
  const tunnelBytes = Buffer.from("MZfixture-tunnel-client-0.0.12");
  const archiveBytes = storedZip([
    ["tunnel-client.exe", tunnelBytes],
    ["cloudflared.exe", "MZfixture-cloudflared"],
    ["cloudflared-manifest.json", cloudflaredManifest()],
    ["LICENSE", "Apache License\nVersion 2.0, January 2004\n"],
    ["NOTICE", "OpenAI tunnel-client\n"],
    [licenseName, "tunnel-client dependency licenses include Apache-2.0 components.\n"],
    [spdxName, "{\"spdxVersion\":\"SPDX-2.3\"}\n"],
  ]);

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
  writeFile(path.join(runtimeRoot, "LICENSE"), "MIT License\n");
  writeFile(path.join(runtimeRoot, "LICENSES", "fixture.txt"), "Apache-2.0\n");
  writeFile(path.join(runtimeRoot, "app", "cli.js"), "console.log('fixture runtime');\n");
  writeFile(headlessBinary, Buffer.from("MZfixture-headless"));
  writeFile(tunnelArchive, archiveBytes);
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
    tunnelArchive,
    tunnelRelease: {
      repository: "openai/tunnel-client",
      version: "v0.0.12",
      platform: "windows",
      arch: "amd64",
      archiveName: path.basename(tunnelArchive),
      archiveSha256: sha256(archiveBytes),
      binaryName: "tunnel-client.exe",
      licenseName,
      spdxName,
    },
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

test("composes the exact Windows payload from the official seven-member client archive and preserves prior resources", () => {
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
  const expectedNativeMembers = new Map([
    ["LICENSE", Buffer.from("Apache License\nVersion 2.0, January 2004\n")],
    ["NOTICE", Buffer.from("OpenAI tunnel-client\n")],
    ["cloudflared-manifest.json", Buffer.from(cloudflaredManifest())],
    ["cloudflared.exe", Buffer.from("MZfixture-cloudflared")],
    [options.tunnelRelease.licenseName, Buffer.from("tunnel-client dependency licenses include Apache-2.0 components.\n")],
    [options.tunnelRelease.spdxName, Buffer.from("{\"spdxVersion\":\"SPDX-2.3\"}\n")],
    ["tunnel-client.exe", Buffer.from("MZfixture-tunnel-client-0.0.12")],
  ]);
  assert.deepEqual(
    manifest.supply_chain.tunnel_client.archive.members,
    [...expectedNativeMembers]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha256(bytes) })),
  );
  for (const [name, bytes] of expectedNativeMembers) {
    assert.deepEqual(fs.readFileSync(path.join(options.outputRoot, "native", name)), bytes, name);
  }
  assert.deepEqual(manifest.supply_chain.tunnel_client.cloudflared, {
    binaryName: "cloudflared.exe",
    binarySha256: sha256(Buffer.from("MZfixture-cloudflared")),
    manifestSha256: sha256(Buffer.from(cloudflaredManifest())),
    version: "2026.7.2",
    releaseCommit: "8679787525edc8575b2948a7c4a50b6292c6d426",
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
  for (const marker of ["codex-chatgpt-web", "MIT", "Apache-2.0", "OpenAI tunnel-client"]) {
    assert.match(notices, new RegExp(marker));
  }
  assert.equal(fs.readFileSync(path.join(options.outputRoot, "coding-tools", "coding-tools-headless.exe")).subarray(0, 2).toString("ascii"), "MZ");
  assert.equal(fs.readFileSync(path.join(options.outputRoot, "native", "tunnel-client.exe")).subarray(0, 2).toString("ascii"), "MZ");
});

test("rejects a tunnel archive digest mismatch before replacing prior output", () => {
  const options = createFixture("tunnel-digest");
  writeFile(path.join(options.outputRoot, "old-resource.txt"), "still active\n");
  options.tunnelRelease = { ...options.tunnelRelease, archiveSha256: "0".repeat(64) };

  assert.throws(
    () => preparePackageResources(options),
    /PACKAGE_RESOURCE_TUNNEL_ARCHIVE_DIGEST_MISMATCH/,
  );
  assert.equal(fs.readFileSync(path.join(options.outputRoot, "old-resource.txt"), "utf8"), "still active\n");
});

test("rejects any unexpected member in the tunnel archive before replacing prior output", () => {
  const options = createFixture("tunnel-inventory");
  writeFile(path.join(options.outputRoot, "old-resource.txt"), "still active\n");
  const archiveBytes = storedZip([
    ["tunnel-client.exe", "MZfixture-tunnel-client-0.0.12"],
    ["cloudflared.exe", "MZfixture-cloudflared"],
    ["cloudflared-manifest.json", cloudflaredManifest()],
    ["LICENSE", "Apache License\nVersion 2.0, January 2004\n"],
    ["NOTICE", "OpenAI tunnel-client\n"],
    [options.tunnelRelease.licenseName, "Apache-2.0\n"],
    [options.tunnelRelease.spdxName, "{\"spdxVersion\":\"SPDX-2.3\"}\n"],
    ["unexpected.dll", "not allowed\n"],
  ]);
  writeFile(options.tunnelArchive, archiveBytes);
  options.tunnelRelease = { ...options.tunnelRelease, archiveSha256: sha256(archiveBytes) };

  assert.throws(
    () => preparePackageResources(options),
    /PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVENTORY_MISMATCH/,
  );
  assert.equal(fs.readFileSync(path.join(options.outputRoot, "old-resource.txt"), "utf8"), "still active\n");
});

test("rejects a client archive missing the pinned cloudflared manifest before replacing prior output", () => {
  const options = createFixture("tunnel-missing-cloudflared-manifest");
  writeFile(path.join(options.outputRoot, "old-resource.txt"), "still active\n");
  const archiveBytes = storedZip([
    ["tunnel-client.exe", "MZfixture-tunnel-client-0.0.12"],
    ["cloudflared.exe", "MZfixture-cloudflared"],
    ["LICENSE", "Apache License\nVersion 2.0, January 2004\n"],
    ["NOTICE", "OpenAI tunnel-client\n"],
    [options.tunnelRelease.licenseName, "Apache-2.0\n"],
    [options.tunnelRelease.spdxName, "{\"spdxVersion\":\"SPDX-2.3\"}\n"],
  ]);
  writeFile(options.tunnelArchive, archiveBytes);
  options.tunnelRelease = { ...options.tunnelRelease, archiveSha256: sha256(archiveBytes) };

  assert.throws(
    () => preparePackageResources(options),
    /PACKAGE_RESOURCE_TUNNEL_ARCHIVE_INVENTORY_MISMATCH/,
  );
  assert.equal(fs.readFileSync(path.join(options.outputRoot, "old-resource.txt"), "utf8"), "still active\n");
});

test("rejects a client archive with a forged cloudflared identity before replacing prior output", () => {
  const options = createFixture("tunnel-cloudflared-identity");
  writeFile(path.join(options.outputRoot, "old-resource.txt"), "still active\n");
  const forgedManifest = JSON.stringify({
    version: "2026.6.0",
    release_url: "https://github.com/cloudflare/cloudflared/releases/tag/2026.6.0",
    release_commit: "0".repeat(40),
    platforms: ["windows/amd64"],
  }, null, 2) + "\n";
  const archiveBytes = storedZip([
    ["tunnel-client.exe", "MZfixture-tunnel-client-0.0.12"],
    ["cloudflared.exe", "MZfixture-cloudflared"],
    ["cloudflared-manifest.json", forgedManifest],
    ["LICENSE", "Apache License\nVersion 2.0, January 2004\n"],
    ["NOTICE", "OpenAI tunnel-client\n"],
    [options.tunnelRelease.licenseName, "Apache-2.0\n"],
    [options.tunnelRelease.spdxName, "{\"spdxVersion\":\"SPDX-2.3\"}\n"],
  ]);
  writeFile(options.tunnelArchive, archiveBytes);
  options.tunnelRelease = { ...options.tunnelRelease, archiveSha256: sha256(archiveBytes) };

  assert.throws(
    () => preparePackageResources(options),
    /PACKAGE_RESOURCE_CLOUDFLARED_IDENTITY_MISMATCH/,
  );
  assert.equal(fs.readFileSync(path.join(options.outputRoot, "old-resource.txt"), "utf8"), "still active\n");
});

test("fails closed on a non-Windows headless binary before replacing prior output", () => {
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
  assert.match(composer, /2a2804933924e38a502d62b61f0266cb80d56d65744f4c29876b2bf9c1544356/);
  assert.match(composer, /7d85227df86c38a689fca913d6f4a0b49ad030d6e056155a6832312cf7fb4bad/);
  assert.match(composer, /cloudflared-manifest\.json/);
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
