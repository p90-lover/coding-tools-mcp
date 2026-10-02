const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "../..");
const scriptPath = path.join(projectRoot, "desktop-electron/assets/keysmith/codex-instruct-v0.6.0.py");
const expectedScriptSha256 = "837ec25713851a2fb6d8646dd078ee03a2e23fe17b19e97e093cedb02349979d";

function fixture(t) {
  const parent = path.join(__dirname, "../aiTemp/keysmith-setup/runner-tests");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Match the user-owned Codex home ACL; copied checkouts may inherit only Modify.
  if (process.platform === "win32") {
    const { execFileSync } = require("node:child_process");
    const account = execFileSync("whoami.exe", [], { windowsHide: true, encoding: "utf8" }).trim();
    execFileSync("icacls.exe", [root, "/grant:r", `${account}:(OI)(CI)F`], { windowsHide: true, stdio: "pipe" });
  }
  const codexDir = path.join(root, "codex");
  fs.mkdirSync(codexDir);
  const instructionFile = path.join(root, "reviewed.md");
  fs.writeFileSync(instructionFile, "# Reviewed instructions\nAnswer clearly.\n");
  fs.writeFileSync(path.join(codexDir, "config.toml"), 'model = "gpt-6-sol"\n');
  return { codexDir, instructionFile };
}

test("preview invokes only the pinned custom-file and hook-preserving mode", async (t) => {
  const { codexDir, instructionFile } = fixture(t);
  assert.ok(fs.existsSync(path.join(__dirname, "../electron/keysmith-managed.cjs")), "Keysmith host is missing");
  const { createKeysmithManaged } = require("../electron/keysmith-managed.cjs");
  const calls = [];
  let stdinEnded = false;
  const keysmith = createKeysmithManaged({
    scriptPath,
    pythonExecutable: "python",
    codexDir,
    expectedScriptSha256,
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, "preview ready", "");
      return { stdin: { end() { stdinEnded = true; } } };
    },
  });

  assert.deepEqual(await keysmith.preview(instructionFile), {
    ok: true,
    stdout: "preview ready",
    stderr: "",
    exitCode: 0,
    fileSha256: crypto.createHash("sha256").update(fs.readFileSync(instructionFile)).digest("hex"),
  });
  assert.equal(calls.length, 1);
  assert.equal(stdinEnded, true, "Noninteractive installer must close its stdin pipe");
  assert.equal(calls[0].file, "python");
  assert.deepEqual(calls[0].args, [
    "-I", "-B", fs.realpathSync(scriptPath),
    "--lang", "en",
    "--codex-dir", fs.realpathSync(codexDir),
    "--file", fs.realpathSync(instructionFile),
    "--name", "coding-tools-keysmith",
    "--skip-hooks-isolation", "--dry-run",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.ok(calls[0].options.timeout > 0 && calls[0].options.timeout <= 120_000);
  assert.ok(calls[0].options.maxBuffer > 0 && calls[0].options.maxBuffer <= 256 * 1024);
});

test("apply needs confirmation and an unchanged previewed Markdown", async (t) => {
  const { codexDir, instructionFile } = fixture(t);
  const { createKeysmithManaged } = require("../electron/keysmith-managed.cjs");
  const calls = [];
  const keysmith = createKeysmithManaged({
    scriptPath, pythonExecutable: "python", codexDir, expectedScriptSha256,
    execFileImpl: (_file, args, _options, callback) => {
      calls.push(args);
      callback(null, "ok", "");
    },
  });
  assert.equal(typeof keysmith.apply, "function", "confirmed apply operation is missing");
  const preview = await keysmith.preview(instructionFile);
  await assert.rejects(keysmith.apply({ instructionFile, confirmed: false, expectedFileSha256: preview.fileSha256 }), /confirm/i);
  assert.equal(calls.length, 1);

  fs.writeFileSync(instructionFile, "# Changed after preview\n");
  await assert.rejects(keysmith.apply({ instructionFile, confirmed: true, expectedFileSha256: preview.fileSha256 }), /changed|preview/i);
  assert.equal(calls.length, 1);

  fs.writeFileSync(instructionFile, "# Reviewed instructions\nAnswer clearly.\n");
  await assert.rejects(keysmith.apply({ instructionFile, confirmed: true, expectedFileSha256: preview.fileSha256 }), /preview/i);
  const renewed = await keysmith.preview(instructionFile);
  assert.deepEqual(await keysmith.apply({ instructionFile, confirmed: true, expectedFileSha256: renewed.fileSha256 }), {
    ok: true, stdout: "", stderr: "", exitCode: 0,
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].at(-1), "--yes");
  assert.ok(calls[2].includes("--file"));
  assert.ok(calls[2].includes("--skip-hooks-isolation"));
  assert.ok(!calls[2].includes("--dry-run"));
});

