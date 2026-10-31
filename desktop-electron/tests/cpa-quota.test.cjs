"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createCpaQuota, accountOf, STALE_MS } = require("../electron/cpa-quota.cjs");

const KEY = "mgmt-key-never-leaves";
const NOW = 1_800_000_000_000;

function item(overrides = {}) {
  return {
    name: "codex-a.json", auth_index: "a1", email: "me@example.com", plan: "plus", priority: 0, disabled: false,
    access_token: "should-not-pass", // never in CPA Helper's list, but must not leak if it were
    quota: { plan: "plus", checked_ms: NOW - 10_000,
      primary: { used_percent: 42.4, reset_at_ms: NOW + 3_600_000, window_seconds: 18_000 },
      secondary: { used_percent: 97.5, reset_at_ms: NOW + 86_400_000, window_seconds: 604_800 } },
    ...overrides,
  };
}

function fixture({ items = [item()], status = 200, connection = { baseUrl: "http://127.0.0.1:8317", managementKey: KEY } } = {}) {
  const calls = [];
  let clock = NOW;
  const quota = createCpaQuota({
    getConnection: () => connection, now: () => clock, logger: { warn() {} },
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
      return { ok: status >= 200 && status < 300, status, json: async () => ({ items }) };
    },
  });
  return { quota, calls, advance: (ms) => { clock += ms; } };
}

test("reads CPA Helper's Codex accounts with the management key and returns only their limits", async () => {
  const { quota, calls } = fixture();
  const result = await quota.read();
  assert.equal(calls[0].url, "http://127.0.0.1:8317/v0/management/cpa-helper/codex/accounts");
  assert.equal(calls[0].auth, `Bearer ${KEY}`);
  assert.equal(result.available, true);
  assert.deepEqual(result.accounts, [{
    id: "a1", label: "me@example.com", plan: "plus", disabled: false, paused: false,
    session: { usedPercent: 42.4, resetsAt: NOW + 3_600_000, windowSeconds: 18_000 },
    week: { usedPercent: 97.5, resetsAt: NOW + 86_400_000, windowSeconds: 604_800 },
    credits: null, checkedAt: NOW - 10_000, error: null,
  }]);
  const text = JSON.stringify(result);
  assert.ok(!text.includes(KEY) && !text.includes("should-not-pass"), "no key or token reaches the renderer");
});

test("a fresh read is cached; a stale or unchecked account is refreshed once per window", async () => {
  const { quota, calls, advance } = fixture({ items: [item(), item({ auth_index: "b2", email: "two@example.com", quota: null }),
    item({ auth_index: "c3", disabled: true, quota: null })] });
  await quota.read();
  await new Promise((resolve) => setImmediate(resolve));
  const refreshes = calls.filter((call) => call.method === "POST");
  assert.deepEqual(refreshes.map((call) => call.body), [{ auth_index: "b2" }], "only the enabled account never checked");
  assert.equal(refreshes[0].url, "http://127.0.0.1:8317/v0/management/cpa-helper/codex/refresh");
  const gets = () => calls.filter((call) => call.method === "GET").length;
  await quota.read();
  assert.equal(gets(), 2, "a refresh makes the next read fetch the new numbers");
  await quota.read();
  assert.equal(gets(), 2, "otherwise a read is cached for a short while");
  advance(30_000);
  await quota.read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.method === "POST").length, 1, "not refreshed again within STALE_MS");
  advance(STALE_MS);
  await quota.read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.method === "POST").length, 3, "after STALE_MS both enabled accounts are stale");
});

test("quota refresh is minute-paced, bounded and fair across more than four accounts", async () => {
  assert.equal(STALE_MS, 60_000);
  const items = Array.from({ length: 9 }, (_, i) => item({ auth_index: `key${i}`, quota: null }));
  const { quota, calls, advance } = fixture({ items });
  for (let i = 0; i < 3; i++) {
    await quota.read(); await new Promise((resolve) => setImmediate(resolve)); advance(30_000);
  }
  const refreshed = calls.filter((c) => c.method === "POST").map((c) => c.body.auth_index);
  assert.equal(new Set(refreshed).size, 9, "later accounts must not starve behind retries");
  assert.ok(refreshed.length <= 12, "at most four accounts per read");
});

