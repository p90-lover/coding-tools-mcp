"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  copyBundledTree,
  flattenSymlinks,
} = require("../scripts/vendor-upstream-bundles.cjs");

function temporaryDirectory(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

test("copyBundledTree skips dangling gitlinks and materializes real file links", (t) => {
  const root = temporaryDirectory("coding-tools-bundled-gitlinks");
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  const docs = path.join(source, "docs");
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, "guide.md"), "# guide\n");
  fs.writeFileSync(path.join(source, "index.js"), "export default true;\n");
  try {
    fs.symlinkSync(path.join("docs", "guide.md"), path.join(source, "AGENTS.md"));
    fs.symlinkSync(path.join("docs", "missing.md"), path.join(source, "CLAUDE.md"));
    fs.mkdirSync(path.join(source, "fastlane", "images"), { recursive: true });
    fs.symlinkSync(path.join("..", "missing-1.png"), path.join(source, "fastlane", "images", "1.png"));
  } catch {
    t.skip("filesystem does not allow file symlinks");
    return;
  }

  copyBundledTree(source, destination);

  assert.equal(fs.readFileSync(path.join(destination, "index.js"), "utf8"), "export default true;\n");
  assert.equal(fs.readFileSync(path.join(destination, "docs", "guide.md"), "utf8"), "# guide\n");
  assert.equal(fs.lstatSync(path.join(destination, "AGENTS.md")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(destination, "AGENTS.md"), "utf8"), "# guide\n");
  assert.equal(fs.existsSync(path.join(destination, "CLAUDE.md")), false);
  assert.equal(fs.existsSync(path.join(destination, "fastlane", "images", "1.png")), false);
});

test("flattenSymlinks replaces remaining gitlinks with regular files", (t) => {
  const root = temporaryDirectory("coding-tools-flatten-gitlinks");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# anneal\n");
  try {
    fs.symlinkSync("CLAUDE.md", path.join(root, "AGENTS.md"));
    fs.symlinkSync("missing-target", path.join(root, "dangling.md"));
  } catch {
    t.skip("filesystem does not allow file symlinks");
    return;
  }

  flattenSymlinks(root);

  assert.equal(fs.lstatSync(path.join(root, "AGENTS.md")).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "# anneal\n");
  assert.equal(fs.existsSync(path.join(root, "dangling.md")), false);
});

test("fetched bundled archives are copied through copyBundledTree instead of keeping tar reparse points", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "vendor-upstream-bundles.cjs"), "utf8");
  assert.match(source, /extractArchive\(archive, scratch\)/);
  assert.match(source, /copyBundledTree\(scratch, dest\)/);
  assert.doesNotMatch(source, /extractArchive\(archive, dest\)/);
  assert.match(source, /isLinkOrReparse/);
  assert.match(source, /The directory name is invalid/);
  assert.match(source, /flattenSymlinks\(dest\)/);
});

test("copyBundledTree and flatten drop Windows file-named directories that 7za cannot archive", () => {
  const source = temporaryDirectory("coding-tools-bundled-file-dirs-src");
  const destination = temporaryDirectory("coding-tools-bundled-file-dirs-dst");
  fs.writeFileSync(path.join(source, "package.json"), `${JSON.stringify({ name: "anneal" })}\n`);
  fs.mkdirSync(path.join(source, "CLAUDE.md"));
  fs.mkdirSync(path.join(source, "screenshots", "1.png"), { recursive: true });
  fs.mkdirSync(path.join(source, "packages", "server", "AGENTS.md"), { recursive: true });
  fs.writeFileSync(path.join(source, "packages", "server", "index.js"), "export {}\n");

  copyBundledTree(source, destination);
  flattenSymlinks(destination);

  assert.equal(fs.readFileSync(path.join(destination, "package.json"), "utf8"), `${JSON.stringify({ name: "anneal" })}\n`);
  assert.equal(fs.readFileSync(path.join(destination, "packages", "server", "index.js"), "utf8"), "export {}\n");
  assert.equal(fs.existsSync(path.join(destination, "CLAUDE.md")), false);
  assert.equal(fs.existsSync(path.join(destination, "screenshots", "1.png")), false);
  assert.equal(fs.existsSync(path.join(destination, "packages", "server", "AGENTS.md")), false);
});
