"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { createRegisterApi } = require("../electron/register-api.cjs");

const fixtureRoot = path.resolve(__dirname, "../../aiTemp/register-cpa-20261023/host/api-tests");
const secret = "FIXTURE_OAUTH_PRIVATE_MATERIAL";

async function fixture(t, overrides = {}) {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const base = fs.mkdtempSync(path.join(fixtureRoot, "case-"));
  const descriptorPath = path.join(base, "private/register-api.json"), calls = [];
  const host = {
    async status() { calls.push("status"); return { ready: false, owned: false, starting: false, error: "Bearer " + secret }; },
    async start() { calls.push("start"); return { ready: true, owned: true, starting: false }; },
    async request(method, route, body) {
      calls.push({ method, route, body });
      if (route.endsWith("accounts")) return { accounts: [{ id: 7, email: "fixture@example.invalid", eligible: true, revision: "rev-1" }] };
      if (route.endsWith("export")) return { files: [{ account_id: 7, name: "fixture.json", revision: "rev-1", json: { refresh_token: secret } }] };
      return { results: [{ id: 7, ok: false, requires_login: true, error: "login_required" }] };
    }, ...overrides,
  };
  const api = createRegisterApi({ host, descriptorPath });
  await api.start();
  let descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  const call = (method, route, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const request = http.request({ hostname: "127.0.0.1", port: new URL(descriptor.url).port, method, path: route,
      headers: { authorization: "Bearer " + descriptor.token, ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}), ...headers },
    }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; }); response.on("error", reject);
      response.on("end", () => { try { resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }); } catch (failure) { reject(failure); } });
    });
    request.on("error", reject); request.setTimeout(3000, () => request.destroy(new Error("Fixture request deadline")));
    request.end(payload);
  });
  t.after(async () => {
    await api.close();
    assert.ok(base.startsWith(fixtureRoot + path.sep)); fs.rmSync(base, { recursive: true, force: true });
  });
  return { api, host, base, descriptorPath, calls, call, descriptor: () => descriptor,
    reloadDescriptor() { descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8")); return descriptor; } };
}

test("private descriptor has a scoped rotating token and a persisted source identity; status never starts Register", async t => {
  const f = await fixture(t), initial = f.descriptor();
  assert.equal(initial.schema_version, 1); assert.match(initial.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(initial.source_id, /^[a-f0-9-]{36}$/); assert.equal(new URL(initial.url).hostname, "127.0.0.1");
  const result = await f.call("GET", "/v1/status");
  assert.equal(result.status, 200); assert.equal(result.body.source_id, initial.source_id);
  assert.deepEqual(f.calls, ["status"]); assert.equal(result.body.ready, false);
  assert.equal(result.body.error, "register_unavailable"); assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(initial.token), false); assert.equal(result.headers["cache-control"], "no-store");
  await f.api.close(); assert.equal(fs.existsSync(f.descriptorPath), false);
  const publicValue = await f.api.recoverAfterCancelledQuit();
  const restarted = f.reloadDescriptor();
  assert.equal(publicValue.source_id, initial.source_id); assert.equal(publicValue.token, undefined);
  assert.equal(restarted.source_id, initial.source_id); assert.notEqual(restarted.token, initial.token);
  assert.equal((await f.call("GET", "/v1/status", undefined, { authorization: "Bearer " + initial.token })).status, 401);
  await f.api.close();
  const replacement = createRegisterApi({ host: f.host, descriptorPath: f.descriptorPath });
  t.after(() => replacement.close()); await replacement.start();
  assert.equal(JSON.parse(fs.readFileSync(f.descriptorPath)).source_id, initial.source_id);
});

test("bridge rejects missing credentials, browser origins and rebinding before any host operation", async t => {
  const f = await fixture(t);
  for (const headers of [{ authorization: "" }, { authorization: "Bearer invalid" }]) {
    assert.equal((await f.call("POST", "/v1/start", {}, headers)).status, 401);
  }
  for (const headers of [{ origin: "http://evil.invalid" }, { origin: "null" }, { "sec-fetch-site": "none" }, { host: "evil.invalid" }]) {
    assert.equal((await f.call("POST", "/v1/start", {}, headers)).status, 403);
  }
  assert.deepEqual(f.calls, []);
});

test("only the five exact routes and methods exist; invalid bodies never execute operations", async t => {
  const f = await fixture(t);
  for (const [method, route] of [["GET", "/v1/start"], ["POST", "/v1/accounts"], ["POST", "/v1/stop"], ["GET", "/v1/accounts?ids=7"], ["GET", "http://evil.invalid/v1/accounts"], ["GET", "/v1/%61ccounts"]]) {
    assert.equal((await f.call(method, route, {})).status, 404);
  }
  assert.equal((await f.call("POST", "/v1/start", { unsafe: true })).status, 400);
  assert.equal((await f.call("POST", "/v1/start", "{")).status, 400);
  assert.equal((await f.call("POST", "/v1/start", {}, { "content-type": "text/plain" })).status, 415);
  assert.equal((await f.call("POST", "/v1/export", { ids: [7], padding: "x".repeat(9000) })).status, 413);
  assert.deepEqual(f.calls, []);
});

test("explicit IDs reject empty, duplicate, noninteger, broad and oversized account selections", async t => {
  const f = await fixture(t);
  for (const body of [{}, { ids: [] }, { ids: [0] }, { ids: [-1] }, { ids: [1.5] }, { ids: ["7"] }, { ids: [7, 7] }, { ids: [Number.MAX_SAFE_INTEGER + 1] }, { ids: [7], all: true }, { ids: Array.from({ length: 101 }, (_, index) => index + 1) }]) {
    for (const route of ["/v1/export", "/v1/refresh"]) assert.equal((await f.call("POST", route, body)).status, 400);
  }
  assert.deepEqual(f.calls, []);
});

test("authenticated start, summaries, selected OAuth export and noninteractive refresh use only fixed host routes", async t => {
  const f = await fixture(t);
  assert.equal((await f.call("POST", "/v1/start", {})).status, 200);
  const accounts = await f.call("GET", "/v1/accounts");
  assert.equal(accounts.status, 200); assert.equal(accounts.body.accounts[0].id, 7);
  assert.equal(JSON.stringify(accounts).includes(secret), false);
  const exported = await f.call("POST", "/v1/export", { ids: [7] });
  assert.equal(exported.status, 200); assert.equal(exported.body.files[0].json.refresh_token, secret);
  const refreshed = await f.call("POST", "/v1/refresh", { ids: [7] });
  assert.equal(refreshed.status, 200); assert.equal(refreshed.body.results[0].requires_login, true);
  assert.deepEqual(f.calls, ["start", { method: "GET", route: "/api/coding-tools/accounts", body: undefined },
    { method: "POST", route: "/api/coding-tools/export", body: { ids: [7] } }, { method: "POST", route: "/api/coding-tools/refresh", body: { ids: [7] } }]);
  for (const result of [accounts, exported, refreshed]) assert.equal(result.body.source_id, f.descriptor().source_id);
});

test("upstream failures never expose exceptions or oversized payloads", async t => {
  const f = await fixture(t, { async request() { throw new Error(secret); } });
  const failed = await f.call("GET", "/v1/accounts");
  assert.equal(failed.status, 502); assert.equal(failed.body.error, "register_request_failed");
  assert.equal(JSON.stringify(failed).includes(secret), false);
  f.host.request = async () => ({ files: ["x".repeat(8 * 1024 * 1024)] });
  assert.equal((await f.call("POST", "/v1/export", { ids: [7] })).status, 502);
});

test("close cancels pending forwarding, removes its descriptor and can restart after cancelled quit", async t => {
  let entered, forwardedSignal;
  const reached = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { request(_method, _route, _body, { signal }) {
    forwardedSignal = signal; entered();
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error(secret)), { once: true }));
  } });
  const pending = f.call("POST", "/v1/refresh", { ids: [7] }); pending.catch(() => {});
  await reached; await f.api.close();
  assert.equal(forwardedSignal.aborted, true); assert.equal(fs.existsSync(f.descriptorPath), false);
  await assert.rejects(pending);
  await f.api.recoverAfterCancelledQuit(); f.reloadDescriptor();
  assert.equal((await f.call("GET", "/v1/status")).status, 200);
});

test("malformed source identity is not silently replaced and a foreign descriptor is not removed", async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.descriptorPath, JSON.stringify({ source_id: f.descriptor().source_id, token: "foreign-owner" }));
  await f.api.close(); assert.equal(fs.existsSync(f.descriptorPath), true);
  fs.writeFileSync(path.join(path.dirname(f.descriptorPath), "register-source.json"), "not json");
  const broken = createRegisterApi({ host: f.host, descriptorPath: f.descriptorPath });
  await assert.rejects(broken.start(), /source identity/); await broken.close();
});