test("apply rejects a Codex config changed after preview", async (t) => {
  const { codexDir, instructionFile } = fixture(t);
  const { createKeysmithManaged } = require("../electron/keysmith-managed.cjs");
  const calls = [];
  const keysmith = createKeysmithManaged({
    scriptPath, pythonExecutable: "python", codexDir, expectedScriptSha256,
    execFileImpl: (_file, args, _options, callback) => {
      calls.push(args);
      callback(null, "ok", "");
    },
  });
  const preview = await keysmith.preview(instructionFile);
  fs.writeFileSync(path.join(codexDir, "config.toml"), 'model = "changed"\n');
  await assert.rejects(keysmith.apply({ instructionFile, confirmed: true, expectedFileSha256: preview.fileSha256 }), /changed|preview/i);
  assert.equal(calls.length, 1);
});

test("status rejects Python older than 3.10 without running the installer", async (t) => {
  const { codexDir } = fixture(t);
  const { createKeysmithManaged } = require("../electron/keysmith-managed.cjs");
  const calls = [];
  const keysmith = createKeysmithManaged({
    scriptPath, pythonExecutable: "python", codexDir, expectedScriptSha256,
    execFileImpl: (_file, args, _options, callback) => {
      calls.push(args);
      callback(null, "3.9.18\n", "");
    },
  });
  await assert.rejects(keysmith.status(), /Python 3\.10\+ is required/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("-c"));
  assert.ok(!calls[0].includes(scriptPath));
});

test("an unrelated Keysmith manifest is reported but cannot be removed here", async (t) => {
  const { codexDir } = fixture(t);
  fs.writeFileSync(path.join(codexDir, ".codex-keysmith-manifest.json"), JSON.stringify({ md: { path: "other.md" } }));
  const { createKeysmithManaged } = require("../electron/keysmith-managed.cjs");
  const calls = [];
  const keysmith = createKeysmithManaged({
    scriptPath, pythonExecutable: "python", codexDir, expectedScriptSha256,
    execFileImpl: (_file, args, _options, callback) => {
      calls.push(args);
      callback(null, args.includes("-c") ? "3.14.6\n" : "Config activation: active\n", "");
    },
  });
  const status = await keysmith.status();
  assert.equal(status.installed, true);
  assert.equal(status.managedByCodingTools, false);
  await assert.rejects(keysmith.previewUninstall(), /not managed by Coding Tools/i);
  assert.ok(!calls.some((args) => args.includes("--uninstall")));
});

test("unrecognized CLI status does not return its raw output as a failed result", async (t) => {
  const { codexDir } = fixture(t);
  const { createKeysmithManaged } = require("../electron/keysmith-managed.cjs");
  const keysmith = createKeysmithManaged({
    scriptPath, pythonExecutable: "python", codexDir, expectedScriptSha256,
    execFileImpl: (_file, args, _options, callback) => {
      callback(null, args.includes("-c") ? "3.14.6\n" : "PRIVATE STATUS BODY\n", "");
    },
  });
  const status = await keysmith.status();
  assert.equal(status.ok, false);
  assert.equal(status.state, "unknown");
  assert.equal(status.stdout, "");
  assert.equal(status.stderr, "");
});

test("uninstall rejects a manifest changed after its preview", async (t) => {
  const { codexDir } = fixture(t);
  const manifestPath = path.join(codexDir, ".codex-keysmith-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ deployment_id: "first", md: { path: "coding-tools-keysmith.md" } }));
  const { createKeysmithManaged } = require("../electron/keysmith-managed.cjs");
  const calls = [];
  const keysmith = createKeysmithManaged({
    scriptPath, pythonExecutable: "python", codexDir, expectedScriptSha256,
    execFileImpl: (_file, args, _options, callback) => {
      calls.push(args);
      callback(null, "preview", "");
    },
  });
  assert.equal((await keysmith.previewUninstall()).ok, true);
  fs.writeFileSync(manifestPath, JSON.stringify({ deployment_id: "second", md: { path: "coding-tools-keysmith.md" } }));
  await assert.rejects(keysmith.uninstall({ confirmed: true }), /changed|preview/i);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes("--yes"));
});

