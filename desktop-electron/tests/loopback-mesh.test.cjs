"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildLoopbackMesh, loopbackMeshEnvironment, persistLoopbackMesh, preloadLoopbackMesh } = require("../electron/loopback-mesh.cjs");
const { createExternalServicesController } = require("../electron/external-services.cjs");
const { createManagedExternalServicesController } = require("../electron/managed-external-services.cjs");

function temporaryDirectory() {
  const scratch = path.resolve(__dirname, "..", "..", "aiTemp");
  fs.mkdirSync(scratch, { recursive: true });
  return fs.mkdtempSync(path.join(scratch, "coding-tools-loopback-mesh-"));
}

test("mesh contains CPA, Paseo and Anneal loopbacks only", () => {
  const mesh = buildLoopbackMesh();
  assert.deepEqual(Object.keys(mesh.services), ["cpa", "paseo", "anneal"]);
  assert.equal(mesh.services.cpa.openaiBaseUrl, "http://127.0.0.1:8317/v1");
  assert.equal(mesh.services.paseo.executionUrl, "ws://127.0.0.1:6768/ws");
  assert.equal(mesh.services.anneal.url, "http://127.0.0.1:5173");
  const env = loopbackMeshEnvironment(mesh, { targetId: "paseo" });
  assert.equal(env.CODING_TOOLS_CPA_URL, "http://127.0.0.1:8317");
  assert.equal(env.CODING_TOOLS_COMMANDCODE_URL, undefined);
});

test("Anneal's task endpoint does not replace its UI origin", () => {
  const mesh = buildLoopbackMesh([
    { id: "anneal", endpoint: "http://127.0.0.1:3000/", executionEndpoint: "http://127.0.0.1:3000/" },
    { id: "paseo", endpoint: "http://127.0.0.1:6769/", executionEndpoint: "ws://127.0.0.1:6769/ws" },
  ]);
  assert.equal(mesh.services.anneal.url, "http://127.0.0.1:5173");
  assert.equal(mesh.services.anneal.executionUrl, "http://127.0.0.1:3000/");
  assert.equal(mesh.services.paseo.url, "http://127.0.0.1:6769");
  assert.throws(() => buildLoopbackMesh([{ id: "cpa", endpoint: "https://cpa.example/" }]), /loopback/i);
});

test("persisted mesh excludes credentials", () => {
  const filePath = path.join(temporaryDirectory(), "loopback-mesh.json");
  persistLoopbackMesh(filePath, buildLoopbackMesh());
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(Object.keys(parsed.services), ["cpa", "paseo", "anneal"]);
  assert.throws(() => persistLoopbackMesh(filePath, { ...parsed, leak: "proxyApiKey" }), /secrets/i);
});

test("an unchanged mesh is not rewritten or checked synchronously, a changed or deleted one is written", async () => {
  // Seen live 2026-10-31: the existsSync of an unchanged mesh, every 20 s keep-alive, froze every
  // window for up to 10 s on the app's busy hard disk.
  const filePath = path.join(temporaryDirectory(), "loopback-mesh.json");
  const mesh = buildLoopbackMesh([{ id: "cpa", endpoint: "http://127.0.0.1:9000" }]);
  persistLoopbackMesh(filePath, buildLoopbackMesh());
  fs.writeFileSync(filePath, "marker");
  const { existsSync, statSync } = fs;
  let blocking = 0;
  fs.existsSync = (...args) => { blocking += 1; return existsSync(...args); };
  fs.statSync = (...args) => { blocking += 1; return statSync(...args); };
  try {
    persistLoopbackMesh(filePath, buildLoopbackMesh());
    assert.equal(blocking, 0, "same content: no synchronous disk call");
  } finally {
    Object.assign(fs, { existsSync, statSync });
  }
  assert.equal(fs.readFileSync(filePath, "utf8"), "marker", "same content: no write");
  persistLoopbackMesh(filePath, mesh);
  assert.match(fs.readFileSync(filePath, "utf8"), /9000/);
  fs.rmSync(filePath);
  persistLoopbackMesh(filePath, mesh);
  for (let tries = 0; tries < 100 && !fs.existsSync(filePath); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    persistLoopbackMesh(filePath, mesh);
  }
  assert.ok(fs.existsSync(filePath), "a deleted mesh is written again by a later publish");
});

