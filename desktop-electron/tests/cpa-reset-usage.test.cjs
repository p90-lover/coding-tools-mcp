"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createCpaUsage } = require("../electron/cpa-usage.cjs");

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const KEY = "management-key-kept-private";
const file = (id) => ({ auth_index: id, name: `codex-${id}-same@example.com-team.json`, email: "same@example.com", type: "codex" });
const window = (start, seconds = 18000) => ({ used_percent: 10, reset_at_ms: start + seconds * 1000, window_seconds: seconds });
const account = (id, primary, secondary = window(NOW - 2 * 24 * HOUR, WEEK / 1000), checked = NOW) => ({
  auth_index: id, quota: { primary, secondary, checked_ms: checked, plan: "team" },
});
const record = (auth, ts, model = "gpt-6", cost = 0.1) => ({ auth, ts, model, cost });

function fixture({ files = [file("a")], quotas = [account("a", window(NOW - HOUR))], records = [], fail = () => false } = {}) {
  let at = NOW, active = 0, maxActive = 0;
  const calls = [];
  const usage = createCpaUsage({
    getConnection: () => ({ baseUrl: "http://127.0.0.1:8317", managementKey: KEY }), now: () => at, logger: { warn() {} },
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      calls.push({ parsed, init });
      let body;
      if (parsed.pathname.endsWith("/auth-files")) body = { files };
      else if (parsed.pathname.endsWith("/codex/accounts")) body = { items: quotas };
      else if (parsed.pathname.endsWith("/rankings")) {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        if (fail(parsed)) return { ok: false, status: 503 };
        const auth = parsed.searchParams.get("auth");
        const from = Number(parsed.searchParams.get("from")), to = Number(parsed.searchParams.get("to"));
        const selected = records.filter((r) => r.auth === auth && r.ts >= from && r.ts <= to);
        const groups = new Map();
        for (const r of selected) {
          const row = groups.get(r.model) ?? { key: r.model, requests: 0, failed: 0, total_tokens: 0,
            input_tokens: 0, output_tokens: 0, cost_usd: 0, unpriced: 0 };
          row.requests++; row.total_tokens += 110; row.input_tokens += 100; row.output_tokens += 10;
          if (r.cost === null) row.unpriced++; else row.cost_usd += r.cost;
          groups.set(r.model, row);
        }
        body = { items: [...groups.values()] };
      } else throw new Error(`Unexpected route: ${parsed.pathname}`);
      return { ok: true, status: 200, json: async () => body };
    },
  });
  return { usage, calls, quotas, clock: (value) => { at = value; }, maxActive: () => maxActive };
}

const ranks = (f) => f.calls.filter((call) => call.parsed.pathname.endsWith("/rankings"));

test("current short-hour usage starts at that account's provider reset, not now minus five hours", async () => {
  const start = NOW - HOUR;
  const f = fixture({ records: [record("a", start - 1), record("a", start), record("a", NOW), record("a", NOW + 1), record("other", NOW)] });
  const result = await f.usage.read({ range: "session" });
  const row = result.accounts[0];
  assert.equal(row.requests, 2);
  assert.equal(row.totalTokens, 220);
  assert.equal(row.cost, 0.2);
  assert.equal(row.usageAvailable, true);
  assert.deepEqual(row.window, { from: start, to: start + 5 * HOUR });
  assert.equal(result.range, "session");
  assert.equal(row.file, "codex-a-same@example.com-team");
  const [{ parsed, init }] = ranks(f);
  assert.equal(parsed.searchParams.get("auth"), "a");
  assert.equal(parsed.searchParams.get("group"), "model");
  assert.equal(Number(parsed.searchParams.get("from")), start);
  assert.equal(Number(parsed.searchParams.get("to")), NOW);
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.equal(f.calls.some((call) => call.init.method !== "GET"), false, "no upstream quota refresh or consumption");
});

test("weekly windows have their own reset, distinct from the short-hour reset and from same-email accounts", async () => {
  const aStart = NOW - 2 * 24 * HOUR, bStart = NOW - HOUR;
  const f = fixture({ files: [file("a"), file("b")], quotas: [account("a", window(NOW - 3 * HOUR), window(aStart, WEEK / 1000)),
    account("b", window(NOW - HOUR), window(bStart, WEEK / 1000))], records: [record("a", aStart - 1), record("a", aStart),
    record("a", NOW - 12 * HOUR), record("a", NOW), record("b", bStart - 1), record("b", bStart), record("b", NOW)] });
  const weekly = await f.usage.read({ range: "week" });
  assert.deepEqual(weekly.accounts.map((r) => [r.id, r.requests, r.window.from]), [["a", 3, aStart], ["b", 2, bStart]]);
  assert.equal(weekly.totals.requests, 5);
  const short = await f.usage.read({ range: "session" });
  assert.equal(short.accounts[0].requests, 1);
  assert.equal(short.accounts[1].requests, 2);
});

