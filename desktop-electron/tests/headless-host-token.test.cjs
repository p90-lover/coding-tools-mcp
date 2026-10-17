"use strict";

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

test("the headless control token is kept in memory only: its file is deleted once the app has read it", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "headless-token-"));
  const binaryRoot = path.join(base, "bundle");
  const binaryDir = path.join(binaryRoot, "coding-tools");
  fs.mkdirSync(binaryDir, { recursive: true });
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
