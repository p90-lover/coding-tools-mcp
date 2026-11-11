"use strict";

// runtime-command.cjs checks bun.exe and cli.js synchronously only for a root nobody has verified:
// existsSync(bun.exe) held every window 5.6 s as 0.8.106 started on the busy hard disk (2026-11-10).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function freshModule() {
  delete require.cache[require.resolve("../electron/runtime-command.cjs")];
  return require("../electron/runtime-command.cjs");
}

function runtimeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-runtime-command-"));
  fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(root, "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "runtime", process.platform === "win32" ? "bun.exe" : "bun"), "");
  fs.writeFileSync(path.join(root, "app", "cli.js"), "");
  return root;
}

function countingExistsSync(run) {
  const existsSync = fs.existsSync;
  let calls = 0;
  fs.existsSync = (...args) => { calls += 1; return existsSync(...args); };
  try { run(); } finally { fs.existsSync = existsSync; }
  return calls;
}

const app = { isPackaged: true };

test("a root verified by the runtime install needs no synchronous check", (t) => {
  const { markRuntimeRootChecked, runtimeInvocation } = freshModule();
  const root = runtimeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  markRuntimeRootChecked(root);
  let invocation;
  assert.equal(countingExistsSync(() => { invocation = runtimeInvocation({ app, installedRuntimeRoot: root, args: ["serve"] }); }), 0);
  assert.deepEqual(invocation.args, [path.join(root, "app", "cli.js"), "serve"]);
  assert.equal(invocation.cwd, root);
});

test("an unverified root is checked once, then trusted", (t) => {
  const { runtimeInvocation } = freshModule();
  const root = runtimeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(countingExistsSync(() => runtimeInvocation({ app, installedRuntimeRoot: root, args: ["serve"] })), 2);
  assert.equal(countingExistsSync(() => runtimeInvocation({ app, installedRuntimeRoot: root, args: ["--version"] })), 0);
});

test("an unverified root missing bun or cli.js still fails with the same message", (t) => {
  const { runtimeInvocation } = freshModule();
  const root = runtimeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.rmSync(path.join(root, "app", "cli.js"));
  assert.throws(() => runtimeInvocation({ app, installedRuntimeRoot: root, args: ["serve"] }), /Bundled runtime entrypoint is missing/);
  fs.rmSync(path.join(root, "runtime"), { recursive: true });
  assert.throws(() => runtimeInvocation({ app, installedRuntimeRoot: root, args: ["serve"] }), /Bundled Bun runtime is missing/);
  // A failed check marks nothing: the next command checks again.
  assert.equal(countingExistsSync(() => assert.throws(() => runtimeInvocation({ app, installedRuntimeRoot: root, args: [] }))), 1);
});

test("a packaged app reads the bridge version once per runtime root; a missing or invalid file is not remembered", (t) => {
  const { runtimeReleaseVersion } = freshModule();
  const root = runtimeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageJson = path.join(root, "app", "package.json");
  const reads = (run) => {
    const readFileSync = fs.readFileSync;
    let count = 0;
    fs.readFileSync = (...args) => { count += 1; return readFileSync(...args); };
    try { return { calls: countingExistsSync(run), reads: count }; } finally { fs.readFileSync = readFileSync; }
  };
  // Missing, then invalid: both fail every time, as before.
  assert.throws(() => runtimeReleaseVersion({ app, installedRuntimeRoot: root }), /metadata is missing/);
  fs.writeFileSync(packageJson, JSON.stringify({ name: "other", version: "1.0.0" }));
  assert.throws(() => runtimeReleaseVersion({ app, installedRuntimeRoot: root }), /metadata is invalid/);
  fs.writeFileSync(packageJson, JSON.stringify({ name: "codex-chatgpt-web", version: "5.0.6" }));
  let version;
  assert.deepEqual(reads(() => { version = runtimeReleaseVersion({ app, installedRuntimeRoot: root }); }), { calls: 1, reads: 1 });
  assert.equal(version, "5.0.6");
  // Every later runtime start or recovery: no disk call at all.
  assert.deepEqual(reads(() => { version = runtimeReleaseVersion({ app, runtimeRootProvider: () => root }); }), { calls: 0, reads: 0 });
  assert.equal(version, "5.0.6");
  // A development run reads its source package.json every time, so an edit there still counts.
  const dev = { isPackaged: false, getVersion: () => "0.0.0" };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "codex-chatgpt-web", version: "5.0.7" }));
  assert.equal(runtimeReleaseVersion({ app: dev, sourceRoot: root }), "5.0.7");
  assert.deepEqual(reads(() => runtimeReleaseVersion({ app: dev, sourceRoot: root })), { calls: 1, reads: 1 });
});

test("main marks the launch root and every reinstalled root as checked", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  assert.match(source, /installedRuntimeRoot = ensurePackagedRuntime\(\{[\s\S]{0,200}?\}\);[\s\S]{0,200}?markRuntimeRootChecked\(installedRuntimeRoot\);/);
  assert.match(source, /const launchRuntimeRoot = await preparePackagedRuntime\([\s\S]{0,600}?markRuntimeRootChecked\(launchRuntimeRoot\);/);
});
