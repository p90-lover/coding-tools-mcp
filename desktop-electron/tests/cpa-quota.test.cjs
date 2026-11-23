"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createCpaQuota, accountFromAuthFile, CACHE_MS } = require("../electron/cpa-quota.cjs");

const KEY = "mgmt-key-never-leaves";
const NOW = 1_800_000_000_000;
const seconds = (ms) => String(Math.floor(ms / 1000));

/** A Codex account as CPA 8.0.63+ lists it: the latest reply's x-codex-* headers under quota.signals. */
function codex(overrides = {}, signals = {}) {
  return {
    name: "codex-a.json", provider: "codex", auth_index: "a1", email: "me@example.com", status: "active", disabled: false, unavailable: false,
    access_token: "should-not-pass", id_token: { plan_type: "plus", chatgpt_account_id: "acct" },
    quota: { observed_at: new Date(NOW - 10_000).toISOString(), signals: {
      "X-Codex-Primary-Used-Percent": "42.4", "X-Codex-Primary-Window-Minutes": "300", "X-Codex-Primary-Reset-At": seconds(NOW + 3_600_000),
      "X-Codex-Secondary-Used-Percent": "97.5", "X-Codex-Secondary-Window-Minutes": "10080", "X-Codex-Secondary-Reset-At": seconds(NOW + 86_400_000),
      "X-Codex-Plan-Type": "plus", ...signals } },
    ...overrides,
  };
}
function claude(overrides = {}, signals = {}) {
  return {
    name: "claude-b.json", provider: "claude", auth_index: "c1", email: "claude@example.com", status: "active", account_type: "max",
    quota: { observed_at: new Date(NOW - 5_000).toISOString(), signals: {
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.31", "Anthropic-Ratelimit-Unified-5h-Reset": seconds(NOW + 7_200_000),
      "Anthropic-Ratelimit-Unified-7d-Utilization": "0.6", "Anthropic-Ratelimit-Unified-7d-Reset": seconds(NOW + 3 * 86_400_000),
      "Anthropic-Ratelimit-Unified-Status": "allowed", ...signals } },
    ...overrides,
  };
}

function fixture({ files = [codex()], status = 200, connection = { baseUrl: "http://127.0.0.1:8317", managementKey: KEY } } = {}) {
  const calls = [];
  let clock = NOW;
  const quota = createCpaQuota({
    getConnection: () => connection, now: () => clock, logger: { warn() {} },
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, auth: init.headers.Authorization });
      return { ok: status >= 200 && status < 300, status, json: async () => ({ files }) };
    },
  });
  return { quota, calls, advance: (ms) => { clock += ms; } };
}

test("reads each account's limits from CPA's auth-file listing with one GET and returns no token", async () => {
  const { quota, calls } = fixture({ files: [codex(), claude(), { name: "gemini.json", provider: "gemini-cli", auth_index: "g1" }] });
  const result = await quota.read();
  assert.deepEqual(calls.map((call) => [call.method, call.url, call.auth]),
    [["GET", "http://127.0.0.1:8317/v0/management/auth-files", `Bearer ${KEY}`]], "nothing is asked upstream, nothing is written");
  assert.equal(result.available, true);
  assert.deepEqual(result.accounts.map((account) => [account.provider, account.id]), [["codex", "a1"], ["claude", "c1"]], "only plan providers");
  assert.deepEqual(result.accounts[0], {
    id: "a1", provider: "codex", label: "me@example.com", plan: "plus", state: "ready", disabled: false, paused: false, resumesAt: null,
    session: { usedPercent: 42.4, resetsAt: Number(seconds(NOW + 3_600_000)) * 1000, windowSeconds: 18_000 },
    week: { usedPercent: 97.5, resetsAt: Number(seconds(NOW + 86_400_000)) * 1000, windowSeconds: 604_800 },
    credits: null, checkedAt: NOW - 10_000, error: null,
  });
  const text = JSON.stringify(result);
  assert.ok(!text.includes(KEY) && !text.includes("should-not-pass") && !text.includes("acct"), "no key, token or account id reaches the renderer");
});