test("external and managed controllers advertise the same CPA mesh", () => {
  const directory = temporaryDirectory();
  const options = {
    filePath: path.join(directory, "external-services.json"),
    keyPath: path.join(directory, "external-services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const external = createExternalServicesController(options);
  const managed = createManagedExternalServicesController({ ...options, dataRoot: path.join(directory, "integrations") });
  try {
    for (const controller of [external, managed]) {
      const env = controller.runtimeEnvironment();
      assert.equal(env.CODING_TOOLS_CPA_URL, "http://127.0.0.1:8317");
      assert.equal(env.CODING_TOOLS_PASEO_URL, "http://127.0.0.1:6768");
      assert.equal(env.CODING_TOOLS_ANNEAL_URL, "http://127.0.0.1:5173");
      assert.equal(env.CODING_TOOLS_COMMANDCODE_URL, undefined);
      assert.equal(env.OPENAI_BASE_URL, undefined);
    }
  } finally {
    external.dispose();
    managed.dispose();
  }
});

// 0.8.107, 2026-11-10 02:06Z: the first publish after every launch rewrote an unchanged mesh,
// a flushed atomic write whose rename alone held every window 0.7 s on the hard disk.
function meshWrites(t, filePath) {
  const writes = [];
  for (const name of ["openSync", "writeFileSync", "renameSync", "fsyncSync"]) {
    const original = fs[name];
    t.mock.method(fs, name, function (target, ...args) {
      if (String(target).startsWith(filePath)) writes.push(name);
      return original.call(this, target, ...args);
    });
  }
  return writes;
}

test("an unchanged mesh read at launch is not rewritten by the first publish", async (t) => {
  const filePath = path.join(temporaryDirectory(), "loopback-mesh.json");
  const mesh = buildLoopbackMesh([{ id: "cpa", endpoint: "http://127.0.0.1:8317" }]);
  fs.writeFileSync(filePath, `${JSON.stringify(mesh, null, 2)}\n`);
  await preloadLoopbackMesh(filePath);
  const writes = meshWrites(t, filePath);
  assert.equal(persistLoopbackMesh(filePath, mesh), filePath);
  assert.deepEqual(writes, [], "the same mesh is already on disk");
  // A real change is still written at once, synchronously, before anyone can read the file.
  const changed = buildLoopbackMesh([{ id: "cpa", endpoint: "http://127.0.0.1:9317" }]);
  persistLoopbackMesh(filePath, changed);
  assert.ok(writes.length > 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), JSON.parse(JSON.stringify(changed)));
});

test("a mesh that differs on disk, or is missing, is written by the first publish", async () => {
  const mesh = buildLoopbackMesh([{ id: "cpa", endpoint: "http://127.0.0.1:8317" }]);
  const stale = path.join(temporaryDirectory(), "loopback-mesh.json");
  fs.writeFileSync(stale, `${JSON.stringify(buildLoopbackMesh(), null, 2)}\n`);
  await preloadLoopbackMesh(stale);
  persistLoopbackMesh(stale, mesh);
  assert.deepEqual(JSON.parse(fs.readFileSync(stale, "utf8")), JSON.parse(JSON.stringify(mesh)));

  const missing = path.join(temporaryDirectory(), "loopback-mesh.json");
  await preloadLoopbackMesh(missing);
  persistLoopbackMesh(missing, mesh);
  assert.deepEqual(JSON.parse(fs.readFileSync(missing, "utf8")), JSON.parse(JSON.stringify(mesh)));
});

test("a publish before the launch read finishes writes as before, and the late read does not undo it", async () => {
  const filePath = path.join(temporaryDirectory(), "loopback-mesh.json");
  fs.writeFileSync(filePath, `${JSON.stringify(buildLoopbackMesh(), null, 2)}\n`);
  const mesh = buildLoopbackMesh([{ id: "cpa", endpoint: "http://127.0.0.1:8317" }]);
  const reading = preloadLoopbackMesh(filePath);
  persistLoopbackMesh(filePath, mesh); // the read is still pending: written synchronously
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), JSON.parse(JSON.stringify(mesh)));
  await reading;
  // The read saw the old file, but the publish's record stands: publishing the old mesh writes it.
  persistLoopbackMesh(filePath, buildLoopbackMesh());
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), JSON.parse(JSON.stringify(buildLoopbackMesh())));
});
