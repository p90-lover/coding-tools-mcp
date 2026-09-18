"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const SHA = "a".repeat(40);
const upstream = {
  repository: "miuuyy/codex-chatgpt-web",
  tag: "v5.0.6",
  commit: "e85e3693fdb4e3e033348c08df0298c20fcdb612",
};

function packageManifest(nsis) {
  return {
    version: "0.7.0-rc.8",
    build: {
      appId: "dev.codingtools.fullharness",
      productName: "Coding Tools",
      nsis,
    },
  };
}

test("source scope accepts bounded assisted elevation only for the retained legacy-migration installer", async () => {
  process.env.RELEASE_VERSION = "0.7.0-rc.8";
  process.env.RELEASE_TAG = "v0.7.0-rc.8";
  const { auditSourceScope } = await import(
    `../../scripts/release/verify-source-scope.mjs?rc8-elevation=${Date.now()}`
  );

  const valid = auditSourceScope({
    tag: "v0.7.0-rc.8",
    sourceSha: SHA,
    currentSha: SHA,
    packageManifest: packageManifest({
      perMachine: false,
      oneClick: false,
      allowElevation: true,
      include: "build/installer.nsh",
      deleteAppDataOnUninstall: false,
    }),
    upstreamManifest: upstream,
  });
  assert.equal(valid.ok, true, JSON.stringify(valid.errors));
  assert.equal(valid.facts.assistedLegacyMigration, true);

  const unsafe = auditSourceScope({
    tag: "v0.7.0-rc.8",
    sourceSha: SHA,
    currentSha: SHA,
    packageManifest: packageManifest({
      perMachine: false,
      oneClick: false,
      allowElevation: true,
      deleteAppDataOnUninstall: false,
    }),
    upstreamManifest: upstream,
  });
  assert.equal(unsafe.ok, false);
  assert.ok(unsafe.errors.some((error) => error.code === "NSIS_ELEVATION_MISMATCH"));
});
