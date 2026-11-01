"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { quotaPageScript } = require("../electron/cpa-panel-session.cjs");

function panel({ delay, hash = "#/quota", routes = {} } = {}) {
  const marker = "fixture-marker";
  const clock = { now: 1_800_000_000_000 };
  const network = [], fetches = [], timers = [];
  const values = new Map([
    ["coding-tools-quota-refreshed", String(clock.now)],
    ["coding-tools-quota-cline", JSON.stringify({ at: clock.now, value: { accounts: [] } })],
  ]);
  class NativeXhr {
    open(method, url) { Object.assign(this, { method, url, readyState: 1 }); }
    setRequestHeader() {}
    send(body) { this.sent = true; network.push({ xhr: this, body: JSON.parse(body), at: clock.now }); }
    abort() { this.aborted = true; if (this.sent) { this.status = 0; this.responseText = ""; this.onloadend?.(); } }
  }
  const context = vm.createContext({
    window: { XMLHttpRequest: NativeXhr }, XMLHttpRequest: NativeXhr, AbortSignal,
    Event: class { constructor(type) { this.type = type; } },
    document: { visibilityState: "visible", querySelector: (selector) => selector.includes("metaLoaded") ? {} : null,
      querySelectorAll: () => [], addEventListener() {} },
    sessionStorage: { getItem: () => marker },
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    location: { hash }, innerWidth: 900,
    Date: { now: () => clock.now, parse: Date.parse },
    setInterval() {}, addEventListener() {},
    setTimeout: (fn, ms = 0) => { const timer = { fn, at: clock.now + ms }; timers.push(timer); return timer; },
    fetch: async (url, options) => {
      fetches.push({ url, options, at: clock.now });
      if (routes[url]) return routes[url](options);
      return { ok: true, status: 200, json: async () => ({ accounts: [], providers: [], files: [] }) };
    },
  });
  vm.runInContext(quotaPageScript(marker, { refreshDelayMs: delay }), context);
  function advance(ms = 0) {
    const until = clock.now + ms;
    for (let count = 0; count < 1000; count++) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > until) { clock.now = until; return; }
      const timer = timers.shift(); clock.now = timer.at; timer.fn();
    }
    assert.fail("timer loop did not settle");
  }
  function ask(id, url = "http://127.0.0.1:8317/v0/management/api-call") {
    const xhr = new NativeXhr(), result = {};
    xhr.timeout = 8000;
    xhr.onloadend = () => Object.assign(result, { status: xhr.status, text: xhr.responseText });
    xhr.open("POST", url);
    xhr.send(JSON.stringify({ authIndex: id, method: "GET", url: "https://chatgpt.com/backend-api/wham/usage" }));
    return { xhr, result };
  }
  function answer(index, upstream = 200, status = 200) {
    const xhr = network[index].xhr;
    Object.assign(xhr, { status, responseText: JSON.stringify({ status_code: upstream, body: { ok: true } }) });
    xhr.onloadend(); advance();
  }
  return { clock, network, fetches, context, ask, answer, advance };
}
const settle = async () => { for (let n = 0; n < 8; n++) await new Promise(setImmediate); };

test("quota reads wait for completion and a two-second gap before the next account", () => {
  const p = panel();
  p.ask("first"); p.ask("second");
  assert.equal(p.network.length, 1, "only one account may be in flight");
  p.advance(5000);
  assert.equal(p.network.length, 1, "a slow first request must not overlap the next");
  p.answer(0);
  p.advance(1999); assert.equal(p.network.length, 1);
  p.advance(1); assert.equal(p.network.length, 2);
  assert.equal(p.network[1].at - p.network[0].at, 7000);
  assert.equal(p.network[1].xhr.timeout, 8000, "queue wait does not consume the request timeout");
});

test("custom delay applies after errors as well as successful requests", () => {
  const p = panel({ delay: 3500 });
  p.ask("first"); p.ask("second"); p.ask("third");
  assert.equal(p.network.length, 1);
  p.answer(0, 500);
  p.advance(3499); assert.equal(p.network.length, 1);
  p.advance(1); assert.equal(p.network.length, 2);
  p.answer(1, 0, 0);
  p.advance(3500); assert.equal(p.network.length, 3, "transport failures release the queue");
});

