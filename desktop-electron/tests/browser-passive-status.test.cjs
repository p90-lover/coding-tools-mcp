const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { BrowserHost } = require("../electron/browser-host.cjs");
const savedUrl = "https://chatgpt.com/c/0f8e2a5c-6b1d-4c3e-9a7b-1d2e3f4a5b6c";

function authFixture(url = savedUrl) {
  const loads = [];
  const host = Object.assign(Object.defineProperty(Object.create(BrowserHost.prototype), "activeTraceId", { value: null, writable: true }), {
    state: { authenticated: true }, partition: "persist:one", activeTraceId: null, manualOperation: null, authView: null,
    logger: { info() {}, warn() {}, error() {} },
    view: { webContents: { getURL: () => url, isDestroyed: () => false,
      executeJavaScript: async () => ({ url, composer: true, temporary: false, savedHome: url === "https://chatgpt.com/",
        sessionAuthenticated: true, readyState: "complete" }),
      loadURL: async target => loads.push(target),
    } },
    setState(patch) { this.state = { ...this.state, ...patch }; }, snapshot() { return this.state; },
    withManualOperation: async (_name, action) => action(),
  });
  return { host, loads };
}

test("a verified saved ChatGPT conversation stays signed in without navigating", async () => {
  const { host, loads } = authFixture();
  const state = await host.probeAuthentication();
  assert.equal(state.authenticated, true);
  assert.equal(state.status, "ready");
  assert.equal(state.url, savedUrl);
  assert.deepEqual(loads, []);
});

test("refreshing saved-session authentication never replaces the user's conversation with home", async () => {
  const { host, loads } = authFixture();
  const state = await host.refreshAuthentication();
  assert.equal(state.authenticated, true);
  assert.deepEqual(loads, []);
});

test("a late authentication probe cannot write another account's state after switching pages", async () => {
  const { host } = authFixture("https://chatgpt.com/");
  let finish;
  host.view.webContents.executeJavaScript = () => new Promise(resolve => { finish = resolve; });
  const pending = host.probeAuthentication();
  host.partition = "persist:two";
  host.view = { webContents: { getURL: () => "https://chatgpt.com/", isDestroyed: () => false } };
  host.state = { authenticated: false, status: "signed-out", url: "https://chatgpt.com/" };
  finish({ url: "https://chatgpt.com/", savedHome: true, composer: true, sessionAuthenticated: true, readyState: "complete" });
  await pending;
  assert.equal(host.state.authenticated, false);
  assert.equal(host.state.status, "signed-out");
});

for (const change of ["turn", "manual", "account", "document"]) test(`delayed security recovery does not reload after ${change} ownership changes`, async () => {
  const { host, loads } = authFixture("https://chatgpt.com/");
  host.cloudflareChallengeRecoveryDelayMs = 1;
  host.cloudflareChallengeRecoverySettleMs = 0;
  host.cloudflareChallengeRecoveryArmed = true;
  const state = { ...host.state };
  const pending = host.reloadHomeAfterCloudflareChallenge();
  if (change === "turn") host.activeTraceId = "new-task";
  if (change === "manual") host.manualOperation = "session inspection";
  if (change === "account") { host.partition = "persist:two"; host.view = { webContents: {} }; }
  if (change === "document") host.view.webContents.getURL = () => savedUrl;
  await pending;
  assert.deepEqual(loads, []);
  assert.deepEqual(host.state, state, "abandoned recovery cannot leave a false loading status");
});

for (const matches of [false, true]) test(`security recovery ${matches ? "confirms its challenged endpoint" : "does not mistake another healthy endpoint for recovery"}`, async () => {
  const { host, loads } = authFixture("https://chatgpt.com/");
  host.view.webContents.id = 42;
  host.cloudflareChallengeRecoveryArmed = true;
  host.cloudflareChallengeRecoveryDelayMs = 0;
  host.cloudflareChallengeRecoverySettleMs = 0;
  const errors = [];
  host.logger.error = (_event, detail) => errors.push(detail.message);
  host.view.webContents.loadURL = async url => {
    loads.push(url);
    host.handleChatGptBackendResponse({ webContentsId: 42, statusCode: 200,
      url: `https://chatgpt.com/backend-api/${matches ? "subscriptions" : "models"}` });
  };
  const challenge = { webContentsId: 42, statusCode: 403, url: "https://chatgpt.com/backend-api/subscriptions",
    responseHeaders: { "cf-mitigated": ["challenge"] } };
  host.handleChatGptBackendResponse(challenge);
  await host.cloudflareChallengeRecovery;
  assert.equal(errors.length, matches ? 0 : 1);
  host.handleChatGptBackendResponse(challenge);
  await host.cloudflareChallengeRecovery;
  assert.equal(loads.length, 1, "the same document never enters a reload loop");
});

test("only a fresh external document rearms one security recovery, never its own reload", () => {
  const { host } = authFixture("https://chatgpt.com/");
  const contents = Object.assign(new EventEmitter(), host.view.webContents, { setWindowOpenHandler() {} });
  host.view = { webContents: contents };
  host.armHomeNavigationTimeout = () => {};
  host.bindWebContents(contents);
  host.cloudflareChallengeRecoveryArmed = false;
  host.cloudflareChallengeRecovery = Promise.resolve();
  contents.emit("did-start-navigation", {}, "https://chatgpt.com/", false, true);
  assert.equal(host.cloudflareChallengeRecoveryArmed, false);
  host.cloudflareChallengeRecovery = null;
  contents.emit("did-start-navigation", {}, savedUrl, true, true);
  assert.equal(host.cloudflareChallengeRecoveryArmed, false, "an SPA route does not reset the document budget");
  contents.emit("did-start-navigation", {}, savedUrl, false, true);
  assert.equal(host.cloudflareChallengeRecoveryArmed, true);
});

test("healthy requests beside a blocked endpoint do not rearm an automatic reload loop", () => {
  const { host } = authFixture("https://chatgpt.com/");
  host.view.webContents.id = 42;
  host.cloudflareChallengeRecoveryArmed = false;
  assert.equal(host.handleChatGptBackendResponse({ webContentsId: 42, statusCode: 200,
    url: "https://chatgpt.com/backend-api/models", responseHeaders: { "content-type": ["application/json"] } }), false);
  assert.equal(host.cloudflareChallengeRecoveryArmed, false);
});
