"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const { validateTunnelSupplyChain } = require("../scripts/verify-package.cjs");

const ARCHIVE_NAME = "tunnel-client-v0.0.12-windows-amd64.zip";
const LICENSE_NAME = "tunnel-client-v0.0.12-windows-amd64-licenses.txt";
const SPDX_NAME = "tunnel-client-v0.0.12-windows-amd64.spdx.json";
const CLOUDFLARED_VERSION = "2026.7.2";
const CLOUDFLARED_RELEASE_COMMIT = "8679787525edc8575b2948a7c4a50b6292c6d426";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function stamp(label) {
  return `${label}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function memberBytes() {
  return new Map([
    ["LICENSE", Buffer.from("Apache-2.0 fixture license\n")],
    ["NOTICE", Buffer.from("OpenAI tunnel-client fixture notice\n")],
    ["cloudflared-manifest.json", Buffer.from(`${JSON.stringify({
      version: CLOUDFLARED_VERSION,
      release_commit: CLOUDFLARED_RELEASE_COMMIT,
      platforms: ["windows/amd64"],
    }, null, 2)}\n`)],
    ["cloudflared.exe", Buffer.from("MZfixture-cloudflared")],
    [LICENSE_NAME, Buffer.from("fixture dependency license report\n")],
    [SPDX_NAME, Buffer.from(`${JSON.stringify({ spdxVersion: "SPDX-2.3" }, null, 2)}\n`)],
    ["tunnel-client.exe", Buffer.from("MZfixture-tunnel-client")],
  ]);
}

function createFixture(label) {
  const resourcesRoot = path.join(
    repositoryRoot,
    "aiTemp",
    "Trash",
    "tunnel-supply-chain-verifier-tests",
    stamp(label),
    "resources",
  );
  const nativeRoot = path.join(resourcesRoot, "native");
  fs.mkdirSync(nativeRoot, { recursive: true });
  const members = memberBytes();
  for (const [name, bytes] of members) fs.writeFileSync(path.join(nativeRoot, name), bytes);

  const archiveMembers = [...members]
    .map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha256(bytes) }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const expectedRelease = {
    repository: "openai/tunnel-client",
    version: "v0.0.12",
    platform: "windows/amd64",
    archiveName: ARCHIVE_NAME,
    archiveSha256: "a".repeat(64),
    licenseName: LICENSE_NAME,
    licenseSha256: sha256(members.get(LICENSE_NAME)),
    spdxName: SPDX_NAME,
    spdxSha256: sha256(members.get(SPDX_NAME)),
    cloudflaredBinaryName: "cloudflared.exe",
    cloudflaredVersion: CLOUDFLARED_VERSION,
    cloudflaredReleaseCommit: CLOUDFLARED_RELEASE_COMMIT,
  };
  const manifest = {
    supply_chain: {
      tunnel_client: {
        repository: expectedRelease.repository,
        version: expectedRelease.version,
        archive: {
          name: expectedRelease.archiveName,
          sha256: expectedRelease.archiveSha256,
          members: archiveMembers,
        },
        cloudflared: {
          binaryName: expectedRelease.cloudflaredBinaryName,
          binarySha256: sha256(members.get(expectedRelease.cloudflaredBinaryName)),
          manifestSha256: sha256(members.get("cloudflared-manifest.json")),
          version: expectedRelease.cloudflaredVersion,
          releaseCommit: expectedRelease.cloudflaredReleaseCommit,
        },
        license_report: {
          name: expectedRelease.licenseName,
          sha256: expectedRelease.licenseSha256,
        },
        spdx: {
          name: expectedRelease.spdxName,
          sha256: expectedRelease.spdxSha256,
        },
      },
    },
  };
  return { resourcesRoot, manifest, expectedRelease };
}

test("accepts exactly seven manifest-bound native tunnel support files", () => {
  const fixture = createFixture("complete");
  const result = validateTunnelSupplyChain(
    fixture.resourcesRoot,
    fixture.manifest,
    fixture.expectedRelease,
  );
  assert.equal(result.memberCount, 7);
  assert.equal(result.archiveName, ARCHIVE_NAME);
  assert.equal(result.cloudflaredVersion, CLOUDFLARED_VERSION);
});

test("rejects a native tunnel support file changed after the member records were written", () => {
  const fixture = createFixture("tampered");
  fs.appendFileSync(path.join(fixture.resourcesRoot, "native", "NOTICE"), "tampered");
  assert.throws(
    () => validateTunnelSupplyChain(
      fixture.resourcesRoot,
      fixture.manifest,
      fixture.expectedRelease,
    ),
    /PACKAGE_TUNNEL_MEMBER_(?:SIZE|CHECKSUM)_MISMATCH/,
  );
});

test("rejects an incomplete archive-member record inventory", () => {
  const fixture = createFixture("missing-member");
  fixture.manifest.supply_chain.tunnel_client.archive.members =
    fixture.manifest.supply_chain.tunnel_client.archive.members
      .filter((entry) => entry.name !== "NOTICE");
  assert.throws(
    () => validateTunnelSupplyChain(
      fixture.resourcesRoot,
      fixture.manifest,
      fixture.expectedRelease,
    ),
    /PACKAGE_TUNNEL_MEMBER_INVENTORY_MISMATCH/,
  );
});

test("rejects an unmanifested native support file", () => {
  const fixture = createFixture("unexpected-native");
  fs.writeFileSync(
    path.join(fixture.resourcesRoot, "native", "unexpected.dll"),
    Buffer.from("MZunexpected"),
  );
  assert.throws(
    () => validateTunnelSupplyChain(
      fixture.resourcesRoot,
      fixture.manifest,
      fixture.expectedRelease,
    ),
    /PACKAGE_TUNNEL_NATIVE_FILE_SET_MISMATCH/,
  );
});
