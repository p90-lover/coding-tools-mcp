"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  resolveExpectedRuntimeRelease,
  runtimePackageVersion,
} = require("../electron/runtime-release.cjs");

function writeRuntimePackage(runtimeRoot, version) {
  const appRoot = path.join(runtimeRoot, "app");
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(
    path.join(appRoot, "package.json"),
    `${JSON.stringify({ name: "codex-chatgpt-web", version }, null, 2)}\n`,
  );
}

test("runtime package version is read from the installed ChatGPT-web app, not the Electron launcher", () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-release-"));
  try {
    writeRuntimePackage(runtimeRoot, "5.0.6");
    assert.equal(runtimePackageVersion(runtimeRoot), "5.0.6");
    assert.equal(resolveExpectedRuntimeRelease({
      app: { getVersion: () => "0.7.0-rc.12" },
      installedRuntimeRoot: runtimeRoot,
    }), "5.0.6");
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("explicit expectedRuntimeRelease wins over both installed runtime and Electron versions", () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-release-explicit-"));
  try {
    writeRuntimePackage(runtimeRoot, "5.0.6");
    assert.equal(resolveExpectedRuntimeRelease({
      app: { getVersion: () => "0.7.0-rc.12" },
      installedRuntimeRoot: runtimeRoot,
      expectedRuntimeRelease: "5.0.7",
    }), "5.0.7");
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("resolver falls back to the Electron version only when no local runtime package is present", () => {
  assert.equal(resolveExpectedRuntimeRelease({
    app: { getVersion: () => "0.7.0-rc.12" },
  }), "0.7.0-rc.12");
});

test("runtimeRootProvider preferLocal roots are used without downloading", () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-release-provider-"));
  try {
    writeRuntimePackage(runtimeRoot, "5.0.6");
    let providerCalls = 0;
    assert.equal(resolveExpectedRuntimeRelease({
      app: { getVersion: () => "0.7.0-rc.12" },
      installedRuntimeRoot: path.join(runtimeRoot, "missing"),
      runtimeRootProvider: () => {
        providerCalls += 1;
        return runtimeRoot;
      },
    }), "5.0.6");
    assert.equal(providerCalls, 1);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
