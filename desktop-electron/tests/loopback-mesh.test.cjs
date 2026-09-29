"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildLoopbackMesh, loopbackMeshEnvironment, persistLoopbackMesh } = require("../electron/loopback-mesh.cjs");
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
