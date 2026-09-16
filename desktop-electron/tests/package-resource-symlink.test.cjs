"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { copyTree } = require("../scripts/prepare-package-resources.cjs");

function fixture(label) {
  const root = path.resolve(__dirname, "..", "..", "aiTemp", "Trash", "package-resource-symlink-tests", `${label}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

test("materializes an internal file symlink as a regular file", { skip: process.platform === "win32" }, () => {
  const root = fixture("internal");
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  const target = path.join(source, "node_modules", "which", "bin", "node-which");
  const link = path.join(source, "node_modules", ".bin", "node-which");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.writeFileSync(target, "#!/bin/sh\necho which\n", { mode: 0o755 });
  fs.symlinkSync("../which/bin/node-which", link);

  copyTree(source, destination, source);

  const copied = path.join(destination, "node_modules", ".bin", "node-which");
  assert.equal(fs.lstatSync(copied).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(copied, "utf8"), fs.readFileSync(target, "utf8"));
});

test("rejects a symlink that resolves outside the copied root", { skip: process.platform === "win32" }, () => {
  const root = fixture("escape");
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  const external = path.join(root, "external.txt");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(external, "outside\n");
  fs.symlinkSync(external, path.join(source, "escape"));

  assert.throws(() => copyTree(source, destination, source), /PACKAGE_RESOURCE_SYMLINK_FORBIDDEN/);
});
