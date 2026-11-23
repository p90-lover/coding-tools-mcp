"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createCpaQuota } = require("../electron/cpa-quota.cjs");

const NOW = 1_800_000_000_000;
const first = { baseUrl: "http://127.0.0.1:8317", managementKey: "fixture-first" };
const second = { baseUrl: "http://127.0.0.1:8318", managementKey: "fixture-second" };
const account = (label, checkedAt = NOW) => ({ provider: "codex", auth_index: "same-index", email: label,
  quota: { observed_at: new Date(checkedAt).toISOString(), signals: { "X-Codex-Primary-Used-Percent": "10", "X-Codex-Primary-Window-Minutes": "300" } } });
const response = (files) => ({ ok: true, status: 200, json: async () => ({ files }) });

function fixture(fetchImpl) {
  let connection = first;
  const calls = [];
  const quota = createCpaQuota({
    getConnection: () => connection, now: () => NOW, logger: { warn() {} },
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      return fetchImpl(url, init);
    },
  });
  return { quota, calls, connect: (next) => { connection = next; } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a disconnected CPA cannot reuse a warm quota cache, and reconnecting reads again", async () => {
  let label = "before@example.test";
  const { quota, calls, connect } = fixture(async () => response([account(label)]));
  assert.equal((await quota.read()).accounts[0].label, label);
  connect(null);
  assert.deepEqual(await quota.read(), { ok: true, available: false, reason: "CPA is not running" });
  assert.equal(calls.length, 1, "a disconnected read sends nothing");
  label = "after@example.test";
  connect({ ...first });
  assert.equal((await quota.read()).accounts[0].label, label);
  assert.equal(calls.length, 2, "a reconnect does not inherit the old cache");
});

test("changing either the CPA origin or management key invalidates cached accounts", async (t) => {
  for (const changed of [{ ...first, baseUrl: second.baseUrl }, { ...first, managementKey: second.managementKey }]) {
    await t.test(changed.baseUrl === first.baseUrl ? "management key" : "origin", async () => {
      const { quota, calls, connect } = fixture(async (_url, init) => response([account(init.headers.Authorization)]));
      await quota.read();
      connect(changed);
      const result = await quota.read();
      assert.equal(calls.length, 2);
      assert.equal(calls[1].url, `${changed.baseUrl}/v0/management/auth-files`);
      assert.equal(result.accounts[0].label, `Bearer ${changed.managementKey}`);
      await quota.read();
      assert.equal(calls.length, 2, "the new connection still gets a cache");
    });
  }
});

test("a disallowed CPA origin cannot reuse a warm cache or receive the management key", async () => {
  const { quota, calls, connect } = fixture(async () => response([account("local@example.test")]));
  await quota.read();
  connect({ ...second, baseUrl: "https://example.test" });
  assert.equal((await quota.read()).available, false);
  assert.equal(calls.length, 1);
});

test("a changed connection starts its own read and rejects an older response that finishes late", { timeout: 5_000 }, async () => {
  const old = deferred();
  const { quota, calls, connect } = fixture(async (_url, init) => init.headers.Authorization === `Bearer ${first.managementKey}`
    ? old.promise : response([account("new@example.test")]));
  const before = quota.read();
  connect(second);
  const current = await quota.read();
  assert.equal(current.accounts[0].label, "new@example.test");
  old.resolve(response([account("old@example.test", NOW - 60_000)]));
  const superseded = await before;
  assert.equal(superseded.available, false, "a late response must not redisplay the old account");
  assert.match(superseded.reason, /connection changed/i);
  assert.equal((await quota.read()).accounts[0].label, "new@example.test");
  assert.equal(calls.length, 2, "the superseded account is not cached on the new connection");
});

test("disconnecting while a read is pending rejects its late account list", { timeout: 5_000 }, async () => {
  const old = deferred();
  const { quota, connect } = fixture(async () => old.promise);
  const before = quota.read();
  connect(null);
  assert.equal((await quota.read()).available, false);
  old.resolve(response([account("old@example.test")]));
  assert.equal((await before).available, false);
});

test("reading limits never asks CPA to contact a provider or change anything", async () => {
  const { quota, calls, connect } = fixture(async () => response([account("stale@example.test", NOW - 3_600_000)]));
  await quota.read();
  connect(second);
  await quota.read();
  await settle();
  assert.deepEqual(calls.map((call) => [call.method, new URL(call.url).pathname]),
    [["GET", "/v0/management/auth-files"], ["GET", "/v0/management/auth-files"]], "an old reading is shown as it is, not refreshed");
});

test("unchanged connections still share concurrent reads even when the connection object is replaced", async () => {
  const pending = deferred();
  const { quota, calls, connect } = fixture(async () => pending.promise);
  const before = quota.read();
  connect({ ...first });
  const joined = quota.read();
  assert.equal(calls.length, 1);
  pending.resolve(response([account("same@example.test")]));
  assert.deepEqual(await before, await joined);
  await quota.read();
  assert.equal(calls.length, 1);
});
