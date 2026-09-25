"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const vm = require("node:vm");

const { installCpaPanelSession } = require("../electron/cpa-panel-session.cjs");

const ORIGIN = "http://127.0.0.1:8317";
const SECRET = "real-management-secret";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function fixture() {
  const calls = [];
  const logs = [];
  const frames = new Map();
  const mainFrame = {};
  const localStorage = storage();
  const sessionStorage = storage();
  let destroyed = false;
  let connection = { baseUrl: ORIGIN, managementKey: SECRET };
  let headerListener;
  let requestFilter;
  const webContents = new EventEmitter();
  Object.assign(webContents, {
    id: 71,
    mainFrame,
    isDestroyed: () => destroyed,
    session: {
      webRequest: {
        onBeforeSendHeaders(filter, listener) {
          calls.push({ filter, listener });
          requestFilter = filter;
          headerListener = listener;
        },
      },
    },
  });
  const webFrameMain = { fromId: (processId, routingId) => frames.get(`${processId}:${routingId}`) };
  const logger = {
    info: (...args) => logs.push(args),
    warn: (...args) => logs.push(args),
  };
  const frame = {
    url: `${ORIGIN}/management.html`,
    top: mainFrame,
    reloads: 0,
    scripts: [],
    isDestroyed: () => false,
    async executeJavaScript(script) {
      this.scripts.push(script);
      const location = new URL(this.url);
      location.reload = () => { this.reloads += 1; };
      return vm.runInNewContext(script, { location, localStorage, sessionStorage });
    },
    reload() { return true; },
  };
  frames.set("5:9", frame);
  const install = (origin = ORIGIN) => installCpaPanelSession({
    webContents,
    webFrameMain,
    getConnection: () => connection,
    logger,
    origin,
  });
  const request = (overrides = {}) => new Promise((resolve) => {
    headerListener({
      webContentsId: 71,
      frame,
      requestHeaders: { authorization: `Bearer ${sessionStorage.getItem("coding-tools-cpa-session")}` },
      ...overrides,
    }, resolve);
  });
  return {
    webContents, mainFrame, frame, frames, localStorage, sessionStorage,
    calls, logs, install, request,
    get requestFilter() { return requestFilter; },
    setConnection(value) { connection = value; },
    destroy() { destroyed = true; webContents.emit("destroyed"); },
  };
}

test("managed iframe seeds one auto-login navigation and only its management request gets the real key", async () => {
  const f = fixture();
  f.install();
  assert.deepEqual(f.requestFilter, { urls: [`${ORIGIN}/v0/management/*`] });

  await f.webContents.listeners("did-frame-finish-load")[0]({}, false, 5, 9);
  const marker = f.sessionStorage.getItem("coding-tools-cpa-session");
  assert.match(marker, /^coding-tools-[a-f0-9]{48}$/);
  assert.equal(JSON.parse(f.localStorage.getItem("cli-proxy-auth")).state.managementKey, marker);
  assert.equal(JSON.parse(f.localStorage.getItem("managementKey")), marker);
  assert.equal(f.localStorage.getItem("isLoggedIn"), "true");
  assert.equal(f.frame.reloads, 1);
  assert.equal(f.frame.scripts.join("").includes(SECRET), false);
  assert.equal(JSON.stringify(f.logs).includes(SECRET), false);

  const result = await f.request();
  assert.deepEqual(result, { requestHeaders: { authorization: `Bearer ${SECRET}` } });
  await f.webContents.listeners("did-frame-finish-load")[0]({}, false, 5, 9);
  assert.equal(f.frame.reloads, 1);
});