test("Claude's five-hour and weekly utilization become percents; its plan is the account type", () => {
  const account = accountFromAuthFile(claude(), NOW);
  assert.equal(account.plan, "max");
  assert.deepEqual([account.session.usedPercent, account.session.windowSeconds], [31, 18_000]);
  assert.deepEqual([account.week.usedPercent, account.week.windowSeconds], [60, 604_800]);
  assert.equal(account.credits, null);
});

test("Codex windows are told apart by length, not slot: a weekly-only plan sends its week as primary", () => {
  const weeklyOnly = accountFromAuthFile(codex({}, { "X-Codex-Primary-Used-Percent": "12", "X-Codex-Primary-Window-Minutes": "10080",
    "X-Codex-Secondary-Used-Percent": undefined, "X-Codex-Secondary-Window-Minutes": undefined }), NOW);
  assert.equal(weeklyOnly.session, null);
  assert.equal(weeklyOnly.week.usedPercent, 12);
  const relative = accountFromAuthFile(codex({}, { "X-Codex-Primary-Reset-At": undefined, "X-Codex-Primary-Reset-After-Seconds": "600" }), NOW);
  assert.equal(relative.session.resetsAt, NOW - 10_000 + 600_000, "reset-after counts from when the reply was seen");
  assert.equal(accountFromAuthFile(codex({}, { "X-Codex-Primary-Used-Percent": "140" }), NOW).session.usedPercent, 100);
  const unseen = accountFromAuthFile(codex({ quota: undefined }), NOW);
  assert.deepEqual([unseen.session, unseen.week, unseen.checkedAt, unseen.state], [null, null, null, "ready"], "no reply since CPA started: no reading yet");
});

test("an account's credits reach the meter exactly as chatgpt.com sent them", () => {
  const credits = accountFromAuthFile(codex({}, { "X-Codex-Credits-Balance": "51249.6137980000", "X-Codex-Credits-Has-Credits": "True",
    "X-Codex-Credits-Unlimited": "False" }), NOW).credits;
  assert.deepEqual(credits, { balance: "51249.6137980000", hasCredits: true, unlimited: false, overageReached: false });
  assert.equal(accountFromAuthFile(codex({}, { "X-Codex-Credits-Balance": "lots", "X-Codex-Credits-Unlimited": "true" }), NOW).credits.balance, null, "only a number is shown");
  assert.equal(accountFromAuthFile(codex(), NOW).credits, null, "a reply without credit headers reports none");
});

test("routing state: at a limit or cooling down until a time, disabled, signed out or failing", () => {
  const full = accountFromAuthFile(codex({}, { "X-Codex-Primary-Used-Percent": "100" }), NOW);
  assert.deepEqual([full.state, full.paused, full.resumesAt], ["limited", true, Number(seconds(NOW + 3_600_000)) * 1000]);
  const cooling = accountFromAuthFile(codex({ unavailable: true, next_retry_after: new Date(NOW + 90_000).toISOString() }), NOW);
  assert.deepEqual([cooling.state, cooling.resumesAt], ["limited", NOW + 90_000], "CPA's own cooldown after a 429");
  const over = accountFromAuthFile(codex({ unavailable: true, next_retry_after: new Date(NOW - 1).toISOString() }), NOW);
  assert.equal(over.state, "ready", "a cooldown already over");
  const refused = accountFromAuthFile(claude({}, { "Anthropic-Ratelimit-Unified-Status": "rejected", "Retry-After": "120" }), NOW);
  assert.deepEqual([refused.state, refused.resumesAt], ["limited", NOW - 5_000 + 120_000]);
  assert.equal(accountFromAuthFile(codex({ disabled: true }), NOW).state, "disabled");
  for (const message of ["unauthorized", "HTTP 401", "Encountered invalidated oauth token", "refresh token expired"]) {
    const out = accountFromAuthFile(codex({ status: "error", status_message: message }), NOW);
    assert.equal(out.state, "signed-out", message);
    assert.match(out.error, /^Signed out: .*sign in to this account again in CPA\.$/i);
  }
  const failing = accountFromAuthFile(codex({ status: "error", status_message: "HTTP 500" }), NOW);
  assert.deepEqual([failing.state, failing.error], ["error", "HTTP 500"]);
  assert.equal(accountFromAuthFile(codex({ id_token: { plan_type: "free_workspace" } }, { "X-Codex-Plan-Type": undefined }), NOW).plan, null, "not a plan");
  assert.equal(accountFromAuthFile({ provider: "codex", auth_index: 7, name: "codex-x.json" }, NOW).label, "codex-x");
  assert.equal(accountFromAuthFile(codex({ runtime_only: true }), NOW), null, "a config API key has no plan windows");
});

