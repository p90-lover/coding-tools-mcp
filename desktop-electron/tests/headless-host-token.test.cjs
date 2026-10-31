"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { HeadlessHost, removeStaleTokenFiles } = require("../electron/headless-host.cjs");

// A stand-in for coding-tools-headless: node itself, started as `<binary> serve`, runs the `serve`
// script beside it, which follows the real service's startup contract (lib.rs HeadlessService):
// it writes its control token to CODING_TOOLS_CONTROL_TOKEN_FILE and then a ready descriptor.
const FAKE_SERVICE = `"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const token = crypto.randomBytes(32).toString("base64url");
const tokenFile = process.env.CODING_TOOLS_CONTROL_TOKEN_FILE;
process.stdin.resume();
fs.writeFileSync(tokenFile, token);
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== "Bearer " + token) { response.writeHead(401); response.end("{}"); return; }
  if (request.url === "/control/v1/health") { response.end(JSON.stringify({ ready: true, protocol_version: 1 })); return; }
  if (request.url === "/control/v1/shutdown") { response.end("{}"); setTimeout(() => process.exit(0), 20); return; }
  response.end(JSON.stringify({ ok: true, token_file_exists: fs.existsSync(tokenFile) }));
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(process.env.CODING_TOOLS_CONTROL_DESCRIPTOR_FILE, JSON.stringify({
    schema: 1, protocol_version: 1, pid: process.pid, endpoint: "http://127.0.0.1:" + server.address().port,
    version: "test", token_sha256: crypto.createHash("sha256").update(token).digest("hex"), token_file: tokenFile,
    app_data_dir: process.env.CODING_TOOLS_APP_DATA_DIR, status: "ready",
  }));
});
`;

const startupFixtureRoot = path.resolve(__dirname, "../../aiTemp/headless-host-tests");

function startupFixture(t, source) {
  fs.mkdirSync(startupFixtureRoot, { recursive: true });
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(startupFixtureRoot, "headless-startup-")));
  const binaryRoot = path.join(base, "bundle"), binaryDir = path.join(binaryRoot, "coding-tools");
  fs.mkdirSync(binaryDir, { recursive: true });
  fs.writeFileSync(path.join(binaryDir, "package.json"), JSON.stringify({ type: "commonjs" }));
  const binary = path.join(binaryDir, `coding-tools-headless${process.platform === "win32" ? ".exe" : ""}`);
  try { fs.linkSync(process.execPath, binary); } catch { fs.copyFileSync(process.execPath, binary); }
  fs.writeFileSync(path.join(binaryDir, "serve"), source);
  const saved = process.env.CODING_TOOLS_HEADLESS_BINARY;
  delete process.env.CODING_TOOLS_HEADLESS_BINARY;
  t.after(() => {
    if (saved === undefined) delete process.env.CODING_TOOLS_HEADLESS_BINARY;
    else process.env.CODING_TOOLS_HEADLESS_BINARY = saved;
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, binaryRoot };
}

test("startup resolves a junction profile before passing private paths to the service", async (t) => {
  const { base, binaryRoot } = startupFixture(t, FAKE_SERVICE);
  const physical = path.join(base, "physical-profile"), alias = path.join(base, "profile-alias");
  fs.mkdirSync(physical);
  fs.symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");
  const logger = { info() {}, warn() {}, error() {} };
  const host = new HeadlessHost({ app: { getPath: () => alias, isPackaged: false }, logger, sourceRoot: base, binaryRoot });
  try {
    const control = await host.ensureStarted();
    const root = fs.realpathSync.native(path.join(physical, "headless"));
    assert.ok(control.descriptorPath.startsWith(root + path.sep));
    assert.ok(control.tokenPath.startsWith(root + path.sep));
    const descriptor = JSON.parse(fs.readFileSync(control.descriptorPath, "utf8"));
    assert.equal(descriptor.app_data_dir, root);
    assert.equal((await host.request("/api/v1/anything")).ok, true);
  } finally { await host.shutdown("junction-test"); }
});

test("the service's program is warmed off the main thread before it is started", async (t) => {
  // 2026-10-31: spawning it cold held every window 1.85 s while Windows loaded and scanned it.
  const { base, binaryRoot } = startupFixture(t, FAKE_SERVICE);
  const profile = path.join(base, "profile");
  const logger = { info() {}, warn() {}, error() {} };
  const warmed = [];
  const { warmProgram } = require("../electron/off-thread-run.cjs");
  const host = new HeadlessHost({ app: { getPath: () => profile, isPackaged: false }, logger, sourceRoot: base, binaryRoot,
    warm: async (file, args) => {
      const tokens = path.join(profile, "headless", "aiTemp", "headless-control");
      warmed.push({ file, args, started: Boolean(host.child), tokens: fs.existsSync(tokens) ? fs.readdirSync(tokens).length : 0 });
      await warmProgram(file, args);
    } });
  try {
    await host.ensureStarted();
    assert.equal(warmed.length, 1, "warmed once");
    assert.equal(path.dirname(warmed[0].file), path.join(binaryRoot, "coding-tools"));
    assert.deepEqual({ ...warmed[0], file: undefined }, { file: undefined, args: ["--version"], started: false, tokens: 0 },
      "with an argument it exits on, before the service or its token exists");
    assert.equal((await host.request("/api/v1/anything")).ok, true, "the service then starts as before");
  } finally { await host.shutdown("warm-test"); }
});