test("missing, expired, future and unconfirmed windows never fall back to rolling counts", async () => {
  const cases = [null, window(NOW - 6 * HOUR), window(NOW + 1),
    { used_percent: 20, reset_at_ms: NOW + HOUR, window_seconds: 0 },
    { used_percent: 20, reset_at_ms: Infinity, window_seconds: 18000 }];
  const files = cases.map((_, i) => file(String(i)));
  const quotas = cases.map((value, i) => account(String(i), value));
  quotas.push(account("unchecked", window(NOW - HOUR), null, NOW - 2 * HOUR));
  files.push(file("unchecked"));
  const f = fixture({ files, quotas });
  const result = await f.usage.read({ range: "session" });
  assert.equal(result.accounts.length, 6);
  for (const row of result.accounts) {
    assert.equal(row.window, null);
    assert.equal(row.usageAvailable, false);
    assert.equal(row.cost, null);
  }
  assert.equal(ranks(f).length, 0);
});

test("an expired cache is not used even inside twenty seconds, and a new reset starts a new count", async () => {
  const end = NOW + 1000, start = end - 5 * HOUR;
  const f = fixture({ quotas: [account("a", window(start))], records: [record("a", NOW), record("a", end), record("a", end + 100)] });
  assert.equal((await f.usage.read({ range: "session" })).accounts[0].requests, 1);
  const cachedCalls = f.calls.length;
  await f.usage.read({ range: "session" });
  assert.equal(f.calls.length, cachedCalls);
  f.clock(end);
  const expired = await f.usage.read({ range: "session" });
  assert.equal(expired.accounts[0].window, null);
  assert.equal(expired.accounts[0].usageAvailable, false);
  assert.ok(f.calls.length > cachedCalls, "re-read quota at the reset boundary");
  f.quotas[0] = account("a", window(end), undefined, end + 100);
  f.clock(end + 21000);
  const renewed = await f.usage.read({ range: "session" });
  assert.equal(renewed.accounts[0].window.from, end);
  assert.equal(renewed.accounts[0].requests, 2);
});

test("all Auth Files cards get windows, including accounts past the chat meter and usage list caps", async () => {
  const files = Array.from({ length: 69 }, (_, i) => file(String(i)));
  const quotas = files.map((_, i) => account(String(i), window(NOW - HOUR)));
  const f = fixture({ files, quotas, records: [record("68", NOW)] });
  const [one, two] = await Promise.all([f.usage.read({ range: "session" }), f.usage.read({ range: "session" }), f.usage.read({ range: "week" })]);
  assert.equal(one, two, "same-range concurrent loads are shared");
  assert.equal(one.accounts.length, 69);
  assert.equal(one.accounts.at(-1).requests, 1);
  assert.equal(ranks(f).length, 138);
  assert.ok(f.maxActive() <= 3, "session and weekly reads share the three-query limit");
});

test("unreadable history is not zero, while an empty window is zero and an unpriced model is null", async () => {
  const files = [file("a"), file("b"), file("c")];
  const f = fixture({ files, quotas: files.map((_, i) => account(String.fromCharCode(97 + i), window(NOW - HOUR))),
    records: [record("c", NOW, "unpriced-model", null)], fail: (url) => url.searchParams.get("auth") === "a" });
  const { accounts } = await f.usage.read({ range: "session" });
  assert.equal(accounts[0].usageAvailable, false);
  assert.ok(accounts[0].window);
  assert.equal(accounts[0].cost, null);
  assert.equal(accounts[1].usageAvailable, true);
  assert.equal(accounts[1].requests, 0);
  assert.equal(accounts[1].cost, 0);
  assert.equal(accounts[2].usageAvailable, true);
  assert.equal(accounts[2].requests, 1);
  assert.equal(accounts[2].cost, null);
  assert.equal(accounts[2].costPartial, true);
});

test("missing local quota cache leaves totals unconfirmed; invalid connections never receive the key", async () => {
  const f = fixture({ quotas: [] });
  const result = await f.usage.read({ range: "week" });
  assert.equal(result.accounts[0].usageAvailable, false);
  assert.equal(result.accounts[0].window, null);
  const usage = createCpaUsage({ getConnection: () => ({ baseUrl: "https://external.example", managementKey: KEY }),
    fetchImpl: async () => assert.fail("management key must stay local") });
  assert.equal((await usage.read({ range: "session" })).available, false);
});