test("aborted queued reads never start and an aborted active read releases the queue", () => {
  const p = panel();
  const first = p.ask("first"), cancelled = p.ask("cancelled");
  p.ask("third");
  assert.equal(p.network.length, 1);
  cancelled.xhr.abort(); first.xhr.abort();
  p.advance(1999); assert.equal(p.network.length, 1);
  p.advance(1);
  assert.deepEqual(p.network.map((request) => request.body.authIndex), ["first", "third"]);
});

test("cached quota replies remain immediate while another account is refreshing", () => {
  const p = panel();
  p.ask("cached"); p.answer(0);
  p.advance(2000); p.ask("slow");
  assert.equal(p.network.length, 2);
  const cached = p.ask("cached"); p.advance();
  assert.equal(cached.result.status, 200);
  assert.equal(p.network.length, 2, "a cache hit never joins the network queue");
});

test("non-quota management requests and requests outside quota pages are not queued", () => {
  const p = panel();
  p.ask("quota"); p.ask("ordinary", "http://127.0.0.1:8317/v0/management/auth-files");
  assert.equal(p.network.length, 2);
  const other = panel({ hash: "#/config" });
  other.ask("first"); other.ask("second");
  assert.equal(other.network.length, 2);
});

test("invalid delay values fail back to two seconds instead of creating a burst", () => {
  for (const delay of [-1, 0, "invalid", Infinity, 120_000]) {
    const p = panel({ delay });
    p.ask("first"); p.ask("second");
    assert.equal(p.network.length, 1);
    p.answer(0); p.advance(1999); assert.equal(p.network.length, 1);
    p.advance(1); assert.equal(p.network.length, 2);
  }
});

test("reopening a queued XHR cancels its previous request rather than reviving it", () => {
  const p = panel();
  p.ask("first"); const reused = p.ask("old").xhr;
  reused.open("POST", "http://127.0.0.1:8317/v0/management/api-call");
  reused.send(JSON.stringify({ authIndex: "replacement", method: "GET", url: "https://chatgpt.com/backend-api/wham/usage" }));
  p.answer(0); p.advance(2000);
  assert.deepEqual(p.network.map((request) => request.body.authIndex), ["first", "replacement"]);
});

test("the environment can set the delay without changing the refresh cycle interval", (t) => {
  const key = "CODING_TOOLS_CPA_QUOTA_REFRESH_DELAY_MS", previous = process.env[key];
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  process.env[key] = "5000";
  const p = panel();
  p.ask("first"); p.ask("second"); p.answer(0);
  p.advance(4999); assert.equal(p.network.length, 1);
  p.advance(1); assert.equal(p.network.length, 2);
});

test("a rejected credit read has a transport timeout and does not wedge the next quota read", async () => {
  let signal;
  const p = panel({ hash: "#/auth-files", routes: {
    "/v0/management/auth-files": () => ({ ok: true, status: 200, json: async () => ({ files: [
      { type: "codex", name: "fixture.json", auth_index: "credit" },
    ] }) }),
    "/v0/management/api-call": (options) => { signal = options.signal; throw new Error("request timed out"); },
  } });
  await settle();
  assert.ok(signal instanceof AbortSignal);
  p.ask("native"); assert.equal(p.network.length, 0);
  p.advance(2000); assert.equal(p.network.length, 1);
});

test("credit fetches and native XHR quota reads share the same pacing queue", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const p = panel({ hash: "#/auth-files", routes: {
    "/v0/management/auth-files": () => ({ ok: true, status: 200, json: async () => ({ files: [
      { type: "codex", name: "fixture.json", auth_index: "credit" },
    ] }) }),
    "/v0/management/api-call": () => ({ ok: true, status: 200, json: async () => held }),
  } });
  await settle();
  assert.equal(p.fetches.filter((request) => request.url === "/v0/management/api-call").length, 1);
  p.ask("native");
  assert.equal(p.network.length, 0, "the native quota request waits for the credit fetch");
  release({ status_code: 200, body: JSON.stringify({ credits: { balance: "12" } }) });
  await settle();
  p.advance(1999); assert.equal(p.network.length, 0);
  p.advance(1); assert.equal(p.network.length, 1);
});
