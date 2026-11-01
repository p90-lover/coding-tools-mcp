"use strict";
// Runs only fixture accounts in an explicitly isolated CPA process; never reads a user config.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");

const project = path.resolve(__dirname, "../../../..");
const work = process.env.REGISTER_PLUGIN_TEST_WORK;
const executable = process.env.CPA_TEST_EXECUTABLE;
assert.ok(work && path.isAbsolute(work) && work.toLowerCase().startsWith(path.join(project, "aiTemp").toLowerCase() + path.sep), "REGISTER_PLUGIN_TEST_WORK must be under project aiTemp");
assert.ok(executable && path.isAbsolute(executable), "CPA_TEST_EXECUTABLE must identify the pinned fixture binary");
fs.mkdirSync(work, { recursive: true });
const directory = fs.mkdtempSync(path.join(work, "fixture-"));
const authDir = path.join(directory, "auth");
const pluginDir = path.join(directory, "plugins");
fs.mkdirSync(authDir); fs.mkdirSync(pluginDir);
const dll = path.resolve(__dirname, "../../bundled/cpa-plugins/windows/amd64/register_plugins-v0.1.0-codingtools.1.dll");
fs.copyFileSync(dll, path.join(pluginDir, path.basename(dll)));
const sourceID = "fixture-source-native-0001";
const bridgeToken = "fixture-native-bearer-not-production-00000001";
const managementKey = "fixture-cpa-management-not-production-00000001";
const calls = [];
let revision = "revision-1";
let access = "fixture-register-original";
let child;
let exited;
let childClosed = false;
let output = "";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const close = server => new Promise(resolve => server.close(resolve));
const fixture = http.createServer(async (request, response) => {
  try {
    if (/^https?:/.test(request.url)) { response.writeHead(502); response.end(); return; }
    assert.equal(request.headers.authorization, "Bearer " + bridgeToken);
    assert.equal(request.headers.origin, undefined);
    let body = "";
    for await (const chunk of request) { body += chunk; assert.ok(body.length < 16384); }
    const payload = body ? JSON.parse(body) : null;
    calls.push({ path: request.url, method: request.method, ids: payload?.ids });
    const value = { source_id: sourceID };
    if (request.url === "/v1/status" || request.url === "/v1/start") Object.assign(value, { ready: true, owned: true });
    else if (request.url === "/v1/accounts") value.accounts = [1, 2].map(id => ({ id, email: `fixture-${id}@example.invalid`, eligible: true, revision }));
    else if (request.url === "/v1/export") {
      assert.ok(Array.isArray(payload.ids) && payload.ids.length > 0 && payload.ids.every(id => id === 1 || id === 2));
      value.files = payload.ids.map(id => ({ account_id: id, revision, name: "source-name-ignored.json", json: { type: "codex", email: `fixture-${id}@example.invalid`, account_id: `fixture-account-${id}`, access_token: access, refresh_token: "fixture-not-a-real-refresh-token", id_token: "", expired: "2999-01-01T00:00:00Z", last_refresh: "2026-10-23T00:00:00Z" } }));
    } else if (request.url === "/v1/refresh") {
      assert.deepEqual(payload.ids, [1]); revision = "revision-2"; access = "fixture-register-renewed";
      value.results = payload.ids.map(id => ({ id, ok: true }));
    } else throw new Error("unexpected fixture route");
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(value));
  } catch {
    response.writeHead(400); response.end(JSON.stringify({ error: "fixture_request_failed" }));
  }
});
fixture.on("connect", (_, socket) => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));

