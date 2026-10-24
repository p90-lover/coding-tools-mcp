"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const vm = require("node:vm");

const {
  installCpaPanelSession, panelStorageEntries, quotaPageScript, CPA_HELPER_KEY_STORE,
} = require("../electron/cpa-panel-session.cjs");

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

test("panel storage entries carry only the marker, including CPA Helper's raw key slot", () => {
  const marker = `coding-tools-${"b".repeat(48)}`;
  const entries = new Map(panelStorageEntries(ORIGIN, marker));
  assert.equal(CPA_HELPER_KEY_STORE, "cpaHelper.managementKey");
  assert.equal(entries.get(CPA_HELPER_KEY_STORE), marker);
  assert.deepEqual(JSON.parse(entries.get("cli-proxy-auth")), {
    state: { apiBase: ORIGIN, managementKey: marker, rememberPassword: true }, version: 0,
  });
  assert.equal(JSON.parse(entries.get("apiBase")), ORIGIN);
  assert.equal(JSON.parse(entries.get("managementKey")), marker);
  assert.equal(entries.get("isLoggedIn"), "true");
});

test("CPA Helper iframe under the managed panel gets the key only on its own API routes", async () => {
  const f = fixture();
  f.install();
  await f.webContents.listeners("did-frame-finish-load")[0]({}, false, 5, 9);
  const marker = f.sessionStorage.getItem("coding-tools-cpa-session");
  assert.equal(f.localStorage.getItem(CPA_HELPER_KEY_STORE), marker);

  const helper = {
    url: `${ORIGIN}/v0/resource/plugins/cpa-helper/index.html#overview`,
    top: f.mainFrame,
    parent: f.frame,
    isDestroyed: () => false,
  };
  const requestHeaders = { Authorization: `Bearer ${marker}` };
  const helperApi = `${ORIGIN}/v0/management/cpa-helper/usage/summary?from=1`;
  assert.deepEqual(await f.request({ frame: helper, url: helperApi, requestHeaders }), {
    requestHeaders: { Authorization: `Bearer ${SECRET}` },
  });
  for (const url of [
    `${ORIGIN}/v0/management/config`,
    `${ORIGIN}/v0/management/cpa-helper-evil/x`,
    `http://localhost:8317/v0/management/cpa-helper/usage`,
  ]) {
    assert.deepEqual(await f.request({ frame: helper, url, requestHeaders }), { requestHeaders });
  }
  for (const frame of [
    { ...helper, url: `${ORIGIN}/v0/resource/plugins/other/index.html` },
    { ...helper, parent: f.mainFrame },
    { ...helper, parent: { ...f.frame, url: `${ORIGIN}/other.html` } },
    { ...helper, parent: null },
  ]) {
    assert.deepEqual(await f.request({ frame, url: helperApi, requestHeaders }), { requestHeaders });
  }
  assert.deepEqual(await f.request({ frame: helper, url: helperApi, webContentsId: 72, requestHeaders }), {
    requestHeaders,
  });
  f.setConnection(null);
  assert.deepEqual(await f.request({ frame: helper, url: helperApi, requestHeaders }), { cancel: true });
  assert.equal(JSON.stringify(f.logs).includes(SECRET), false);
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

test("Accounts and CPA can reuse a cached launcher marker without accepting it outside the managed frame", async () => {
  const f = fixture();
  f.install();
  await f.webContents.listeners("did-frame-finish-load")[0]({}, false, 5, 9);
  const cachedAuthorization = `Bearer coding-tools-${"a".repeat(48)}`;
  const requestHeaders = { authorization: cachedAuthorization };
  assert.deepEqual(await f.request({ requestHeaders }), {
    requestHeaders: { authorization: `Bearer ${SECRET}` },
  });
  assert.deepEqual(await f.request({ webContentsId: 72, requestHeaders }), { requestHeaders });
  assert.deepEqual(await f.request({ frame: null, requestHeaders }), { requestHeaders });
  f.setConnection(null);
  assert.deepEqual(await f.request({ requestHeaders }), { cancel: true });
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


test("Cline switcher frame gets the opaque marker exchange only for its own management API", async () => {
  const f = fixture();
  f.install();
  await f.webContents.listeners("did-frame-finish-load")[0]({}, false, 5, 9);
  const marker = f.sessionStorage.getItem("coding-tools-cpa-session");
  const frame = { url: `${ORIGIN}/v0/resource/plugins/cline-pass-switcher/index.html`,
    top: f.mainFrame, parent: f.frame, isDestroyed: () => false };
  const requestHeaders = { Authorization: `Bearer ${marker}` };
  assert.deepEqual(await f.request({ frame, url: `${ORIGIN}/v0/management/cline-pass-switcher/api/accounts`, requestHeaders }), {
    requestHeaders: { Authorization: `Bearer ${SECRET}` },
  });
  for (const url of [`${ORIGIN}/v0/management/config`, `${ORIGIN}/v0/management/cpa-helper/usage`,
    `${ORIGIN}/v0/management/cline-pass-switcher-evil/api/accounts`]) {
    assert.deepEqual(await f.request({ frame, url, requestHeaders }), { requestHeaders });
  }
  assert.equal(JSON.stringify(f.logs).includes(SECRET), false);
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

test("Codex Auto Review's page gets the key on its own routes and a read-only account list, nothing else", async () => {
  const f = fixture();
  f.install();
  await f.webContents.listeners("did-frame-finish-load")[0]({}, false, 5, 9);
  const marker = f.sessionStorage.getItem("coding-tools-cpa-session");
  const frame = { url: `${ORIGIN}/v0/resource/plugins/codex-auto-review/index.html`,
    top: f.mainFrame, parent: f.frame, isDestroyed: () => false };
  const requestHeaders = { Authorization: `Bearer ${marker}` };
  const swapped = { requestHeaders: { Authorization: `Bearer ${SECRET}` } };
  assert.deepEqual(await f.request({ frame, url: `${ORIGIN}/v0/management/codex-auto-review/account`, method: "POST", requestHeaders }), swapped);
  assert.deepEqual(await f.request({ frame, url: `${ORIGIN}/v0/management/auth-files`, method: "GET", requestHeaders }), swapped);
  for (const [url, method] of [[`${ORIGIN}/v0/management/auth-files`, "POST"], [`${ORIGIN}/v0/management/auth-files/download?name=a.json`, "GET"],
    [`${ORIGIN}/v0/management/config`, "GET"], [`${ORIGIN}/v0/management/cpa-helper/usage`, "GET"],
    [`${ORIGIN}/v0/management/codex-auto-review-evil/x`, "GET"]]) {
    assert.deepEqual(await f.request({ frame, url, method, requestHeaders }), { requestHeaders }, `${method} ${url}`);
  }
  // Another plugin's page gets none of it.
  const other = { ...frame, url: `${ORIGIN}/v0/resource/plugins/other/index.html` };
  assert.deepEqual(await f.request({ frame: other, url: `${ORIGIN}/v0/management/auth-files`, method: "GET", requestHeaders }), { requestHeaders });
  assert.equal(JSON.stringify(f.logs).includes(SECRET), false);
});

test("the installed plugin's own name gets the same sign-in, and neither name reaches the other's routes", async () => {
  // Seen live: the plugin registers as codex-review-account-selector, the page never got the key,
  // and the user was asked to paste the management key.
  const f = fixture();
  f.install();
  await f.webContents.listeners("did-frame-finish-load")[0]({}, false, 5, 9);
  const marker = f.sessionStorage.getItem("coding-tools-cpa-session");
  const frame = { url: `${ORIGIN}/v0/resource/plugins/codex-review-account-selector/index.html`,
    top: f.mainFrame, parent: f.frame, isDestroyed: () => false };
  const requestHeaders = { Authorization: `Bearer ${marker}` };
  const swapped = { requestHeaders: { Authorization: `Bearer ${SECRET}` } };
  for (const [path, method] of [["settings", "GET"], ["settings", "PUT"], ["accounts", "GET"]]) {
    assert.deepEqual(await f.request({ frame, url: `${ORIGIN}/v0/management/codex-review-account-selector/${path}`, method, requestHeaders }),
      swapped, `${method} ${path}`);
  }
  assert.deepEqual(await f.request({ frame, url: `${ORIGIN}/v0/management/codex-auto-review/settings`, method: "GET", requestHeaders }),
    { requestHeaders }, "the other plugin name's routes");
  const older = { ...frame, url: `${ORIGIN}/v0/resource/plugins/codex-auto-review/index.html` };
  assert.deepEqual(await f.request({ frame: older, url: `${ORIGIN}/v0/management/codex-review-account-selector/settings`, method: "GET", requestHeaders }),
    { requestHeaders });
  const lookalike = { ...frame, url: `${ORIGIN}/v0/resource/plugins/codex-review-account-selector-x/index.html` };
  assert.deepEqual(await f.request({ frame: lookalike, url: `${ORIGIN}/v0/management/auth-files`, method: "GET", requestHeaders }),
    { requestHeaders }, "a look-alike plugin page");
});

// Just enough DOM for the quota page script: class lookups, insertion after the header, text.
class FakeNode {
  constructor(tag, className = "") {
    Object.assign(this, { tag, className, children: [], parent: null, style: {}, dataset: {}, text: "", disabled: false, clicks: 0 });
  }
  get textContent() { return [this.text, ...this.children.map((child) => child.textContent)].join(" "); }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children.forEach((child) => { child.parent = null; }); this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  after(node) { node.remove(); this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node); node.parent = this.parent; }
  get nextElementSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  querySelector(selector) {
    const name = selector.match(/^\[class\*="(.+)"\]$/)[1];
    return this.descendants().find((node) => node.className.includes(name)) ?? null;
  }
  click() { this.clicks += 1; }
}

function quotaPage({ hash = "#/quota", loaded = false, usage } = {}) {
  const marker = `coding-tools-${"c".repeat(48)}`;
  const sessionStorage = storage();
  sessionStorage.setItem("coding-tools-cpa-session", marker);
  const page = new FakeNode("main");
  const header = new FakeNode("header", "QuotaHeader-module__header___FQh-X");
  const button = new FakeNode("button", "QuotaHeader-module__primaryAction___wLlcP");
  header.append(button);
  if (loaded) header.append(new FakeNode("span", "QuotaHeader-module__metaLoaded___5XtFO"));
  page.append(header, new FakeNode("section", "Quota-module__providers"));
  const clock = { now: Date.parse("2026-10-24T08:00:00Z") };
  const fetches = [];
  const ticks = [];
  const document = Object.assign(page, {
    visibilityState: "visible",
    createElement: (tag) => new FakeNode(tag),
    addEventListener: () => {},
  });
  const context = vm.createContext({
    window: {}, document, sessionStorage, innerWidth: 900,
    location: { hash },
    Date: { now: () => clock.now, parse: Date.parse },
    setInterval: (fn) => ticks.push(fn),
    addEventListener: () => {},
    fetch: async (url, options) => {
      fetches.push({ url, authorization: options.headers.Authorization });
      return { ok: true, json: async () => usage };
    },
  });
  return {
    marker, header, button, clock, fetches, sessionStorage, context,
    run: () => vm.runInContext(quotaPageScript(marker), context),
    settle: () => new Promise((resolve) => setImmediate(resolve)),
    tick: () => ticks[0](),
  };
}

const USAGE = {
  checkedAt: "2026-10-24T08:00:00.000Z",
  accounts: [
    { name: "main key", enabled: true, limits: [
      { type: "five_hour", percentUsed: 42, resetsAt: "2026-10-24T10:30:00.000Z" },
      { type: "weekly", percentUsed: 90, resetsAt: "2026-10-27T08:00:00.000Z" },
    ] },
    { name: "spare key", enabled: true, limits: [], error: "Cline answered HTTP 401" },
    { name: "switched off", enabled: false, limits: [] },
  ],
};

test("the quota page loads every provider's quota on open, once, and again after five minutes", () => {
  const q = quotaPage({ usage: USAGE });
  assert.equal(q.run(), "started");
  assert.equal(q.run(), "running", "one script per page load");
  assert.equal(q.button.clicks, 1, "nothing was loaded, so it presses Refresh all credentials");
  q.tick();
  q.tick();
  assert.equal(q.button.clicks, 1, "not again on this visit while it is fresh");
  q.clock.now += 5 * 60e3 + 1;
  q.tick();
  assert.equal(q.button.clicks, 2, "five minutes on, the open page refreshes again");
  q.button.disabled = true;
  q.clock.now += 5 * 60e3 + 1;
  q.tick();
  assert.equal(q.button.clicks, 2, "never while the page has no credentials or is loading");
});

test("a reopened quota page that still shows loaded quota is not refreshed early, nor while hidden", () => {
  const q = quotaPage({ loaded: true, usage: USAGE });
  q.sessionStorage.setItem("coding-tools-quota-refreshed", String(q.clock.now - 60e3));
  q.run();
  assert.equal(q.button.clicks, 0);
  q.context.location.hash = "#/auth-files";
  q.tick();
  q.context.document.visibilityState = "hidden";
  q.context.location.hash = "#/quota";
  q.clock.now += 5 * 60e3;
  q.tick();
  assert.equal(q.button.clicks, 0, "a hidden panel sends no quota requests");
});

test("the quota page shows each Cline Pass key's usage windows under its header", async () => {
  const q = quotaPage({ usage: USAGE });
  q.run();
  await q.settle();
  assert.deepEqual(q.fetches, [{ url: "/v0/management/cline-pass-switcher/api/usage-limits", authorization: `Bearer ${q.marker}` }]);
  const card = q.header.nextElementSibling;
  assert.equal(card.dataset.codingTools, "cline-quota");
  const text = card.textContent;
  assert.match(text, /Cline Pass/);
  assert.match(text, /2 keys/, "the switched-off key is left out");
  assert.match(text, /main key[\s\S]*5-hour[\s\S]*58% left · resets in 2h 30m[\s\S]*Weekly[\s\S]*10% left · resets in 3d 0h/);
  assert.match(text, /spare key[\s\S]*Cline answered HTTP 401/);
  assert.doesNotMatch(text, /switched off/);

  // React drops the card on a re-render; the next tick puts it back under the header.
  card.remove();
  q.tick();
  assert.equal(q.header.nextElementSibling, card);
  // Leaving the page takes it away.
  q.context.location.hash = "#/config";
  q.tick();
  assert.equal(card.parent, null);
});

test("no Cline Pass card without enabled keys, and the script waits for a seeded panel", async () => {
  const q = quotaPage({ usage: { accounts: [{ name: "off", enabled: false, limits: [] }] } });
  q.run();
  await q.settle();
  assert.equal(q.header.nextElementSibling.className, "Quota-module__providers");
  const unseeded = quotaPage({ usage: USAGE });
  unseeded.sessionStorage.setItem("coding-tools-cpa-session", "something-else");
  assert.equal(unseeded.run(), "unseeded");
  assert.equal(unseeded.button.clicks, 0);
});

test("the quota script runs only in the managed panel frame", async () => {
  const f = fixture();
  f.install();
  const watch = f.webContents.listeners("did-frame-finish-load")[2];
  await watch({}, false, 5, 9);
  assert.match(f.frame.scripts.at(-1), /QuotaHeader-module__primaryAction/);
  const scripts = f.frame.scripts.length;
  f.frame.url = `${ORIGIN}/v0/resource/plugins/cpa-helper/index.html`;
  await watch({}, false, 5, 9);
  await watch({}, true, 5, 9);
  assert.equal(f.frame.scripts.length, scripts);
  assert.equal(f.frame.scripts.join("").includes(SECRET), false);
});
