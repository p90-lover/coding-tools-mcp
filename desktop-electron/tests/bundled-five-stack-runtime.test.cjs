"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { prepareFiveStackRuntime } = require("../scripts/prepare-five-stack-runtime.cjs");

const desktopRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(desktopRoot, relativePath), "utf8");

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function bundledManifest(id, extra = {}) {
  return {
    schemaVersion: 1,
    id,
    name: id,
    managedBy: "Coding Tools",
    loopbackOnly: true,
    repository: `fixture/${id}`,
    repositoryUrl: `https://github.com/fixture/${id}.git`,
    commit: "b".repeat(40),
    version: "1.0.0",
    strategy: extra.strategy || "bundled-source",
    install: { steps: [{ id: "activate", kind: "activate" }] },
    launch: {
      processes: [{ id: "service", mode: "foreground", executable: "node", arguments: [] }],
    },
    health: { endpoint: "http://127.0.0.1:9090/", acceptStatus: [200] },
    ...extra,
  };
}

test("Desktop panels never tell the user to download or install a separate app", () => {
  const surface = read("src/features/ExternalServicesSurface.tsx");
  const original = read("src/features/OriginalUiSurface.tsx");
  const originalUi = read("electron/original-ui.cjs");

  assert.match(surface, /Start all/);
  assert.match(surface, /Prepare bundled runtime|Repair runtime/);
  assert.doesNotMatch(surface, /Install and start all/);
  assert.doesNotMatch(surface, /Install \/ Repair/);
  assert.doesNotMatch(surface, /download a separate app/i);
  assert.doesNotMatch(surface, /must download/i);
  assert.doesNotMatch(original, /Install \/ start original runtime/);
  assert.doesNotMatch(original, /Install and start the managed runtime/);
  assert.match(original, /Start original UI/);
  assert.match(original, /Start the bundled runtime/);
  assert.doesNotMatch(originalUi, /Install the pinned Codex Router source/);
  assert.doesNotMatch(originalUi, /Install and start managed CPA/);
});

test("prepare-five-stack-runtime materializes pinned sources and CPA archives from a local cache", async () => {
  const repositoryRoot = temporaryDirectory("coding-tools-five-stack-repo");
  const desktopDir = path.join(repositoryRoot, "desktop-electron");
  const manifestRoot = path.join(desktopDir, "vendor", "managed-components");
  const cacheRoot = path.join(repositoryRoot, "cache");
  const outputRoot = path.join(desktopDir, "build", "five-stack-runtime");
  const payload = Buffer.from("bundled-cpa-archive", "utf8");
  const digest = sha256(payload);

  for (const id of ["codex-router", "commandcode-proxy", "paseo", "anneal"]) {
    writeJson(path.join(manifestRoot, `${id}.json`), bundledManifest(id));
    const source = path.join(cacheRoot, id, "source");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, `${id}.txt`), `${id} bundled\n`);
  }
  writeJson(path.join(manifestRoot, "cpa.json"), bundledManifest("cpa", {
    strategy: "release-binary",
    commit: undefined,
    platforms: {
      [process.platform]: {
        [process.arch]: {
          url: "https://github.com/fixture/cpa/releases/download/v1.0.0/cpa.bin",
          sha256: digest,
          fileName: "cpa.bin",
        },
      },
    },
  }));
  fs.mkdirSync(path.join(cacheRoot, "cpa"), { recursive: true });
  fs.writeFileSync(path.join(cacheRoot, "cpa", "cpa.bin"), payload);

  let fetched = 0;
  const result = await prepareFiveStackRuntime({
    repositoryRoot,
    desktopRoot: desktopDir,
    manifestRoot,
    outputRoot,
    cacheRoot,
    fetchImpl: async () => {
      fetched += 1;
      throw new Error("prepare-five-stack-runtime must not fetch when a cache is present");
    },
    spawnSyncProcess: () => {
      throw new Error("prepare-five-stack-runtime must not git clone when a cache is present");
    },
    now: () => "2026-09-18T12:00:00.000Z",
    nonce: () => "fixture",
  });

  assert.equal(fetched, 0);
  assert.equal(result.outputRoot, outputRoot);
  assert.equal(fs.readFileSync(path.join(outputRoot, "commandcode-proxy", "source", "commandcode-proxy.txt"), "utf8"), "commandcode-proxy bundled\n");
  assert.deepEqual(fs.readFileSync(path.join(outputRoot, "cpa", "cpa.bin")), payload);
  const manifest = JSON.parse(fs.readFileSync(path.join(outputRoot, "MANIFEST.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.productVersion, "0.7.0-rc.11");
  assert.deepEqual(manifest.components.map((component) => component.id), [
    "codex-router",
    "commandcode-proxy",
    "cpa",
    "paseo",
    "anneal",
  ]);
});