test("bad release bytes and missing Python fail without exposing child output", async (t) => {
  const { codexDir, instructionFile } = fixture(t);
  const { createKeysmithManaged } = require("../electron/keysmith-managed.cjs");
  const fakeScript = path.join(path.dirname(codexDir), "fake.py");
  fs.writeFileSync(fakeScript, "print('not the pinned release')\n");
  let started = false;
  const altered = createKeysmithManaged({
    scriptPath: fakeScript, pythonExecutable: "python", codexDir, expectedScriptSha256,
    execFileImpl: () => { started = true; },
  });
  await assert.rejects(altered.preview(instructionFile), /checksum mismatch/);
  assert.equal(started, false);

  const missingPython = createKeysmithManaged({
    scriptPath, pythonExecutable: "python", codexDir, expectedScriptSha256,
    execFileImpl: (_file, _args, _options, callback) => {
      callback(Object.assign(new Error("PRIVATE CHILD BODY"), { code: "ENOENT" }), "PRIVATE", "PRIVATE");
    },
  });
  await assert.rejects(missingPython.status(), (error) => {
    assert.equal(error.message, "Python 3.10+ is unavailable");
    return true;
  });
});

test("isolated Keysmith status, apply, and uninstall preserve hooks and unrelated config", async (t) => {
  const { codexDir, instructionFile } = fixture(t);
  const configPath = path.join(codexDir, "config.toml");
  const hooksPath = path.join(codexDir, "hooks.json");
  const originalConfig = fs.readFileSync(configPath);
  const originalHooks = Buffer.from('{"hooks":{"user_owned":true}}\n');
  fs.writeFileSync(hooksPath, originalHooks);
  const { createKeysmithManaged } = require("../electron/keysmith-managed.cjs");
  const keysmith = createKeysmithManaged({
    scriptPath,
    pythonExecutable: process.platform === "win32" ? "python" : "python3",
    codexDir,
    expectedScriptSha256,
  });
  assert.equal(typeof keysmith.status, "function", "read-only status operation is missing");
  assert.equal(typeof keysmith.previewUninstall, "function", "uninstall preview is missing");
  assert.equal(typeof keysmith.uninstall, "function", "confirmed uninstall is missing");

  const before = await keysmith.status();
  assert.equal(before.installed, false);
  assert.equal(before.state, "not-installed");
  assert.equal(before.managedByCodingTools, false);
  assert.match(before.stdout, /Config activation:\s+not-installed/);
  const preview = await keysmith.preview(instructionFile);
  assert.equal(preview.ok, true, preview.stderr || preview.stdout);
  assert.deepEqual(fs.readFileSync(configPath), originalConfig);
  assert.deepEqual(fs.readFileSync(hooksPath), originalHooks);

  const applied = await keysmith.apply({ instructionFile, confirmed: true, expectedFileSha256: preview.fileSha256 });
  assert.equal(applied.ok, true, applied.stderr || applied.stdout);
  const installed = await keysmith.status();
  assert.equal(installed.installed, true);
  assert.equal(installed.state, "active");
  assert.equal(installed.managedByCodingTools, true);
  assert.match(installed.stdout, /Config activation:\s+active/);
  assert.deepEqual(fs.readFileSync(hooksPath), originalHooks);
  assert.match(fs.readFileSync(configPath, "utf8"), /model = "gpt-6-sol"/);

  const removalPlan = await keysmith.previewUninstall();
  assert.equal(removalPlan.ok, true, removalPlan.stderr || removalPlan.stdout);
  await assert.rejects(keysmith.uninstall({ confirmed: false }), /confirm/i);
  assert.equal((await keysmith.uninstall({ confirmed: true })).ok, true);
  const removed = await keysmith.status();
  assert.equal(removed.installed, false);
  assert.equal(removed.state, "not-installed");
  assert.equal(removed.managedByCodingTools, false);
  assert.match(removed.stdout, /Config activation:\s+not-installed/);
  assert.deepEqual(fs.readFileSync(configPath), originalConfig);
  assert.deepEqual(fs.readFileSync(hooksPath), originalHooks);

  const bundledPreview = await keysmith.preview();
  assert.equal(bundledPreview.ok, true);
  assert.deepEqual(fs.readFileSync(configPath), originalConfig);
  assert.equal((await keysmith.apply({
    confirmed: true, expectedFileSha256: bundledPreview.fileSha256,
  })).ok, true);
  assert.equal((await keysmith.status()).state, "active");
  assert.ok(fs.statSync(path.join(codexDir, "coding-tools-keysmith.md")).size > 1000);
  assert.deepEqual(fs.readFileSync(hooksPath), originalHooks);
  assert.equal((await keysmith.previewUninstall()).ok, true);
  assert.equal((await keysmith.uninstall({ confirmed: true })).ok, true);
  assert.deepEqual(fs.readFileSync(configPath), originalConfig);
  assert.deepEqual(fs.readFileSync(hooksPath), originalHooks);
});
