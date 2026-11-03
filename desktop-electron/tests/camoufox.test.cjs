"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { createCamoufox, zipEntries, releaseAssetName } = require("../electron/camoufox.cjs");

const TAR = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
const windows = process.platform === "win32" && fs.existsSync(TAR);
const AI_TEMP = path.join(__dirname, "..", "..", "aiTemp");

function tempRoot(name) {
  fs.mkdirSync(AI_TEMP, { recursive: true });
  return fs.mkdtempSync(path.join(AI_TEMP, `${name}-`));
}

function writeTree(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, ...name.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
}

/** A release zip of `files`, made with Windows' bsdtar like the real one is read with. */
function makeZip(root, files) {
  const source = path.join(root, "zip-source");
  writeTree(source, files);
  const zip = path.join(root, "release.zip");
  const made = spawnSync(TAR, ["-a", "-cf", zip, "-C", source, ...Object.keys(files)], { windowsHide: true, encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  return zip;
}

test("a release's Windows x64 zip is named by its version", () => {
  assert.equal(releaseAssetName("158.0.1-beta.41"), "camoufox-158.0.1-beta.41-win.x86_64.zip");
});

test("the zip's central directory gives each file's size and CRC-32", { skip: !windows }, async () => {
  const root = tempRoot("camoufox-zip");
  const zip = makeZip(root, { "camoufox.exe": "exe", "fonts/a.ttf": "font a" });
  const entries = await zipEntries(zip);
  const font = entries.find((entry) => entry.name === "fonts/a.ttf");
  assert.equal(font.size, 6);
  assert.equal(font.crc32, require("node:zlib").crc32("font a"));
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ["camoufox.exe", "fonts/a.ttf"]);
});

test("an update links the fonts it already has, unpacks the rest and retires the old version", { skip: !windows }, async () => {
  const root = tempRoot("camoufox-update");
  const home = path.join(root, "tools", "camoufox");
  // The copy Camoufox's own installer made: { version, build } in version.json.
  writeTree(path.join(home, "1.0.0-beta.1"), {
    "camoufox.exe": "old exe", "version.json": JSON.stringify({ version: "1.0.0", build: "beta.1" }),
    "fonts/same.ttf": "unchanged font", "fonts/edited.ttf": "old",
  });
  const camoufox = createCamoufox({ root: home, logger: { info() {}, warn() {} } });
  assert.equal((await camoufox.status()).version, "1.0.0-beta.1");

  // Same size, other bytes: only the CRC tells "edited.ttf" apart.
  const zip = makeZip(root, { "camoufox.exe": "new exe", "fonts/same.ttf": "unchanged font", "fonts/edited.ttf": "new", "fonts/added.ttf": "added" });
  const status = await camoufox.install({ zip, version: "1.1.0-beta.2", sha256: "a".repeat(64) });

  assert.equal(status.version, "1.1.0-beta.2");
  const installed = path.join(home, "1.1.0-beta.2");
  assert.equal(fs.readFileSync(path.join(installed, "camoufox.exe"), "utf8"), "new exe");
  assert.equal(fs.readFileSync(path.join(installed, "fonts", "edited.ttf"), "utf8"), "new");
  assert.equal(fs.readFileSync(path.join(installed, "fonts", "added.ttf"), "utf8"), "added");
  // The unchanged font is the old file under a second name, not a second copy.
  assert.equal(fs.statSync(path.join(installed, "fonts", "same.ttf")).nlink, 2);
  assert.equal(fs.statSync(path.join(installed, "fonts", "edited.ttf")).nlink, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, "version.json"), "utf8"));
  assert.equal(manifest.version, "1.1.0-beta.2");
  assert.equal(manifest.fontsReusedFrom, "1.0.0-beta.1");

  // The old version is in Trash, not deleted; nothing but the new version is left in the folder.
  assert.deepEqual(fs.readdirSync(home), ["1.1.0-beta.2"]);
  const trash = fs.readdirSync(path.join(root, "tools", "Trash", "camoufox"));
  assert.equal(trash.length, 1);
  assert.match(trash[0], /^1\.0\.0-beta\.1-\d+$/);
});

test("an update that wouldn't fit on the drive stops before unpacking", { skip: !windows }, async () => {
  const root = tempRoot("camoufox-full");
  const home = path.join(root, "camoufox");
  const zip = makeZip(root, { "camoufox.exe": "exe" });
  const camoufox = createCamoufox({ root: home, logger: { info() {} }, free: async () => 1024 });
  await assert.rejects(camoufox.install({ zip, version: "2.0.0-beta.1", sha256: "b".repeat(64) }), /needs 0\.5 GB free on .*; 0\.0 GB is free/);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.equal((await camoufox.status()).installed, false);
});

test("a zip without camoufox.exe isn't installed", { skip: !windows }, async () => {
  const root = tempRoot("camoufox-bad");
  const home = path.join(root, "camoufox");
  const zip = makeZip(root, { "readme.txt": "not a browser" });
  const camoufox = createCamoufox({ root: home, logger: { info() {} } });
  await assert.rejects(camoufox.install({ zip, version: "2.0.0-beta.1", sha256: "c".repeat(64) }), /no camoufox\.exe/);
  assert.deepEqual(fs.readdirSync(home), []);
});