test("working accounts come first, so many signed-out ones cannot hide them past the cap", async () => {
  // Seen live 2026-10-24: nine signed-out and three unchecked accounts filled the first 12, and the
  // one working Plus account, at 100% of its 5-hour window, was never shown.
  const signedOut = Array.from({ length: 12 }, (_, at) => item({ auth_index: `out${at}`, email: `out${at}@example.com`,
    quota: { error: "HTTP 401: Encountered invalidated oauth token", checked_ms: NOW - 2 * STALE_MS } }));
  const unchecked = item({ auth_index: "new", email: "new@example.com", quota: null });
  const disabled = item({ auth_index: "off", email: "off@example.com", disabled: true });
  const plus = item({ auth_index: "plus", email: "plus@example.com", priority: -1,
    quota: { plan: "plus", checked_ms: NOW - 10_000, primary: { used_percent: 100 }, secondary: { used_percent: 16 } } });
  const { quota, calls, advance } = fixture({ items: [...signedOut, disabled, unchecked, plus] });
  const { accounts } = await quota.read();
  assert.equal(accounts.length, 12);
  assert.deepEqual(accounts.slice(0, 3).map((account) => account.id), ["plus", "new", "off"], "working, unchecked, disabled, then errors");
  assert.equal(accounts[0].session.usedPercent, 100, "an exhausted account is still shown first: it is the one to watch");
  assert.deepEqual(accounts.slice(3).map((account) => account.id), signedOut.slice(0, 9).map((entry) => entry.auth_index), "CPA's order within a rank");
  // Accounts past the cap are still re-checked (one signed in again must not stay hidden), the
  // unchecked one first, within the per-read refresh budget.
  const refreshed = () => calls.filter((call) => call.method === "POST").map((call) => call.body.auth_index);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(refreshed(), ["new", "out0", "out1", "out2"], "the unchecked one first, four per read");
  for (let read = 0; read < 3; read += 1) {
    advance(30_000);
    await quota.read();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(refreshed().includes("out11"), "an account past the cap is re-checked too");
  assert.ok(!refreshed().includes("off"), "never refresh a disabled account");
  assert.ok(refreshed().includes("plus"), "the working account also refreshes after one minute");
});

test("an account's credits (CPA Helper 0.1.1) reach the meter exactly as chatgpt.com sent them", () => {
  // Past a full window every request is paid from them: 7 credits a minute, seen 2026-10-24.
  const credits = { balance: "51249.6137980000", has_credits: true, unlimited: false, overage_limit_reached: false };
  assert.deepEqual(accountOf(item({ quota: { ...item().quota, credits } })).credits,
    { balance: "51249.6137980000", hasCredits: true, unlimited: false, overageReached: false });
  assert.equal(accountOf(item({ quota: { ...item().quota, credits: { balance: "lots", unlimited: true } } })).credits.balance, null, "only a number is shown");
  assert.equal(accountOf(item()).credits, null, "an older CPA Helper reports none");
});

test("an account at its limit, a disabled one and one with an error are told apart", () => {
  assert.equal(accountOf(item({ priority: -1 })).paused, true);
  assert.equal(accountOf(item({ disabled: true })).disabled, true);
  const failed = accountOf(item({ quota: { error: "HTTP 500", checked_ms: NOW } }));
  assert.equal(failed.error, "HTTP 500");
  assert.equal(failed.session, null);
  // As the installed app saw it: every account's sign-in expired, before any quota check.
  for (const error of ["unauthorized", "HTTP 401", "Encountered invalidated oauth token"]) {
    assert.match(accountOf(item({ quota: { error } })).error, /^Signed out: .*Sign in to it again in CPA\.$/, error);
  }
  assert.equal(accountOf(item({ plan: "oauth", quota: null })).plan, null, "a credential type is not a plan");
  assert.equal(accountOf(item({ quota: { plan: "unknown" } })).plan, null);
  assert.equal(accountOf(item({ quota: { plan: "pro" } })).plan, "pro");
  assert.equal(accountOf({ auth_index: 7, name: "codex-x.json" }).label, "codex-x.json");
  assert.equal(accountOf(item({ quota: { primary: { used_percent: 140 } } })).session.usedPercent, 100);
});

test("without CPA, without the plugin or with a refused key it says why, and the key goes only to loopback", async () => {
  assert.deepEqual(await fixture({ connection: null }).quota.read(), { ok: true, available: false, reason: "CPA is not running" });
  assert.match((await fixture({ status: 404 }).quota.read()).reason, /CPA Helper is not installed/);
  assert.match((await fixture({ status: 401 }).quota.read()).reason, /refused the management key/);
  const remote = fixture({ connection: { baseUrl: "http://cpa.example.com:8317", managementKey: KEY } });
  assert.equal((await remote.quota.read()).available, false);
  assert.equal(remote.calls.length, 0, "a non-loopback CPA never receives the key");
});
