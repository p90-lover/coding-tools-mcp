"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { verifyRegisterSource, validateRegisterRuntime, writeRuntimeManifest, sha256 } = require("../scripts/prepare-register-runtime.cjs");

const root = path.resolve(__dirname, "..");
const vendor = path.join(root, "desktop-electron", "vendor", "register");

test("Register snapshot has exact hashes, real frontend and required current local fixes", () => {
  const manifest = verifyRegisterSource();
  assert.equal(manifest.upstream.commit, "ba1004241f4be7b0bb11b705b7c88a684e42b3db");
  assert.equal(manifest.upstream.license, "AGPL-3.0");
  const names = new Set(manifest.files.map(item => item.path));
  for (const name of ["main.py", "frontend/src/App.tsx", "frontend/package-lock.json", "api/authenticator.py", "core/verification_hold.py", "platforms/chatgpt/security.py", "api/coding_tools.py"]) assert.ok(names.has(name), name);
  assert.match(fs.readFileSync(path.join(vendor, "LICENSE"), "utf8"), /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.ok(manifest.files.filter(item => item.upstreamSha256 && item.sha256 !== item.upstreamSha256).length >= 4);
});

test("runtime verification rejects changed dependencies and unmanifested files", t => {
  const scratch = path.join(root, "aiTemp", "register-cpa-20261023", "runtime-tests");
  fs.mkdirSync(scratch, { recursive: true });
  const runtime = fs.mkdtempSync(path.join(scratch, "manifest-"));
  t.after(() => {
    assert.ok(runtime.startsWith(path.join(root, "aiTemp") + path.sep));
    fs.rmSync(runtime, { recursive: true, force: true });
  });
  for (const name of ["register-service.exe", "_internal/python313.dll", "_internal/static/index.html", "_internal/static/assets/app.js", "browsers/camoufox/camoufox.exe", "browsers/playwright/chromium-1/chrome-win64/chrome.exe", "LICENSE.register", "source/register/LICENSE", "source/register/app/main.py"]) {
    const file = path.join(runtime, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "fixture");
  }
  const sourceManifest = path.join(runtime, "source/register/SOURCE_MANIFEST.json");
  fs.writeFileSync(sourceManifest, JSON.stringify({ files: [{ path: "main.py", sha256: sha256(path.join(runtime, "source/register/app/main.py")) }] }));
  const receipt = { schemaVersion: 1, platform: "win32", arch: "x64", sourceManifestSha256: sha256(sourceManifest), binarySha256: sha256(path.join(runtime, "register-service.exe")) };
  writeRuntimeManifest(runtime, receipt);
  assert.equal(validateRegisterRuntime(runtime, { platform: "win32", arch: "x64" }).fileCount, 10);
  assert.throws(() => validateRegisterRuntime(runtime, { platform: "win32", arch: "x64", sourceManifestSha256: "0".repeat(64) }), /SOURCE_STALE/);
  fs.writeFileSync(path.join(runtime, "unexpected.db"), "unmanifested");
  assert.throws(() => validateRegisterRuntime(runtime, { platform: "win32", arch: "x64" }), /INVENTORY_MISMATCH/);
  fs.rmSync(path.join(runtime, "unexpected.db"));
  fs.writeFileSync(path.join(runtime, "_internal/python313.dll"), "changed");
  assert.throws(() => validateRegisterRuntime(runtime, { platform: "win32", arch: "x64" }), /HASH_MISMATCH/);
});
