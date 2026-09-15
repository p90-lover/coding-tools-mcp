"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const runtimeRoot = path.resolve(__dirname, "..");
const { prepareFreshRuntimeOutput } = require("../scripts/runtime-output.cjs");

function fixturePath(label) {
  const root = path.join(
    runtimeRoot,
    "aiTemp",
    "Trash",
    "runtime-output-tests",
    `${label}-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(root, { recursive: true });
  return root;
}

test("creates a previously absent runtime output without deleting another path", () => {
  const parent = fixturePath("fresh");
  const output = path.join(parent, "nested", "runtime");
  assert.equal(fs.existsSync(output), false);
  const prepared = prepareFreshRuntimeOutput(output);
  assert.equal(prepared, path.resolve(output));
  assert.equal(fs.statSync(output).isDirectory(), true);
});

test("refuses an existing runtime output and preserves every byte", () => {
  const output = path.join(fixturePath("existing"), "runtime");
  fs.mkdirSync(output, { recursive: true });
  const sentinel = path.join(output, "sentinel.txt");
  fs.writeFileSync(sentinel, "retain-me");
  assert.throws(
    () => prepareFreshRuntimeOutput(output),
    /RUNTIME_BUNDLE_OUTPUT_ALREADY_EXISTS/,
  );
  assert.equal(fs.readFileSync(sentinel, "utf8"), "retain-me");
});

test("rejects an output symlink without touching its target", (context) => {
  const root = fixturePath("symlink");
  const target = path.join(root, "target");
  const output = path.join(root, "runtime-link");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "sentinel.txt"), "retain-target");
  try {
    fs.symlinkSync(target, output, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    context.skip(`symlink unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  assert.throws(
    () => prepareFreshRuntimeOutput(output),
    /RUNTIME_BUNDLE_OUTPUT_SYMLINK_REJECTED/,
  );
  assert.equal(fs.readFileSync(path.join(target, "sentinel.txt"), "utf8"), "retain-target");
});

test("the runtime bundle builder uses the fail-closed output helper", () => {
  const builder = fs.readFileSync(path.join(runtimeRoot, "scripts", "build-runtime-bundle.ts"), "utf8");
  assert.match(builder, /prepareFreshRuntimeOutput\(output\)/);
  assert.doesNotMatch(builder, /\brmSync\s*\(/);
});

test("the output helper contains no destructive filesystem operation", () => {
  const helper = fs.readFileSync(path.join(runtimeRoot, "scripts", "runtime-output.cjs"), "utf8");
  for (const pattern of [
    /fs\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/,
    /\brm\s+-rf\b/i,
    /Remove-Item[^\n]*-Recurse[^\n]*-Force/i,
  ]) {
    assert.doesNotMatch(helper, pattern);
  }
});
