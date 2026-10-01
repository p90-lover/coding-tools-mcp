"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  BACKEND_MODULES,
  MANIFEST_NAME,
  READY_MARKER,
  SCHEMA_VERSION,
  createBackendBundles,
} = require("../electron/backend-bundle.cjs");

const electronRoot = path.join(__dirname, "..", "electron");

function temporary(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

// A minimal bundle built from the real backend modules plus a stub app-handler host.
function writeBundle(root, id, { tamper = false } = {}) {
  const files = {};
  const put = (rel, content) => {
    const target = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    files[rel] = crypto.createHash("sha256").update(content).digest("hex");
  };
  for (const name of BACKEND_MODULES) put(`electron/${name}`, fs.readFileSync(path.join(electronRoot, name)));
  put("vendor/tools/antigravity-cli.json", fs.readFileSync(path.join(__dirname, "..", "vendor", "tools", "antigravity-cli.json")));
  put("app-handler/host.cjs", `module.exports = { createCodingToolsAppsHost: () => ({ bundle: ${JSON.stringify(id)} }) };\n`);
  fs.writeFileSync(path.join(root, MANIFEST_NAME), JSON.stringify({ schemaVersion: SCHEMA_VERSION, id, builtAt: new Date().toISOString(), files }));
  if (tamper) fs.appendFileSync(path.join(root, "app-handler", "host.cjs"), "// changed after hashing\n");
  return root;
}

function bundles(userDataRoot, extra = {}) {
  return createBackendBundles({
    userDataRoot,
    builtin: { codeRoot: path.join(__dirname, ".."), appHandlerRoot: null, resourcesRoot: null },
    installId: "install-1",
    pollMs: 50,
    ...extra,
  });
}

test("with no bundle the installer's backend is used", () => {
  const manager = bundles(temporary("backend-user"));
  assert.equal(manager.current().source, "builtin");
});

test("an installed bundle becomes the backend and its modules load from the bundle", () => {
  const userData = temporary("backend-user");
  const manager = bundles(userData);
  const manifest = manager.install(writeBundle(temporary("backend-src"), "b-1"));
  assert.equal(manifest.id, "b-1");
  const current = manager.current();
  assert.equal(current.source, "bundle");
  assert.equal(current.id, "b-1");
  for (const name of BACKEND_MODULES) {
    const loaded = manager.requireModule(current, name);
    assert.ok(loaded && typeof loaded === "object", `${name} loads standalone from the bundle`);
  }
  const { HeadlessHost } = manager.requireModule(current, "headless-host.cjs");
  assert.notEqual(HeadlessHost, require("../electron/headless-host.cjs").HeadlessHost, "a separate copy, not the installed one");
  assert.throws(() => manager.requireModule(current, "main.cjs"), /Not a backend module/);
});

test("a tampered bundle is refused and the current backend stays", () => {
  const manager = bundles(temporary("backend-user"));
  assert.throws(() => manager.install(writeBundle(temporary("backend-src"), "bad", { tamper: true })), /does not match its hash/);
  assert.equal(manager.current().source, "builtin");
});

test("an unusable active bundle falls back to the installer's backend", () => {
  const userData = temporary("backend-user");
  const manager = bundles(userData);
  manager.install(writeBundle(temporary("backend-src"), "b-2"));
  fs.rmSync(path.join(userData, "backend", "b-2", MANIFEST_NAME));
  assert.equal(manager.current().source, "builtin");
});

test("a fresh install takes over from bundles deployed before it", () => {
  const userData = temporary("backend-user");
  bundles(userData).install(writeBundle(temporary("backend-src"), "b-3"));
  assert.equal(bundles(userData).current().id, "b-3", "same install keeps the deployed bundle");
  assert.equal(bundles(userData, { installId: "install-2" }).current().source, "builtin");
});

test("a deployed bundle is installed from incoming once READY exists, then handed to the restart hook", async () => {
  const userData = temporary("backend-user");
  const manager = bundles(userData);
  const incoming = path.join(manager.incomingRoot, "b-4");
  writeBundle(incoming, "b-4");
  const installed = [];
  manager.watchIncoming(async (manifest) => { installed.push(manifest.id); });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(installed, [], "nothing happens before the READY marker");
    fs.writeFileSync(path.join(incoming, READY_MARKER), "now\n");
    for (let i = 0; i < 40 && !installed.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(installed, ["b-4"]);
    assert.equal(manager.current().id, "b-4");
    assert.equal(fs.existsSync(incoming), false, "the incoming copy is cleaned up");
  } finally {
    manager.stopWatching();
  }
});