(async () => {
  const bridgePort = await listen(fixture);
  const reservation = net.createServer(); const port = await listen(reservation); await close(reservation);
  const descriptor = path.join(directory, "bridge.json");
  fs.writeFileSync(descriptor, JSON.stringify({ schema_version: 1, url: `http://127.0.0.1:${bridgePort}`, token: bridgeToken, source_id: sourceID }), { mode: 0o600 });
  const config = [
    'host: "127.0.0.1"', `port: ${port}`, `auth-dir: ${JSON.stringify(authDir)}`,
    'api-keys: ["fixture-proxy-key-not-production"]', "remote-management:", "  allow-remote: false", `  secret-key: ${JSON.stringify(managementKey)}`, "  disable-control-panel: true", "  disable-auto-update-panel: true",
    "logging-to-file: false", "request-log: false", "commercial-mode: true", "usage-statistics-enabled: false",
    "plugins:", "  enabled: true", `  dir: ${JSON.stringify(pluginDir)}`, "  configs:", "    register_plugins:", "      enabled: true", `      bridge-descriptor: ${JSON.stringify(descriptor)}`, `      data-dir: ${JSON.stringify(path.join(directory, "state"))}`, "",
  ].join("\n");
  const configPath = path.join(directory, "config.yaml"); fs.writeFileSync(configPath, config, { mode: 0o600 });
  const blockedProxy = `http://127.0.0.1:${bridgePort}`;
  child = spawn(executable, ["-config", configPath], { cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HTTP_PROXY: blockedProxy, HTTPS_PROXY: blockedProxy, ALL_PROXY: blockedProxy, NO_PROXY: "127.0.0.1,localhost" } });
  exited = new Promise(resolve => child.once("exit", (code, signal) => { childClosed = true; resolve({ code, signal }); }));
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-64000); });
  child.once("error", error => { output += error.message; });
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: "Bearer " + managementKey };
  async function api(route, method = "GET", body, expected = 200) {
    const response = await fetch(base + "/v0/management/register_plugins" + route, { method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, expected, `unexpected status at ${route}`);
    if (expected !== 200) return null;
    return response.json();
  }
  let ready = false;
  const deadline = Date.now() + 30000;
  for (let i = 0; i < 100 && Date.now() < deadline; i++) {
    if (child.exitCode !== null) break;
    try { if ((await api("/api/settings")).interval_seconds === 900) { ready = true; break; } } catch {}
    await wait(100);
  }
  assert.ok(ready, "native plugin did not load in pinned CPA");
  assert.match(output, /Version:\s*v?8\.0\.32\b/, "native smoke requires the pinned CPA version");
  assert.equal(calls.length, 0, "loading plugin started automatic account work");
  const unauthorized = await fetch(base + "/v0/management/register_plugins/api/settings"); assert.equal(unauthorized.status, 401);
  const page = await fetch(base + "/v0/management/register_plugins/index.html", { headers }); assert.equal(page.status, 200); assert.match(await page.text(), /Import selected/);
  const resources = await fetch(base + "/v0/resource/plugins/register_plugins/index.html"); assert.equal(resources.status, 200);
  assert.equal((await api("/api/settings")).auto_import, false);
  await api("/api/sync", "GET", null, 404);
  await api("/api/sync", "POST", { ids: [] }, 400);
  const first = await api("/api/sync", "POST", { ids: [1] }); assert.equal(first.results[0].state, "imported");
  const names = fs.readdirSync(authDir).filter(name => name.endsWith(".json")); assert.equal(names.length, 1);
  const authPath = path.join(authDir, names[0]);
  const firstAuth = JSON.parse(fs.readFileSync(authPath, "utf8")); assert.equal(firstAuth._register_plugins.source_id, sourceID);
  assert.equal((await api("/api/sync", "POST", { ids: [1] })).results[0].state, "unchanged");
  const renewed = await api("/api/refresh", "POST", { ids: [1, 2] }); assert.ok(renewed.results.some(item => item.id === 1 && item.state === "imported")); assert.ok(renewed.results.some(item => item.id === 2 && item.state === "missing"));
  let stored = JSON.parse(fs.readFileSync(authPath, "utf8")); assert.equal(stored.access_token, "fixture-register-renewed");
  stored.disabled = true; fs.writeFileSync(authPath, JSON.stringify(stored)); await wait(500);
  const refreshCount = calls.filter(call => call.path === "/v1/refresh").length;
  assert.equal((await api("/api/refresh", "POST", { ids: [1] })).results[0].state, "disabled");
  assert.equal(calls.filter(call => call.path === "/v1/refresh").length, refreshCount);
  stored.disabled = false; stored.access_token = "fixture-CPA-independent-rotation"; fs.writeFileSync(authPath, JSON.stringify(stored)); await wait(500);
  assert.equal((await api("/api/sync", "POST", { ids: [1] })).results[0].state, "cpa_newer");
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).access_token, stored.access_token);
  const status = JSON.stringify(await api("/api/status")); assert.ok(!status.includes(access) && !status.includes(bridgeToken) && !status.includes("fixture-CPA-independent-rotation"));
  await api("/api/settings", "POST", { auto_import: false, auto_refresh: false, interval_seconds: 120 });
  const state = JSON.parse(fs.readFileSync(path.join(directory, "state/state.json"), "utf8")); assert.equal(state.settings.interval_seconds, 120);
  const receipt = { ok: true, binaryVersion: "8.0.32", pluginSHA256: createHash("sha256").update(fs.readFileSync(dll)).digest("hex"), source: "fixture-only", checks: ["native-load", "management-auth", "console", "automation-off", "explicit-ids", "host-auth-save", "idempotence", "owned-refresh", "disabled-preservation", "CPA-rotation-preservation", "sanitized-status", "persistent-settings"], bridgeCalls: calls.map(call => ({ ...call })), pid: child.pid };
  fs.writeFileSync(path.join(work, "native-result.json"), JSON.stringify(receipt, null, 2));
  process.stdout.write(JSON.stringify({ ok: true, checks: receipt.checks.length, pluginSHA256: receipt.pluginSHA256 }) + "\n");
})().catch(error => {
  fs.writeFileSync(path.join(work, "native-failure.json"), JSON.stringify({ error: error.message, log: output.replaceAll(bridgeToken, "[redacted]").replaceAll(managementKey, "[redacted]") }, null, 2));
  process.stderr.write(error.message + "\n"); process.exitCode = 1;
}).finally(async () => {
  if (child && child.exitCode === null) child.kill();
  if (exited) await Promise.race([exited, wait(5000)]);
  await close(fixture);
  if (!child || childClosed) fs.rmSync(directory, { recursive: true, force: true });
});