test("a failed startup reports bounded sanitized stderr without exposing control credentials", async (t) => {
  const secret = "S".repeat(64);
  const source = `process.stdin.once("data", data => {
  const ui = data.toString().trim();
  const detail = "x".repeat(20000) + "\\nHEADLESS_START_FAILED The file exists. (os error 80) control_token=${secret} ui_token=" + ui + " Authorization: Bearer " + ui;
  process.stderr.write(detail, () => process.exit(1));
});`;
  const { base, binaryRoot } = startupFixture(t, source);
  const messages = [];
  const logger = { info() {}, warn: (...args) => messages.push(args), error: (...args) => messages.push(args) };
  const host = new HeadlessHost({ app: { getPath: () => path.join(base, "profile"), isPackaged: false }, logger, sourceRoot: base, binaryRoot });
  try {
    await assert.rejects(host.ensureStarted(), error => {
      assert.match(error.message, /HEADLESS_START_FAILED.*The file exists.*os error 80/);
      assert.ok(error.message.length <= 600, "diagnostics stay bounded");
      assert.match(error.message, /ui_token=\[redacted\]/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.doesNotMatch(error.message, /Bearer [A-Za-z0-9_-]{32,}/);
      return true;
    });
    assert.doesNotMatch(JSON.stringify(messages), new RegExp(secret));
  } finally { await host.shutdown("startup-error-test"); }
});

test("physical profile paths still refuse symbolic-link control files", (t) => {
  fs.mkdirSync(startupFixtureRoot, { recursive: true });
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(startupFixtureRoot, "headless-control-links-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const token = "A".repeat(43), tokenFile = path.join(base, "token.txt"), tokenLink = path.join(base, "token-link.txt");
  const descriptorFile = path.join(base, "control.json"), descriptorLink = path.join(base, "control-link.json");
  fs.writeFileSync(tokenFile, token);
  const descriptor = { schema: 1, protocol_version: 1, status: "ready", pid: process.pid, app_data_dir: base,
    endpoint: "http://127.0.0.1:12345/", token_file: tokenLink, token_sha256: require("node:crypto").createHash("sha256").update(token).digest("hex") };
  fs.writeFileSync(descriptorFile, JSON.stringify(descriptor));
  try {
    fs.symlinkSync(tokenFile, tokenLink, "file");
    fs.symlinkSync(descriptorFile, descriptorLink, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) { t.skip("file symbolic links are unavailable to this test process"); return; }
    throw error;
  }
  const host = new HeadlessHost({ app: null, logger: null, sourceRoot: base });
  assert.throws(() => host.readDescriptor(descriptorLink, base, process.pid), /regular non-linked file/);
  assert.throws(() => host.readToken(descriptor, tokenLink, base), /regular non-linked file/);
});

test("the headless control token is kept in memory only: its file is deleted once the app has read it", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "headless-token-"));
  const binaryRoot = path.join(base, "bundle");
  const binaryDir = path.join(binaryRoot, "coding-tools");
  fs.mkdirSync(binaryDir, { recursive: true });
  fs.writeFileSync(path.join(binaryDir, "package.json"), JSON.stringify({ type: "commonjs" }));
  const binary = path.join(binaryDir, `coding-tools-headless${process.platform === "win32" ? ".exe" : ""}`);
  try {
    fs.linkSync(process.execPath, binary);
  } catch {
    fs.copyFileSync(process.execPath, binary);
  }
  fs.writeFileSync(path.join(binaryDir, "serve"), FAKE_SERVICE);
  const userData = path.join(base, "user-data");
  // What a crashed run left behind: its token file, beside a file that is not a token.
  const tokenDir = path.join(userData, "headless", "aiTemp", "headless-control");
  fs.mkdirSync(tokenDir, { recursive: true });
  const hourAgo = (Date.now() - 3_600_000) / 1000;
  for (const name of ["token-1234-crashed.txt", "keep-me.txt"]) {
    fs.writeFileSync(path.join(tokenDir, name), "x".repeat(43));
    fs.utimesSync(path.join(tokenDir, name), hourAgo, hourAgo);
  }
  const saved = process.env.CODING_TOOLS_HEADLESS_BINARY;
  delete process.env.CODING_TOOLS_HEADLESS_BINARY;
  const logger = { info() {}, warn() {}, error() {} };
  const host = new HeadlessHost({ app: { getPath: () => userData, isPackaged: false }, logger, sourceRoot: base, binaryRoot });
  t.after(() => {
    if (saved !== undefined) process.env.CODING_TOOLS_HEADLESS_BINARY = saved;
    fs.rmSync(base, { recursive: true, force: true });
  });
  try {
    const control = await host.ensureStarted();
    assert.deepEqual(fs.readdirSync(tokenDir), ["keep-me.txt"], "no token file is left behind, an earlier run's included; nothing else is touched");
    assert.equal(fs.existsSync(control.tokenPath), false);
    const answer = await host.request("/api/v1/anything", null, { method: "GET" });
    assert.deepEqual(answer, { ok: true, token_file_exists: false }, "the app still talks to the service with the token it holds");
  } finally {
    await host.shutdown("test");
  }
});

