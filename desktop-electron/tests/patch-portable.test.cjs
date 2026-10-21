const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");

const { isAppMainProcess } = require("../scripts/patch-portable.cjs");

test("a portable patch checks the launcher archive version before creating target staging", async () => {
  const scratch = path.join(__dirname, "..", "..", "aiTemp");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "portable-identity-"));
  try {
    const target = path.join(root, "target");
    const source = path.join(root, "source");
    for (const folder of [target, source]) {
      fs.mkdirSync(path.join(folder, "resources"), { recursive: true });
      fs.writeFileSync(path.join(folder, "Coding Tools.exe"), "fixture");
      fs.writeFileSync(path.join(folder, "resources", "app.asar"), "unchanged fixture");
    }
    const archiveSource = path.join(root, "archive-source");
    fs.mkdirSync(archiveSource);
    fs.writeFileSync(path.join(archiveSource, "package.json"), JSON.stringify({ version: "0.7.0-rc.23" }));
    const asar = require(require.resolve("@electron/asar", { paths: [path.join(__dirname, "..")] }));
    await asar.createPackage(archiveSource, path.join(source, "resources", "app.asar"));
    fs.mkdirSync(path.join(source, "resources", "coding-tools"));
    fs.writeFileSync(path.join(source, "resources", "coding-tools", "package-manifest.json"),
      JSON.stringify({ product: { version: "0.7.0-rc.22" } }));
    fs.mkdirSync(path.join(source, "resources", "runtime"));
    fs.writeFileSync(path.join(source, "resources", "runtime", "manifest.json"),
      JSON.stringify({ schemaVersion: 2, appVersion: "0.7.0-rc.22" }));
    const result = spawnSync(process.execPath, [
      path.join(__dirname, "..", "scripts", "patch-portable.cjs"),
      "--target", target, "--from", source, "--dry-run",
    ], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /identity mismatch.*0\.7\.0-rc\.23.*0\.7\.0-rc\.22/s);
    assert.equal(fs.existsSync(path.join(target, "_update")), false);
    assert.equal(fs.readFileSync(path.join(target, "resources", "app.asar"), "utf8"), "unchanged fixture");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("portable source builds refresh runtime and package resources before electron-builder", () => {
  const filename = path.join(__dirname, "..", "scripts", "patch-portable.cjs");
  const originalRequire = createRequire(filename);
  const calls = [];
  const localRequire = (id) => id === "node:child_process"
    ? { spawnSync(command, args) { calls.push({ command, args }); return { status: 0 }; } }
    : originalRequire(id);
  localRequire.resolve = () => "fixture-electron-builder.cjs";
  const sandbox = { require: localRequire, module: { exports: {} }, __dirname: path.dirname(filename), process, console };
  vm.runInNewContext(fs.readFileSync(filename, "utf8") + "\nmodule.exports.buildUnpacked = buildUnpacked;", sandbox, { filename });
  sandbox.module.exports.buildUnpacked();
  assert.deepEqual(calls.slice(0, 3).map(call => Array.from(call.args)), [
    ["run", "build"], ["run", "build:runtime"], ["run", "build:package-resources"],
  ]);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].args[0], "fixture-electron-builder.cjs");
});

test("the packager rejects stale runtime resources before staging or invoking electron-builder", () => {
  const scratch = path.join(__dirname, "..", "..", "aiTemp");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "package-identity-"));
  try {
    fs.mkdirSync(path.join(root, "build", "runtime"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.7.0-rc.23" }));
    fs.writeFileSync(path.join(root, "build", "runtime", "manifest.json"),
      JSON.stringify({ schemaVersion: 2, appVersion: "0.7.0-rc.22" }));
    const filename = path.join(__dirname, "..", "scripts", "package.cjs");
    const originalRequire = createRequire(filename);
    let staged = false;
    let launched = false;
    const localRequire = (id) => {
      if (id === "node:child_process") return { spawnSync() { launched = true; return { status: 0 }; } };
      if (id === "./preservation.cjs") return { createPreservationSession() { staged = true; throw new Error("unexpected staging"); } };
      return originalRequire(id);
    };
    localRequire.resolve = () => "fixture-electron-builder.cjs";
    assert.throws(() => vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
      require: localRequire, __dirname: path.join(root, "scripts"),
      process: { platform: process.platform, arch: process.arch, argv: ["node", filename], env: {} },
      console: { warn() {} },
    }, { filename }), /identity mismatch.*0\.7\.0-rc\.23.*0\.7\.0-rc\.22/s);
    assert.equal(staged, false);
    assert.equal(launched, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the patch waits for the app window, not the bridge's browser helper or Chromium children", () => {
  // Seen live: the oldest Coding Tools.exe was the bridge's helper, which outlives the app, so the
  // patch worker waited on it and timed out without applying anything.
  assert.equal(isAppMainProcess('"G:\\Apps\\Coding Tools\\Coding Tools.exe"'), true);
  assert.equal(isAppMainProcess('"G:\\Apps\\Coding Tools\\Coding Tools.exe" --profile-directory=Default'), true);
  assert.equal(isAppMainProcess('"G:\\Apps\\Coding Tools\\Coding Tools.exe" G:\\AppData\\.coding-tools\\versions\\0.7.0-rc.16-win32-x64\\app\\browser-helper.cjs'), false);
  assert.equal(isAppMainProcess('"G:\\Apps\\Coding Tools\\Coding Tools.exe" C:\\x\\worker.mjs'), false);
  assert.equal(isAppMainProcess('"G:\\Apps\\Coding Tools\\Coding Tools.exe" --type=renderer --user-data-dir=x'), false);
  assert.equal(isAppMainProcess(null), true, "an unreadable command line is not excluded");
});