test("accounts CPA can use come first, so many signed-out ones cannot hide them past the cap", async () => {
  // Seen live 2026-10-24: nine signed-out and three unchecked accounts filled the first 12, and the
  // one working Plus account, at 100% of its 5-hour window, was never shown.
  const signedOut = Array.from({ length: 12 }, (_, at) => codex({ auth_index: `out${at}`, email: `out${at}@example.com`, status: "error", status_message: "HTTP 401" }));
  const unseen = codex({ auth_index: "new", email: "new@example.com", quota: undefined });
  const disabled = codex({ auth_index: "off", email: "off@example.com", disabled: true });
  const full = codex({ auth_index: "full", email: "full@example.com" }, { "X-Codex-Primary-Used-Percent": "100" });
  const working = codex({ auth_index: "plus", email: "plus@example.com" });
  const { quota } = fixture({ files: [...signedOut, disabled, full, unseen, working, claude()] });
  const { accounts } = await quota.read();
  const codexIds = accounts.filter((account) => account.provider === "codex").map((account) => account.id);
  assert.equal(codexIds.length, 12, "capped per provider");
  assert.deepEqual(codexIds.slice(0, 4), ["plus", "new", "full", "off"], "ready with a reading, ready unseen, at limit, disabled, then errors");
  assert.deepEqual(codexIds.slice(4), signedOut.slice(0, 8).map((entry) => entry.auth_index), "CPA's order within a rank");
  assert.deepEqual(accounts.filter((account) => account.provider === "claude").map((account) => account.id), ["c1"], "another provider is not crowded out");
});

test("the routing pool's totals count every account, including those past the list's cap", async () => {
  // Seen live 2026-11-23: 13+ Codex accounts served requests, the list held 12 ready ones, and the
  // panel said "12/12 ready" while one more failed 55 of its 57 requests.
  const signedOut = Array.from({ length: 12 }, (_, at) => codex({ auth_index: `out${at}`, email: `out${at}@example.com`, status: "error", status_message: "HTTP 401" }));
  const full = codex({ auth_index: "full", email: "full@example.com" }, { "X-Codex-Primary-Used-Percent": "100" });
  const files = [...signedOut, codex({ auth_index: "off", disabled: true }), full, codex({ auth_index: "new", quota: undefined }), codex({ auth_index: "plus" }), claude()];
  const { accounts, pools } = await fixture({ files }).quota.read();
  assert.equal(accounts.filter((account) => account.provider === "codex").length, 12);
  assert.deepEqual(pools.codex, { total: 16, enabled: 15, ready: 2, resumesAt: Number(seconds(NOW + 3_600_000)) * 1000 }, "a switched-off account is not in the pool");
  assert.deepEqual(pools.claude, { total: 1, enabled: 1, ready: 1, resumesAt: null });
});

test("a read is cached for a short while per connection", async () => {
  const { quota, calls, advance } = fixture();
  await quota.read();
  await quota.read();
  assert.equal(calls.length, 1);
  advance(CACHE_MS);
  await quota.read();
  assert.equal(calls.length, 2);
});

test("without CPA or with a refused key it says why, and the key goes only to loopback", async () => {
  assert.deepEqual(await fixture({ connection: null }).quota.read(), { ok: true, available: false, reason: "CPA is not running" });
  assert.match((await fixture({ status: 401 }).quota.read()).reason, /refused the management key/);
  assert.match((await fixture({ status: 500 }).quota.read()).reason, /HTTP 500/);
  const remote = fixture({ connection: { baseUrl: "http://cpa.example.com:8317", managementKey: KEY } });
  assert.equal((await remote.quota.read()).available, false);
  assert.equal(remote.calls.length, 0, "a non-loopback CPA never receives the key");
});
