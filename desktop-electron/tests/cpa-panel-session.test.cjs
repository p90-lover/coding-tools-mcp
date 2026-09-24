"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const test = require("node:test");
const { installCpaPanelSession } = require("../electron/cpa-panel-session.cjs");

test("CPA panel auto-login seeds no real secret and only authenticates its own management requests", async () => {
  const storage = new Map();
  const sessionStorage = new Map();
  let reloads = 0;
  let beforeHeaders;
  let credentialReads = 0;
  let connection = { baseUrl: "http://127.0.0.1:8317", managementKey: "actual-management-secret" };
  const logs = [];
  const webContents = new EventEmitter();
  webContents.id = 12;
  webContents.mainFrame = {};
  webContents.isDestroyed = () => false;
  webContents.session = { webRequest: { onBeforeSendHeaders(_filter, callback) { beforeHeaders = callback; } } };
  const frame = {
    url: "http://127.0.0.1:8317/management.html#/oauth",
    top: webContents.mainFrame,
    isDestroyed: () => false,
    reload() { reloads += 1; },
    async executeJavaScript(script) {
      assert.doesNotMatch(script, /actual-management-secret/);
      return vm.runInNewContext(script, {
        location: { origin: "http://127.0.0.1:8317", pathname: "/management.html", reload() { reloads += 1; } },
        localStorage: { setItem: (name, value) => storage.set(name, value) },
        sessionStorage: { getItem: (name) => sessionStorage.get(name), setItem: (name, value) => sessionStorage.set(name, value) },
      });
    },
  };
  installCpaPanelSession({
    webContents,
    webFrameMain: { fromId: () => frame },
    getConnection() {
      credentialReads += 1;
      return connection;
    },
    logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
  });
  const loaded = webContents.listeners("did-frame-finish-load")[0];
  await loaded({}, false, 1, 2);
  await loaded({}, false, 1, 2);
  assert.equal(reloads, 1);
  const marker = JSON.parse(storage.get("cli-proxy-auth")).state.managementKey;
  assert.match(marker, /^coding-tools-/);
  assert.equal(storage.get("isLoggedIn"), "true");
  assert.equal(JSON.parse(storage.get("managementKey")), marker);
  assert.equal(JSON.parse(storage.get("apiBase")), "http://127.0.0.1:8317");
  assert.equal(credentialReads, 0);
  assert.doesNotMatch(JSON.stringify([...storage, ...sessionStorage, logs]), /actual-management-secret/);

  const request = { frame, webContentsId: 12, requestHeaders: { Authorization: `Bearer ${marker}` } };
  let result;
  beforeHeaders(request, (value) => { result = value; });
  assert.equal(result.requestHeaders.Authorization, "Bearer actual-management-secret");
  assert.equal(request.requestHeaders.Authorization, `Bearer ${marker}`);
  for (const rejected of [
    { ...request, webContentsId: 13 },
    { ...request, frame: { ...frame, url: "http://127.0.0.1:8317/untrusted.html" } },
    { ...request, frame: { ...frame, url: "https://example.com/management.html" } },
    { ...request, frame: { ...frame, top: {} } },
    { ...request, frame: null },
    { ...request, requestHeaders: { Authorization: "Bearer unrelated" } },
  ]) {
    beforeHeaders(rejected, (value) => { result = value; });
    assert.notEqual(result.requestHeaders.Authorization, "Bearer actual-management-secret");
  }
  assert.equal(credentialReads, 1);
  connection = null;
  beforeHeaders(request, (value) => { result = value; });
  assert.equal(result.cancel, true);
  connection = { baseUrl: "http://127.0.0.1:8317", managementKey: "rotated-management-secret" };
  beforeHeaders(request, (value) => { result = value; });
  assert.equal(result.requestHeaders.Authorization, "Bearer rotated-management-secret");
  frame.url = "https://example.com/management.html";
  await loaded({}, false, 1, 2);
  assert.equal(reloads, 1);
  webContents.emit("destroyed");
  assert.equal(beforeHeaders, null);
});
