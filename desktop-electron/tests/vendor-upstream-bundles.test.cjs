"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  copyBundledTree,
} = require("../scripts/vendor-upstream-bundles.cjs");

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

test("copyBundledTree skips dangling gitlinks and materializes real file links", () => {
  const root = temporaryDirectory("coding-tools-bundled-gitlinks");
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  const docs = path.join(source, "docs");
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, "guide.md"), "# guide\n");
  fs.writeFileSync(path.join(source, "index.js"), "export default true;\n");
  fs.symlinkSync(path.join("docs", "guide.md"), path.join(source, "AGENTS.md"));
  fs.symlinkSync(path.join("docs", "missing.md"), path.join(source, "CLAUDE.md"));
  fs.mkdirSync(path.join(source, "fastlane", "images"), { recursive: true });
  fs.symlinkSync(path.join("..", "missing-1.png"), path.join(source, "fastlane", "images", "1.png"));

  copyBundledTree(source, destination);

  assert.equal(fs.readFileSync(path.join(destination, "index.js"), "utf8"), "export default true;\n");
  assert.equal(fs.readFileSync(path.join(destination, "docs", "guide.md"), "utf8"), "# guide\n");
  assert.equal(fs.lstatSync(path.join(destination, "AGENTS.md")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(destination, "AGENTS.md"), "utf8"), "# guide\n");
  assert.equal(fs.existsSync(path.join(destination, "CLAUDE.md")), false);
  assert.equal(fs.existsSync(path.join(destination, "fastlane", "images", "1.png")), false);
});

test("fetched bundled archives are copied through copyBundledTree instead of keeping tar reparse points", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "vendor-upstream-bundles.cjs"), "utf8");
  assert.match(source, /extractArchive\(archive, scratch\)/);
  assert.match(source, /copyBundledTree\(scratch, dest\)/);
  assert.doesNotMatch(source, /extractArchive\(archive, dest\)/);
  assert.match(source, /isLinkOrReparse/);
  assert.match(source, /The directory name is invalid/);
});
