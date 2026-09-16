"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateRuntimeVersionProbe } = require("../electron/runtime-command.cjs");

function runtimeManifestFs(runtimeRoot, version) {
  return {
    readFileSync(filePath, encoding) {
      assert.equal(filePath, path.join(runtimeRoot, "app", "package.json"));
      assert.equal(encoding, "utf8");
      return JSON.stringify({ version });
    },
  };
}

test("packaged smoke accepts the runtime CLI own verified version", () => {
  const runtimeRoot = path.resolve("aiTemp", "runtime-version-probe-fixture");
  const version = validateRuntimeVersionProbe(
    runtimeRoot,
    { status: 0, stdout: "5.0.6\n", stderr: "" },
    runtimeManifestFs(runtimeRoot, "5.0.6"),
  );
  assert.equal(version, "5.0.6");
  assert.notEqual(version, "0.6.0-rc.1");
});

test("packaged smoke rejects a runtime CLI version that differs from its package metadata", () => {
  const runtimeRoot = path.resolve("aiTemp", "runtime-version-probe-mismatch");
  assert.throws(
    () => validateRuntimeVersionProbe(
      runtimeRoot,
      { status: 0, stdout: "5.0.5\n", stderr: "" },
      runtimeManifestFs(runtimeRoot, "5.0.6"),
    ),
    /expected="5\.0\.6".*stdout="5\.0\.5"/,
  );
});

test("main launcher delegates runtime version validation instead of comparing it with the desktop version", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  assert.match(source, /validateRuntimeVersionProbe\(smokeRuntimeRoot, versionResult\);/);
  assert.doesNotMatch(source, /versionResult\.stdout\.trim\(\) !== app\.getVersion\(\)/);
});
