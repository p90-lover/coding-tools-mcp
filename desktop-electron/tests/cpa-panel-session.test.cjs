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
  get parentElement() { return this.parent; }
  insertBefore(node, before) {
    node.remove();
    const at = before ? this.children.indexOf(before) : -1;
    this.children.splice(at < 0 ? this.children.length : at, 0, node);
    node.parent = this;
  }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  // Selectors the script uses: `tag`, `[class*="x"]`, `tag[class*="x"]` and `[data-coding-tools="x"]`.
  matches(selector) {
    const [, tag, kind, value] = selector.match(/^(\w*)(?:\[(class\*|data-coding-tools)="(.+)"\])?$/);
    if (tag && this.tag !== tag) return false;
    if (kind === "class*") return this.className.includes(value);
    if (kind) return this.dataset.codingTools === value;
    return true;
  }
  querySelectorAll(selector) { return this.descendants().filter((node) => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  click() { this.clicks += 1; }
}

function quotaPage({ hash = "#/quota", loaded = false, usage, usageStatus = 200, localStorage = storage(), routes = {} } = {}) {
  const marker = `coding-tools-${"c".repeat(48)}`;
  const sessionStorage = storage();
  sessionStorage.setItem("coding-tools-cpa-session", marker);
  // The browser's XMLHttpRequest, as CPA's page (axios) uses it; a request that reaches the network
  // waits in `network` until the test answers it.
  const network = [];
  class XMLHttpRequest {
    open(method, url) { Object.assign(this, { method, url, readyState: 1 }); }
    setRequestHeader() {}
    abort() {}
    send(body) { network.push({ xhr: this, body: JSON.parse(body) }); }
  }
  const answer = (index, statusCode, body) => {
    const { xhr } = network[index];
    Object.assign(xhr, { status: 200, responseText: JSON.stringify({ status_code: statusCode, header: {}, body }) });
    xhr.onloadend();
  };
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
    window: { XMLHttpRequest }, XMLHttpRequest, Event: class { constructor(type) { this.type = type; } },
    document, sessionStorage, localStorage, innerWidth: 900,
    location: { hash },
    Date: { now: () => clock.now, parse: Date.parse },
    setInterval: (fn) => ticks.push(fn),
    setTimeout: (fn) => fn(),
    addEventListener: () => {},
    fetch: async (url, options) => {
      fetches.push({ url, authorization: options.headers.Authorization });
      const route = routes[url.split("?")[0]];
      if (route) return { ok: true, status: 200, json: async () => route(options) };
      return { ok: usageStatus === 200, status: usageStatus, json: async () => usage };
    },
  });
  /** CPA's page asking for one account's quota, as its quota loaders do; resolves with the answer. */
  const ask = (authIndex = "codex-1") => {
    const xhr = new XMLHttpRequest();
    const result = {};
    xhr.onloadend = () => Object.assign(result, { status: xhr.status, body: JSON.parse(xhr.responseText) });
    xhr.open("POST", "http://127.0.0.1:8317/v0/management/api-call");
    xhr.send(JSON.stringify({ authIndex, method: "GET", url: "https://chatgpt.com/backend-api/wham/usage" }));
    return result;
  };
  return {
    marker, header, button, clock, fetches, sessionStorage, localStorage, context, network, answer, ask, page,
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

// One of CPA's Auth Files cards: a header with the file's name, an optional Codex quota section, the
// footer of actions. `badge` adds the provider badge; `idle` the "Click here to refresh quota" button.
// A plugin's runtime-only card (`runtime`) shows its name on the account line, not as a file name.
function authCard(name, { codex = false, badge = null, idle = false, runtime = false } = {}) {
  const card = new FakeNode("article", "AuthFileCard-module__card___uGYSU AuthFileCard-module__cardEnter___sxjp9");
  const head = new FakeNode("header", "AuthFileCard-module__head___v8x8N");
  const file = new FakeNode("span", runtime ? "AuthFileCard-module__account___Rff3G AuthFileCard-module__accountMono___j0kio" : "AuthFileCard-module__fileName___4SoBR");
  file.text = name;
  const badgeNode = badge === null ? null : new FakeNode("span", "AuthFileCard-module__providerBadge___6gvmI");
  if (badgeNode) badgeNode.text = badge;
  head.append(...[badgeNode, file].filter(Boolean));
  const footer = new FakeNode("footer", "AuthFileCard-module__actions___Ab12c");
  card.append(head);
  let button = null;
  if (idle) {
    const section = new FakeNode("div", "AuthFileQuota-module__quotaSection___B1NkU");
    button = new FakeNode("button", "AuthFileQuota-module__quotaMessage___cvzkK AuthFileQuota-module__quotaMessageAction___B2326");
    button.text = "Click here to refresh quota";
    section.append(button);
    card.append(section);
  }
  let plan = null;
  if (codex) {
    const section = new FakeNode("div", "AuthFileQuota-module__quotaSection___B1NkU");
    plan = new FakeNode("div", "AuthFileQuota-module__codexPlan___Pl4n1");
    plan.append(new FakeNode("span", "AuthFileQuota-module__codexPlanItem___It3m1"));
    section.append(plan, new FakeNode("div", "AuthFileQuota-module__quotaRow___Rw0q1"));
    card.append(section);
  }
  card.append(footer);
  return { card, footer, plan, badge: badgeNode, button };
}

test("a Provider Manager card names OpenCode and shows its windows; idle cards load one per tick", async () => {
  const state = { providers: [
    { id: "opencode-go", kind: "opencode-go", enabled: true, quota: { windows: {
      rolling: { percent: 30, resetsAt: "2026-10-24T09:00:00Z", status: "ok" },
      weekly: { percent: 75, resetsAt: "2026-10-27T08:00:00Z", status: "ok" },
    } } },
    { id: "compat", kind: "openai", enabled: true },
  ] };
  const routes = {
    "/v0/management/cpa-provider-manager/api/state": () => state,
    "/v0/management/auth-files": () => ({ files: [] }),
  };
  const q = quotaPage({ hash: "#/auth-files", usage: { accounts: [] }, routes });
  const go = authCard("cpa-provider-manager-opencode-go", { badge: "Provider-manager", runtime: true });
  const compat = authCard("cpa-provider-manager-compat", { badge: "Provider-manager", runtime: true });
  const first = authCard("antigravity-a@example.com", { idle: true });
  const second = authCard("antigravity-b@example.com", { idle: true });
  q.page.append(go.card, compat.card, first.card, second.card);
  q.run();
  for (let i = 0; i < 6; i++) await q.settle();
  q.tick();

  assert.equal(go.badge.textContent, "OpenCode", "the badge names the upstream's provider");
  assert.equal(compat.badge.textContent, "Provider-manager", "an upstream with no own badge keeps CPA's");
  const block = go.footer.parentElement.children.at(-2);
  assert.equal(block.dataset.codingTools, "provider-quota-opencode-go");
  assert.match(block.textContent, /5-hour[\s\S]*70% left · resets in 1h 0m[\s\S]*Weekly[\s\S]*25% left/);
  assert.equal(compat.card.children.at(-2).tag, "header", "no quota block without windows");

  assert.deepEqual([first.button.clicks, second.button.clicks], [1, 1], "one idle card pressed per tick");
  q.tick();
  assert.deepEqual([first.button.clicks, second.button.clicks], [1, 1], "each card once per refresh period");

  // The pressed cards ask CPA as the quota page does, and get the saved answer while it is fresh.
  q.ask("ag-1");
  q.answer(0, 200, { models: {} });
  const saved = q.ask("ag-1");
  assert.equal(q.network.length, 1, "the second ask is answered from the saved one");
  assert.equal(saved.body.status_code, 200);

  // A failed quota read keeps the last good windows on screen.
  state.providers[0].quota = { error: "usage answered HTTP 500" };
  q.clock.now += 2 * 60e3 + 1;
  q.tick();
  for (let i = 0; i < 6; i++) await q.settle();
  q.tick();
  assert.match(go.card.children.at(-2).textContent, /70% left/);
  assert.deepEqual([first.button.clicks, second.button.clicks], [2, 2], "pressed again after the refresh period, one per tick");
});

test("Auth Files cards get the Cline Pass windows and each Codex account's credit balance", async () => {
  const calls = [];
  const files = { files: [
    { name: "codex-1-a@example.com-plus.json", type: "codex", auth_index: "c1" },
    { name: "codex-2-off.json", type: "codex", auth_index: "c2", disabled: true },
    { name: "cline-pass-switcher.json", type: "cline", auth_index: "k1" },
  ] };
  const credits = { has_credits: true, unlimited: false, balance: "47757.3601015000" };
  const routes = {
    "/v0/management/auth-files": () => files,
    "/v0/management/api-call": (options) => {
      calls.push(JSON.parse(options.body));
      return { status_code: 200, header: {}, body: JSON.stringify({ plan_type: "plus", credits }) };
    },
  };
  const q = quotaPage({ hash: "#/auth-files", usage: USAGE, routes });
  const cline = authCard("cline-pass-switcher");
  const codex = authCard("codex-1-a@example.com-plus", { codex: true });
  q.page.append(cline.card, codex.card);
  q.run();
  for (let i = 0; i < 6; i++) await q.settle();
  q.tick();

  assert.deepEqual(calls.map((call) => [call.authIndex, call.method, call.url]), [["c1", "GET", "https://chatgpt.com/backend-api/wham/usage"]],
    "one usage read per enabled Codex account, made through CPA with the account's own token");
  const block = cline.footer.parentElement.children.at(-2);
  assert.equal(block.dataset.codingTools, "cline-auth-quota", "the windows sit just above the card's actions");
  assert.match(block.textContent, /5-hour limit[\s\S]*58% left · resets in 2h 30m[\s\S]*Weekly limit[\s\S]*10% left/);
  assert.match(block.textContent, /spare key[\s\S]*Cline answered HTTP 401/);
  assert.equal(block.descendants().find((node) => node.dataset.codingTools === undefined && node.className.startsWith("AuthFileQuota-module__quotaRow___"))?.className,
    "AuthFileQuota-module__quotaRow___Rw0q1", "rows use the page's own quota classes");
  const item = codex.plan.children.at(-1);
  assert.equal(item.dataset.codingTools, "codex-credits");
  assert.equal(item.className, "AuthFileQuota-module__codexPlanItem___It3m1");
  assert.match(item.textContent, /Credits[\s\S]*47,757/);

  // React drops both on a re-render; the next tick puts them back.
  block.remove();
  item.remove();
  q.tick();
  assert.equal(cline.card.children.at(-2), block);
  assert.match(codex.plan.children.at(-1).textContent, /47,757/);

  const reads = q.fetches.length;
  q.clock.now += 60e3;
  q.tick();
  assert.equal(q.fetches.length, reads, "fresh for two minutes");
  q.clock.now += 60e3 + 1;
  q.tick();
  for (let i = 0; i < 6; i++) await q.settle();
  assert.ok(q.fetches.length > reads, "then read again");

  // A restart shows the saved balance at once, before any read.
  const again = quotaPage({ hash: "#/auth-files", usage: USAGE, routes, localStorage: q.localStorage });
  again.clock.now = q.clock.now;
  const card = authCard("codex-1-a@example.com-plus", { codex: true });
  again.page.append(card.card);
  again.run();
  assert.match(card.plan.children.at(-1).textContent, /Credits[\s\S]*47,757/);
});

test("the quota page loads every provider's quota on open, once, and again after two minutes", () => {
  const q = quotaPage({ usage: USAGE });
  assert.equal(q.run(), "started");
  assert.equal(q.run(), "running", "one script per page load");
  assert.equal(q.button.clicks, 1, "nothing was loaded, so it presses Refresh all credentials");
  q.tick();
  q.tick();
  assert.equal(q.button.clicks, 1, "not again on this visit while it is fresh");
  q.clock.now += 2 * 60e3 + 1;
  q.tick();
  assert.equal(q.button.clicks, 2, "two minutes on, the open page refreshes again");
  q.button.disabled = true;
  q.clock.now += 2 * 60e3 + 1;
  q.tick();
  assert.equal(q.button.clicks, 2, "never while the page has no credentials or is loading");
});

test("a reopened quota page that still shows loaded quota is not refreshed early, nor while hidden", () => {
  const q = quotaPage({ loaded: true, usage: USAGE });
  q.localStorage.setItem("coding-tools-quota-refreshed", String(q.clock.now - 60e3));
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

const CODEX_QUOTA = { plan_type: "plus", rate_limit: { primary_window: { used_percent: 30 } } };

test("saved quota comes back at once after a restart; the network is asked every two minutes", () => {
  const first = quotaPage({ usage: USAGE });
  first.run();
  first.ask();
  assert.equal(first.network.length, 1, "the first refresh asks the upstream");
  assert.equal(first.network[0].body.url, "https://chatgpt.com/backend-api/wham/usage");
  first.answer(0, 200, CODEX_QUOTA);

  // The app restarts a minute later: a new page, the same saved answers.
  const again = quotaPage({ usage: USAGE, localStorage: first.localStorage });
  again.clock.now = first.clock.now + 60e3;
  again.run();
  assert.equal(again.button.clicks, 1, "the empty page is filled at once");
  const replayed = again.ask();
  assert.equal(again.network.length, 0, "from the saved answer, not the network");
  assert.deepEqual(replayed, { status: 200, body: { status_code: 200, header: {}, body: CODEX_QUOTA } });

  again.clock.now += 60e3 + 1;
  again.tick();
  assert.equal(again.button.clicks, 2);
  again.ask();
  assert.equal(again.network.length, 1, "two minutes after the last network refresh, it asks again");
});

test("an upstream 429 keeps the last good quota on screen and slows refreshes to five minutes", () => {
  const q = quotaPage({ usage: USAGE });
  q.run();
  q.ask();
  q.answer(0, 200, CODEX_QUOTA);
  q.clock.now += 2 * 60e3 + 1;
  q.tick();
  assert.equal(q.button.clicks, 2);
  const limited = q.ask();
  q.answer(1, 429, { error: { message: "rate limited" } });
  assert.deepEqual(limited.body.body, CODEX_QUOTA, "the page gets the last good answer, not the 429");

  q.clock.now += 2 * 60e3 + 1;
  q.tick();
  assert.equal(q.button.clicks, 2, "after a 429, two minutes is too soon");
  q.clock.now += 3 * 60e3;
  q.tick();
  assert.equal(q.button.clicks, 3, "five minutes after the 429 it tries again");

  // An account with nothing saved still sees its own refusal.
  q.clock.now += 5 * 60e3 + 1;
  q.tick();
  const fresh = q.ask("codex-2");
  q.answer(2, 429, { error: { message: "rate limited" } });
  assert.equal(fresh.body.status_code, 429);
});

test("the Cline Pass card shows its saved reading at once and keeps it through a failed read", async () => {
  const localStorage = storage();
  localStorage.setItem("coding-tools-quota-cline", JSON.stringify({ at: Date.parse("2026-10-24T07:59:00Z"), value: USAGE }));
  const q = quotaPage({ usage: null, usageStatus: 503, localStorage });
  q.run();
  await q.settle();
  assert.equal(q.fetches.length, 0, "a minute-old reading is still fresh");
  const card = q.header.nextElementSibling;
  assert.match(card.textContent, /2 keys · updated 1m ago[\s\S]*main key[\s\S]*58% left/);
  q.clock.now += 2 * 60e3;
  q.tick();
  await q.settle();
  assert.equal(q.fetches.length, 1);
  assert.match(q.header.nextElementSibling.textContent, /main key[\s\S]*58% left/, "a failed read keeps the last good one");
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
