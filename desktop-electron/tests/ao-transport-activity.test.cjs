const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");

function hostFixture(probe = async () => ({ ok: true })) {
  const helpers = source.slice(source.indexOf("  async function chatHostGone"), source.indexOf("  // Mission-owned AO calls."));
  const identity = source.slice(source.indexOf("  const sessionId ="), source.indexOf("  async function projectFor"));
  const records = new Map([["session", JSON.stringify({ address: "127.0.0.1:32100" })]]);
  const calls = [], forbidden = [];
  let clock = 10000;
  const read = async file => {
    const id = path.basename(path.dirname(file));
    if (!records.has(id)) throw new Error("ENOENT");
    return records.get(id);
  };
  const context = {
    path, Buffer, dataRoot: path.resolve(__dirname, "../aiTemp/host-probe-fixture"),
    fs: { promises: { readFile: read, readdir: async () => [...records.keys()] },
      readdirSync() { forbidden.push("readdirSync"); throw new Error("Synchronous host inventory read"); },
      readFileSync() { forbidden.push("readFileSync"); throw new Error("Synchronous host record read"); } },
    net: { connect() { forbidden.push("connect"); throw new Error("Main-thread socket was used"); } },
    probeTcpOffThread: async request => { calls.push(request); return probe(request); },
    Date: class extends Date { static now() { return clock; } },
  };
  const api = vm.runInNewContext(helpers + identity + "({chatHostGone,chatHostAlive,survivingChatHosts})", context);
  return { api, records, calls, forbidden, advance: ms => { clock += ms; } };
}

for (const [code, gone, alive] of [[null, false, true], ["ECONNREFUSED", true, false], ["ETIMEDOUT", false, true], ["EACCES", false, false]]) {
  test(`host probes run off main and preserve ${code || "accepted"} evidence`, async () => {
    const world = hostFixture(async () => code ? { ok: false, code } : { ok: true });
    assert.equal(await world.api.chatHostGone("session"), gone);
    assert.equal(await world.api.chatHostAlive("session"), alive);
    assert.equal(world.calls.length, 2);
    assert.ok(world.calls.every(call => call.host === "127.0.0.1" && call.port === 32100 && call.timeoutMs === 1500));
    assert.deepEqual(world.forbidden, []);
  });
}

test("simultaneous alive/gone checks of the same host share one worker probe", async () => {
  let release;
  const reply = new Promise(resolve => { release = resolve; });
  const world = hostFixture(() => reply);
  const reads = [world.api.chatHostGone("session"), world.api.chatHostGone("session"), world.api.chatHostAlive("session")];
  const result = Promise.all(reads);
  void result.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(world.calls.length, 1);
  release({ ok: true });
  assert.deepEqual(await result, [false, false, true]);
  assert.deepEqual(world.forbidden, []);
});

test("only explicit positive-reuse checks use the TTL; own sends and new host addresses still probe", async () => {
  const world = hostFixture();
  assert.equal(await world.api.chatHostGone("session", { reuseAliveMs: 10000 }), false);
  world.advance(1);
  await world.api.chatHostGone("session", { reuseAliveMs: 10000 });
  assert.equal(world.calls.length, 1);
  await world.api.chatHostAlive("session");
  assert.equal(world.calls.length, 2, "an explicit ownership check stays fresh");
  world.records.set("session", JSON.stringify({ address: "127.0.0.1:32101" }));
  await world.api.chatHostGone("session", { reuseAliveMs: 10000 });
  assert.equal(world.calls.length, 3);
  world.advance(10001);
  await world.api.chatHostGone("session", { reuseAliveMs: 10000 });
  assert.equal(world.calls.length, 4);
});

test("missing, corrupt and invalid host addresses never prove a dead host or open a socket", async () => {
  for (const record of [null, "broken JSON", {}, { address: "127.0.0.1:0" }, { address: "127.0.0.1:65536" }, { address: "example.test:32100" }]) {
    const world = hostFixture();
    if (record === null) world.records.delete("session");
    else world.records.set("session", typeof record === "string" ? record : JSON.stringify(record));
    assert.equal(await world.api.chatHostGone("session"), false);
    assert.equal(await world.api.chatHostAlive("session"), false);
    assert.equal(world.calls.length, 0);
    assert.deepEqual(world.forbidden, []);
  }
});

test("startup survivor inventory reads asynchronously and counts only accepted worker probes", async () => {
  const world = hostFixture(async request => request.port === 32100 ? { ok: true } : { ok: false, code: "ETIMEDOUT" });
  world.records.set("slow", JSON.stringify({ address: "127.0.0.1:32101" }));
  world.records.set("invalid", JSON.stringify({ address: "127.0.0.1:99999" }));
  assert.equal(await world.api.survivingChatHosts(), 1);
  assert.equal(world.calls.length, 2);
  assert.deepEqual(world.forbidden, []);
});

function requestFixture(fetchOffThread) {
  const method = source.slice(source.indexOf("  async function requestApi"), source.indexOf("  // AO's error envelope"));
  return vm.runInNewContext(method + "requestApi", { Buffer, AbortSignal, state: "ready", daemonPort: 32100,
    AO_RESPONSE_MAX_BYTES: 16 * 1024 * 1024, dropInlineBlobs() {}, fetchOffThread });
}

for (const [endpoint, options, limit] of [["/api/v1/sessions", {}, 900000],
  ["/api/v1/sessions/session/conversation?limit=100", {}, 16 * 1024 * 1024],
  ["/api/v1/sessions/session/conversation?limit=1", { maxBytes: 32 * 1024 * 1024 }, 32 * 1024 * 1024]]) {
  test(`AO transport enforces its ${limit}-byte limit before a response crosses the worker boundary`, async () => {
    let seen;
    const request = requestFixture(async (_url, input) => { seen = input; return { ok: true, status: 200, text: async () => "{}" }; });
    await request("GET", endpoint, undefined, options);
    assert.equal(seen.maxBytes, limit);
  });
}

test("an oversized worker response keeps the existing handler-limit recovery error", async () => {
  const request = requestFixture(async () => { throw Object.assign(new RangeError("worker size bound"), { code: "ERR_RESPONSE_TOO_LARGE" }); });
  await assert.rejects(request("GET", "/api/v1/sessions/session/conversation?limit=100"),
    /AO response exceeds the handler limit \(GET \/api\/v1\/sessions\/session\/conversation\)/);
});

test("the post-read UTF-8 check remains for transports that ignore the worker's byte budget", async () => {
  const request = requestFixture(async () => ({ ok: true, status: 200, text: async () => "界".repeat(300001) }));
  await assert.rejects(request("GET", "/api/v1/sessions"), /AO response exceeds the handler limit/);
});