test("only the exact direct managed iframe and webContents can seed or exchange credentials", async () => {
  const f = fixture();
  f.install();
  const handler = f.webContents.listeners("did-frame-finish-load")[0];

  await handler({}, true, 5, 9);
  assert.equal(f.frame.reloads, 0);
  for (const url of [
    "http://evil.example/management.html",
    `${ORIGIN}/other.html`,
    "http://localhost:8317/management.html",
  ]) {
    f.frame.url = url;
    await handler({}, false, 5, 9);
    assert.equal(f.frame.reloads, 0);
    assert.deepEqual(await f.request({ requestHeaders: { Authorization: "Bearer coding-tools-fake" } }), {
      requestHeaders: { Authorization: "Bearer coding-tools-fake" },
    });
  }
  f.frame.url = `${ORIGIN}/management.html`;
  f.frame.top = {};
  await handler({}, false, 5, 9);
  assert.equal(f.frame.reloads, 0);
  f.frame.top = f.mainFrame;
  await handler({}, false, 5, 9);
  assert.equal(f.frame.reloads, 1);
  assert.deepEqual(await f.request({ webContentsId: 72 }), {
    requestHeaders: { authorization: `Bearer ${f.sessionStorage.getItem("coding-tools-cpa-session")}` },
  });
});

test("missing or mismatched main-process connection cancels marker requests without exposing the key", async () => {
  const f = fixture();
  f.install();
  await f.webContents.listeners("did-frame-finish-load")[0]({}, false, 5, 9);

  f.setConnection({ baseUrl: "http://localhost:8317", managementKey: SECRET });
  assert.deepEqual(await f.request(), { cancel: true });
  f.setConnection({ baseUrl: ORIGIN, managementKey: "" });
  assert.deepEqual(await f.request(), { cancel: true });
  f.setConnection(null);
  assert.deepEqual(await f.request(), { cancel: true });
  assert.deepEqual(await f.request({ requestHeaders: { Authorization: "Bearer some-other-token" } }), {
    requestHeaders: { Authorization: "Bearer some-other-token" },
  });
  assert.equal(JSON.stringify(f.logs).includes(SECRET), false);
});

test("opt-in auth probe distinguishes missing frame from a managed request without logging credentials", async () => {
  const previous = process.env.CODING_TOOLS_CPA_AUTH_DIAG;
  process.env.CODING_TOOLS_CPA_AUTH_DIAG = "1";
  try {
    const f = fixture();
    f.install();
    await f.webContents.listeners("did-frame-finish-load")[0]({}, false, 5, 9);
    const marker = f.sessionStorage.getItem("coding-tools-cpa-session");
    const url = `${ORIGIN}/v0/management/config`;

    await f.request({ url, frame: null });
    await f.request({ url });
    const probes = f.logs.filter(([event]) => event === "cpa.panel_auth_probe").map(([, detail]) => detail);
    assert.deepEqual(probes, [
      { webContentsMatch: true, framePresent: false, frameManaged: false,
        frameTopSame: false, frameTopTreeSame: false, markerMatches: true },
      { webContentsMatch: true, framePresent: true, frameManaged: true,
        frameTopSame: true, frameTopTreeSame: false, markerMatches: true },
    ]);
    assert.equal(JSON.stringify(f.logs).includes(SECRET), false);
    assert.equal(JSON.stringify(f.logs).includes(marker), false);
  } finally {
    if (previous === undefined) delete process.env.CODING_TOOLS_CPA_AUTH_DIAG;
    else process.env.CODING_TOOLS_CPA_AUTH_DIAG = previous;
  }
});

test("non-loopback origins are rejected and destroying the host removes the request hook", () => {
  for (const origin of [
    "http://localhost:8317",
    "http://127.0.0.1:8317/path",
    "https://127.0.0.1:8317",
    "http://attacker:secret@127.0.0.1:8317",
  ]) {
    assert.throws(() => fixture().install(origin), /loopback HTTP origin/);
  }
  const f = fixture();
  f.install();
  f.destroy();
  assert.equal(f.calls.at(-1).listener, null);
  assert.deepEqual(f.calls.at(-1).filter, { urls: [`${ORIGIN}/v0/management/*`] });
});
