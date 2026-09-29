const assert = require("node:assert/strict");
const test = require("node:test");
const { buildLoopbackMesh, loopbackMeshEnvironment } = require("../electron/loopback-mesh.cjs");
const { peerEnvironmentFor } = require("../electron/five-stack-cross-use.cjs");

test("Paseo and Anneal use CPA without a standalone CommandCode route", () => {
  const mesh = buildLoopbackMesh();
  const cpa = peerEnvironmentFor("paseo", { cpaProxyApiKey: "test-cpa-key" });
  const paseoMesh = loopbackMeshEnvironment(mesh, {
    targetId: "paseo",
  });
  const paseo = { ...cpa, ...paseoMesh };
  assert.equal(paseo.OPENAI_BASE_URL, "http://127.0.0.1:8317/v1");
  assert.equal(paseo.OPENAI_API_KEY, "test-cpa-key");
  assert.equal(paseo.CODING_TOOLS_CPA_PROXY_API_KEY, "test-cpa-key");

  const anneal = peerEnvironmentFor("anneal", { cpaProxyApiKey: "test-cpa-key" });
  assert.equal(anneal.OPENAI_BASE_URL, "http://127.0.0.1:8317/v1");
  assert.equal(anneal.OPENAI_API_KEY, "test-cpa-key");
  assert.equal(JSON.stringify(mesh).includes("test-cpa-key"), false);
});
