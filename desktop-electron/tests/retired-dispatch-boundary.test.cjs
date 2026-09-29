"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { actUpstream } = require("../electron/upstream-actions.cjs");

const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
const registration = main.slice(main.indexOf("function registerIpc("), main.indexOf("async function requestQuit()"));
const catalog = registration.slice(registration.indexOf('handle("coding-tools:tools:catalog"'), registration.indexOf('handle("coding-tools:tools:call"'));
const call = registration.slice(registration.indexOf('handle("coding-tools:tools:call"'), registration.indexOf('handle("coding-tools:execution:read"'));

test("retired plane is absent from Electron catalog and dispatch while apps and headless tools remain", () => {
  assert.doesNotMatch(registration, /createFiveStackControlPlane|createOrchestrationHeadlessBridge/);
  assert.doesNotMatch(catalog, /mergeCatalog|fiveStackControlPlane/);
  assert.match(catalog, /codingTools\.toolsCatalog/);
  assert.match(catalog, /mergeAppsCatalog/);
  assert.doesNotMatch(call, /fiveStackControlPlane|plane\.value\.callTool/);
  assert.match(call, /appsMcp\.callTool/);
  assert.match(call, /codingTools\.toolsCall/);
  assert.match(call, /Retired Coding Tools tool/);
  assert.match(registration, /codingTools\.nativeCodexStatus/);
});

test("retired direct upstream actions refuse before any transport", async () => {
  let requests = 0;
  for (const toolId of ["paseo", "anneal", "codex-router", "commandcode-proxy"]) {
    await assert.rejects(
      actUpstream({ toolId, op: "start", endpoint: "http://127.0.0.1:1/" }, {
        fetchImpl: () => { requests++; throw new Error("network reached"); },
        webSocketImpl: class { constructor() { requests++; throw new Error("socket reached"); } },
      }),
      /retired/i,
    );
  }
  assert.equal(requests, 0);
});