test("an installed app runs the headless it shipped with; an override or a source build only for a developer", (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "headless-binary-")));
  const name = `coding-tools-headless${process.platform === "win32" ? ".exe" : ""}`;
  const put = (...parts) => { const file = path.join(base, ...parts); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "x"); return file; };
  const bundled = put("bundle", "coding-tools", name);
  const shipped = put("resources", "coding-tools", name);
  const override = put("ct-build", "rust-core", "coding-tools-headless", "target", "release", name);
  const sourceBuild = put("source", "rust-core", "target", "release", name);
  const saved = { binary: process.env.CODING_TOOLS_HEADLESS_BINARY, dev: process.env.CODING_TOOLS_DEV_HOME, resources: process.resourcesPath };
  t.after(() => {
    for (const [key, value] of [["CODING_TOOLS_HEADLESS_BINARY", saved.binary], ["CODING_TOOLS_DEV_HOME", saved.dev]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    process.resourcesPath = saved.resources;
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.resourcesPath = path.join(base, "resources");
  const logger = { info() {}, warn() {}, error() {} };
  const host = ({ packaged, bundle = true }) => new HeadlessHost({ app: { getPath: () => base, isPackaged: packaged }, logger,
    sourceRoot: path.join(base, "source"), binaryRoot: bundle ? path.join(base, "bundle") : null });
  const pick = (options) => { const { source, file, ignoredOverride } = host(options).binarySelection(); return { source, file, ignoredOverride }; };

  // As found on 2026-10-15: the installed app launched with the variable pointing at a build folder.
  process.env.CODING_TOOLS_HEADLESS_BINARY = override;
  delete process.env.CODING_TOOLS_DEV_HOME;
  assert.deepEqual(pick({ packaged: true }), { source: "bundle", file: bundled, ignoredOverride: true }, "its installed backend bundle's copy");
  assert.deepEqual(pick({ packaged: true, bundle: false }), { source: "packaged", file: shipped, ignoredOverride: true }, "else its resources' copy");
  fs.rmSync(shipped);
  assert.throws(() => host({ packaged: true, bundle: false }).binarySelection(), /unavailable/, "never a source build when packaged");

  process.env.CODING_TOOLS_DEV_HOME = path.join(base, "dev-home");
  assert.deepEqual(pick({ packaged: true }), { source: "override", file: override, ignoredOverride: false }, "a dev profile may point it anywhere");
  delete process.env.CODING_TOOLS_DEV_HOME;
  assert.deepEqual(pick({ packaged: false }), { source: "override", file: override, ignoredOverride: false }, "so may an unpackaged app");
  delete process.env.CODING_TOOLS_HEADLESS_BINARY;
  assert.deepEqual(pick({ packaged: false, bundle: false }), { source: "source", file: sourceBuild, ignoredOverride: false }, "and it falls back to the source tree");
});

test("stale token files are removed before a start: only older token-*.txt files, never the current one or anything else", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "headless-stale-tokens-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const hourAgo = (Date.now() - 3_600_000) / 1000;
  const make = (name, { old = true, folder = false } = {}) => {
    const file = path.join(directory, name);
    if (folder) fs.mkdirSync(file); else fs.writeFileSync(file, "x".repeat(43));
    if (old) fs.utimesSync(file, hourAgo, hourAgo);
    return file;
  };
  make("token-111-crashed.txt");
  make("token-222-killed.txt");
  const current = make("token-333-current.txt");
  make("token-444-starting.txt", { old: false });
  for (const name of ["notes.txt", "token-555.log", "control-666.json", "mytoken-777.txt", "token-.txt", "TOKEN-888.TXT.bak"]) make(name);
  make("token-999-folder.txt", { folder: true });

  removeStaleTokenFiles(directory, { keep: current, before: Date.now() - 60_000 });
  assert.deepEqual(fs.readdirSync(directory).sort(), [
    "TOKEN-888.TXT.bak", "control-666.json", "mytoken-777.txt", "notes.txt", "token-.txt", "token-333-current.txt",
    "token-444-starting.txt", "token-555.log", "token-999-folder.txt",
  ]);
  assert.doesNotThrow(() => removeStaleTokenFiles(path.join(directory, "missing"), { before: Date.now() }), "a missing folder is not an error");
});
