"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const https = require("node:https");
const upstream = require("../electron/upstream-tools.cjs");
const original = require("../electron/original-ui.cjs");

test("retired upstream tools reject every entry before probe, spawn, service, or open", async () => {
  const calls = [];
  const request = http.request;
  const secureRequest = https.request;
  http.request = () => { calls.push("http"); throw new Error("unexpected probe"); };
  https.request = () => { calls.push("https"); throw new Error("unexpected probe"); };
  try {
    const controller = upstream.createUpstreamToolController({
      env: {},
      spawnProcess: () => { calls.push("spawn"); throw new Error("unexpected spawn"); },
      openExternal: () => { calls.push("open"); },
      externalServices: {
        inspect: () => { calls.push("inspect"); },
        start: () => { calls.push("start"); },
        stop: () => { calls.push("stop"); },
        restart: () => { calls.push("restart"); },
        configure: () => { calls.push("configure"); },
        snapshot: () => { calls.push("snapshot"); return { services: [] }; },
      },
    });
    assert.deepEqual(upstream.TOOL_IDS, []);
    assert.deepEqual(controller.snapshot().tools, []);
    for (const id of ["paseo", "anneal"]) {
      assert.throws(() => controller.setEndpoint(id, "http://127.0.0.1:1/"), /Unknown upstream tool/);
      for (const method of ["inspect", "start", "stop", "restart", "openEmbeddedTool", "openExternalTool"]) {
        await assert.rejects(controller[method](id), /Unknown upstream tool/);
      }
    }
    assert.deepEqual(calls, []);
    controller.dispose();
    const unmanaged = upstream.createUpstreamToolController({
      env: {},
      spawnProcess: () => { calls.push("spawn"); throw new Error("unexpected spawn"); },
      openExternal: () => { calls.push("open"); },
    });
    for (const id of ["paseo", "anneal"]) {
      await assert.rejects(unmanaged.inspect(id), /Unknown upstream tool/);
      await assert.rejects(unmanaged.start(id), /Unknown upstream tool/);
      await assert.rejects(unmanaged.openExternalTool(id), /Unknown upstream tool/);
    }
    assert.deepEqual(calls, []);
    unmanaged.dispose();
  } finally {
    http.request = request;
    https.request = secureRequest;
  }
});

test("original UI retains CPA but rejects retired IDs before service or open", async () => {
  const calls = [];
  const controller = original.createOriginalUiController({
    longRun: false,
    openExternal: () => { calls.push("open"); },
    spawnProcess: () => { calls.push("spawn"); },
    externalServices: {
      snapshot: () => { calls.push("snapshot"); return { services: [{ id: "cpa", endpoint: "http://127.0.0.1:8317/", status: "ready" }] }; },
      inspect: (id) => { calls.push(`inspect:${id}`); },
      start: (id) => { calls.push(`start:${id}`); },
      stop: (id) => { calls.push(`stop:${id}`); },
      restart: (id) => { calls.push(`restart:${id}`); },
      cpaConnection: () => ({ managementKey: "test-key" }),
    },
  });
  assert.deepEqual(original.TOOL_IDS, ["cpa"]);
  assert.deepEqual(original.IFRAME_TOOL_IDS, ["cpa"]);
  assert.deepEqual(controller.snapshot().tools.map((tool) => tool.id), ["cpa"]);
  calls.length = 0;
  for (const id of ["paseo", "anneal", "codex-router"]) {
    assert.throws(() => original.loadManifest(id), /Unknown original UI/);
    for (const method of ["inspect", "start", "stop", "restart", "openEmbedded", "openExternalTool"]) {
      await assert.rejects(controller[method](id), /Unknown original UI/);
    }
  }
  assert.deepEqual(calls, []);
  const cpa = await controller.inspect("cpa");
  assert.equal(cpa.id, "cpa");
  assert.deepEqual(calls, ["inspect:cpa", "snapshot"]);
  assert.equal(controller.copyCpaManagementKey({ writeText(value) { assert.equal(value, "test-key"); } }).copied, true);
  controller.dispose();
});
