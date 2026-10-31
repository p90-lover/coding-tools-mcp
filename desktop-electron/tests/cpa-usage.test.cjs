"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  createCpaUsage, aggregateUsage, summarizeRecords, clineQuotaOf, priceFor, estimateCost, cellCost, modelKey, RANGES,
} = require("../electron/cpa-usage.cjs");
const { MODEL_PRICES } = require("../electron/cpa-model-prices.cjs");

const KEY = "mgmt-key-never-leaves";
const NOW = 1_800_000_000_000;

/** One group of CPA Helper's /cpa-helper/rankings, as its Agg::to_value writes it. */
function agg(key, overrides = {}) {
  return {
    key, label: key, extra: "", requests: 10, success: 10, failed: 0,
    input_tokens: 1_000_000, output_tokens: 100_000, cached_tokens: 400_000, reasoning_tokens: 0, total_tokens: 1_100_000,
    cost_usd: 0, unpriced: 10, avg_ttft_ms: null, avg_latency_ms: null, share: 1, ...overrides,
  };
}

test("the price table matches a model by its own name, whatever CPA prefix or effort suffix it carries", () => {
  assert.equal(modelKey("cpa/codex/gpt-5.1-codex(high)"), "gpt-5.1-codex");
  assert.equal(modelKey("cline-pass/glm-5.3"), "glm-5.3");
  assert.equal(priceFor("cpa/codex/gpt-5.1-codex(high)").label, "GPT-5 / 5.1");
  assert.equal(priceFor("gpt-5.1-codex-mini").label, "GPT-5 mini");
  assert.equal(priceFor("gpt-5.5").label, "GPT-5.2+");
  assert.equal(priceFor("claude-opus-5-5").label, "Claude Opus 5.5");
  assert.equal(priceFor("claude-opus-4-1-20250805").label, "Claude Opus 4 / 4.1");
  assert.equal(priceFor("claude-opus-4-7").label, "Claude Opus 4.5–5");
  assert.equal(priceFor("claude-sonnet-4-5-20250929").label, "Claude Sonnet 3.7–4.6");
  assert.equal(priceFor("gemini-2.5-flash-lite").label, "Gemini 2.5 Flash-Lite");
  assert.equal(priceFor("cline-pass/deepseek-v4-pro").label, "DeepSeek");
  assert.equal(priceFor("cline-pass/qwen3.8-max").label, "Qwen Max");
  assert.equal(priceFor("totally-new-model"), null, "an unknown model gets no price");
  assert.equal(priceFor(""), null);
  for (const row of MODEL_PRICES) {
    assert.ok(row.label && row.pattern instanceof RegExp, "each row has a label and a pattern");
    for (const rate of [row.input, row.output, row.cachedInput]) assert.ok(Number.isFinite(rate) && rate >= 0, `${row.label} rates are numbers`);
  }
});

test("an estimate prices cached input at the cache rate and the rest at list price", () => {
  const price = { input: 2, cachedInput: 0.2, output: 10 };
  // 600K fresh * $2 + 400K cached * $0.2 + 100K out * $10 = 1.2 + 0.08 + 1.0
  assert.equal(estimateCost({ inputTokens: 1_000_000, cachedTokens: 400_000, outputTokens: 100_000 }, price), 2.28);
  assert.equal(estimateCost({ inputTokens: 100, cachedTokens: 500, outputTokens: 0 }, price), 100 * 0.2 / 1e6, "cached never exceeds input");
  assert.equal(estimateCost({ inputTokens: 1_000_000 }, { input: 3, output: 15 }), 3, "no cache rate: cached input at list price");
  assert.equal(estimateCost({ inputTokens: 5 }, null), null);
});

test("CPA Helper's own price wins when it priced every request; otherwise the table estimates", () => {
  const priced = { requests: 4, totalTokens: 10, inputTokens: 10, outputTokens: 0, cachedTokens: 0, helperCost: 1.5, unpriced: 0 };
  assert.deepEqual(cellCost(priced, "unknown-model"), { cost: 1.5, source: "cpa-helper", partial: false });
  const unpriced = { ...priced, helperCost: 0, unpriced: 4, inputTokens: 1_000_000 };
  assert.deepEqual(cellCost(unpriced, "claude-sonnet-5"), { cost: 2, source: "estimate", partial: false });
  assert.deepEqual(cellCost(unpriced, "unknown-model"), { cost: null, source: null, partial: true });
  assert.deepEqual(cellCost({ ...unpriced, helperCost: 0.4 }, "unknown-model"), { cost: 0.4, source: "cpa-helper", partial: true });
  assert.deepEqual(cellCost({ requests: 0, totalTokens: 0 }, "x"), { cost: 0, source: null, partial: false });
});

test("usage is grouped per account and model, joined to CPA's accounts and the Codex quota, with totals", () => {
  const result = aggregateUsage({
    authRows: [
      agg("idx-codex", { label: "me@example.com", extra: "oauth" }),
      agg("idx-key", { label: "sk-live-raw-upstream-key-1234567890", requests: 2, input_tokens: 10, output_tokens: 5, cached_tokens: 0, total_tokens: 15 }),
    ],
    modelsByAuth: new Map([
      ["idx-codex", [
        agg("gpt-5.1-codex", { extra: "codex", requests: 6, input_tokens: 800_000, cached_tokens: 400_000, output_tokens: 80_000, total_tokens: 880_000, unpriced: 6 }),
        agg("brand-new-model", { extra: "codex", requests: 4, input_tokens: 200_000, cached_tokens: 0, output_tokens: 20_000, total_tokens: 220_000, unpriced: 4 }),
      ]],
    ]),
    modelRows: [agg("gpt-5.1-codex", { extra: "codex", cost_usd: 3, unpriced: 0 })],
    authFiles: [
      { name: "codex-me.json", auth_index: "idx-codex", provider: "codex", email: "me@example.com" },
      { name: "claude-quiet.json", auth_index: "idx-quiet", provider: "claude", email: "quiet@example.com", disabled: true },
    ],
    codexAccounts: [{ id: "idx-codex", label: "me@example.com", plan: "plus", paused: false, disabled: false,
      session: { usedPercent: 40, resetsAt: NOW, windowSeconds: 18_000 }, week: null, checkedAt: NOW - 1, error: null }],
  });
  const [codex, other, quiet] = result.accounts;
  assert.equal(codex.id, "idx-codex");
  assert.equal(codex.label, "me@example.com");
  assert.equal(codex.provider, "codex");
  assert.equal(codex.requests, 10);
  assert.equal(codex.totalTokens, 1_100_000);
  // gpt-5.1: 400K * 1.25 + 400K * 0.125 + 80K * 10 = 0.5 + 0.05 + 0.8; the unknown model has no price.
  assert.equal(codex.cost, 1.35);
  assert.equal(codex.costSource, "estimate");
  assert.equal(codex.costPartial, true, "the unknown model's tokens are not in the cost");
  assert.deepEqual(codex.models.map((model) => [model.model, model.cost, model.priceLabel]),
    [["gpt-5.1-codex", 1.35, "GPT-5 / 5.1"], ["brand-new-model", null, null]]);
  assert.deepEqual(codex.quota, { kind: "codex", plan: "plus", paused: false,
    session: { usedPercent: 40, resetsAt: NOW, windowSeconds: 18_000 }, week: null, checkedAt: NOW - 1, error: null });

  assert.equal(other.label, "Account idx-key", "a usage source that is not an email (an API key) is never a label");
  assert.equal(other.cost, null);
  assert.equal(quiet.label, "quiet@example.com", "an account without use still shows");
  assert.equal(quiet.requests, 0);
  assert.equal(quiet.disabled, true);

  assert.equal(result.totals.requests, 12);
  assert.equal(result.totals.totalTokens, 1_100_015);
  assert.equal(result.totals.cost, 1.35);
  assert.equal(result.totals.costPartial, true);
  assert.deepEqual(result.models.map((model) => [model.model, model.cost, model.costSource]), [["gpt-5.1-codex", 3, "cpa-helper"]]);
  assert.ok(!JSON.stringify(result).includes("sk-live-raw-upstream-key"), "no upstream key reaches the renderer");
});

test("Cline Pass: the switcher's keys show their activity, a key at its limit is told apart, and no key leaks", () => {
  const payload = {
    mode: "single", active: 1,
    accounts: [
      { name: "main", key: "cline-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", enabled: true },
      { name: "backup", key: "cline-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", enabled: true },
      { name: "spare", key: "cline-secret-cccc", enabled: false },
      { name: "new", key: "cline-secret-dddd", enabled: true },
    ],
    stats: {
      main: { requests: 40, lastUsed: NOW - 60_000, lastError: "429 Too Many Requests: rate limited, Bearer abcdefabcdefabcdefabcdefabcdefabcdef" },
      backup: { requests: 12, lastUsed: NOW - 5_000, lastError: null },
      spare: { requests: 3, lastUsed: NOW - 86_400_000, lastError: "Unauthorized" },
    },
  };
  const quota = clineQuotaOf(payload);
  assert.equal(quota.kind, "cline");
  assert.equal(quota.reported, false, "Cline reports no remaining quota for a Cline Pass key");
  assert.equal(quota.mode, "single");
  assert.deepEqual(quota.accounts.map((account) => [account.name, account.active, account.requests, account.state]), [
    ["main", false, 40, "limited"], ["backup", true, 12, "ok"], ["spare", false, 3, "disabled"], ["new", false, 0, "unused"],
  ]);
  assert.equal(quota.accounts[0].lastUsedAt, NOW - 60_000);
  const text = JSON.stringify(quota);
  assert.ok(!text.includes("cline-secret") && !text.includes("abcdefabcdef"), "no Cline key, nor a token quoted in an error");
  assert.equal(clineQuotaOf({ ...payload, mode: "roundrobin" }).accounts.filter((account) => account.active).length, 3);
  assert.equal(clineQuotaOf({ accounts: [{ name: "x", key: "k", enabled: true }], stats: { x: { requests: 1, lastError: "invalid api key" } } }).accounts[0].state, "signed-out");
  assert.deepEqual(clineQuotaOf(null), { kind: "cline", reported: false, mode: "single", accounts: [] });

  // The bridge account CPA sees carries the pool; its tokens come from CPA Helper like any other.
  const result = aggregateUsage({
    authRows: [agg("idx-cline", { extra: "api_key" })],
    modelsByAuth: new Map([["idx-cline", [agg("cline-pass/glm-5.3", { extra: "cline", unpriced: 10 })]]]),
    authFiles: [{ name: "cline-pass-switcher.json", auth_index: "idx-cline", type: "cline", label: "Cline Pass" }],
    cline: payload,
  });
  const [bridge] = result.accounts;
  assert.equal(bridge.label, "Cline Pass");
  assert.equal(bridge.provider, "cline");
  assert.equal(bridge.quota.kind, "cline");
  assert.equal(bridge.costSource, "estimate");
  assert.ok(bridge.cost > 0);
  // Without the bridge in CPA's list the pool still shows, on a row of its own.
  const alone = aggregateUsage({ cline: payload });
  assert.equal(alone.accounts[0].label, "Cline Pass");
  assert.equal(alone.accounts[0].quota.accounts.length, 4);
});

function fixture({ routes = {}, connection = { baseUrl: "http://127.0.0.1:8317", managementKey: KEY }, quota = null } = {}) {
  const calls = [];
  let clock = NOW;
  const usage = createCpaUsage({
    getConnection: () => connection, now: () => clock, logger: { warn() {} }, quota,
    fetchImpl: async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      const parsed = new URL(url);
      const route = routes[`${parsed.pathname}?${parsed.searchParams.get("group") ?? ""}${parsed.searchParams.get("auth") ? `&${parsed.searchParams.get("auth")}` : ""}`]
        ?? routes[parsed.pathname];
      if (!route) return { ok: false, status: 404, json: async () => ({}) };
      const { status = 200, body } = typeof route === "function" ? route(parsed) : route;
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
  });
  return { usage, calls, advance: (ms) => { clock += ms; } };
}

test("reads CPA Helper with the management key over a range, splits accounts by model and caches", async () => {
  const codexQuota = { read: async () => ({ available: true, accounts: [{ id: "idx-codex", plan: "pro", paused: true, session: null, week: null, checkedAt: null, error: null }] }) };
  const { usage, calls, advance } = fixture({
    quota: codexQuota,
    routes: {
      "/v0/management/cpa-helper/rankings?auth": { body: { group: "auth", items: [agg("idx-codex"), agg("idx-cline")] } },
      "/v0/management/cpa-helper/rankings?model": { body: { group: "model", items: [agg("gpt-5")] } },
      "/v0/management/cpa-helper/rankings?model&idx-codex": { body: { items: [agg("gpt-5", { cost_usd: 2, unpriced: 0 })] } },
      "/v0/management/cpa-helper/rankings?model&idx-cline": { status: 500, body: null },
      "/v0/management/auth-files": { body: { files: [
        { name: "codex.json", auth_index: "idx-codex", provider: "codex", email: "c@example.com", access_token: "should-not-pass" },
        { name: "cline-pass-switcher.json", auth_index: "idx-cline", type: "cline", label: "Cline Pass" },
      ] } },
      "/v0/management/cline-pass-switcher/api/accounts": { body: { mode: "roundrobin", accounts: [{ name: "a", key: "cline-key-should-not-pass", enabled: true }], stats: {} } },
    },
  });
  const result = await usage.read({ range: "7d" });
  assert.equal(result.available, true);
  assert.equal(result.range, "7d");
  assert.equal(result.from, NOW - RANGES["7d"]);
  assert.equal(result.refreshedAt, NOW);
  assert.ok(calls.every((call) => call.auth === `Bearer ${KEY}` && call.url.startsWith("http://127.0.0.1:8317/v0/management/")));
  assert.ok(calls.some((call) => call.url.includes("group=auth") && call.url.includes(`from=${NOW - RANGES["7d"]}`)));
  const codex = result.accounts.find((account) => account.id === "idx-codex");
  assert.equal(codex.cost, 2);
  assert.equal(codex.costSource, "cpa-helper");
  assert.equal(codex.quota.plan, "pro");
  assert.equal(codex.quota.paused, true);
  const cline = result.accounts.find((account) => account.id === "idx-cline");
  assert.equal(cline.quota.kind, "cline");
  assert.equal(cline.models.length, 0, "a failed split leaves the account without one");
  assert.equal(cline.cost, null, "and CPA Helper priced none of its requests");
  const text = JSON.stringify(result);
  assert.ok(!text.includes(KEY) && !text.includes("should-not-pass"), "no key or token reaches the renderer");

  const before = calls.length;
  await usage.read({ range: "7d" });
  assert.equal(calls.length, before, "a read is cached for a short while");
  advance(30_000);
  await Promise.all([usage.read({ range: "7d" }), usage.read({ range: "7d" })]);
  assert.equal(calls.length, before * 2, "after that it reads again, once for concurrent callers");
  const mark = calls.length;
  const all = await usage.read({ range: "all" });
  assert.equal(all.from, null);
  assert.ok(calls.length > mark && calls.slice(mark).every((call) => !call.url.includes("from=")), "all time reads without a start");
  assert.equal((await usage.read({ range: "bogus" })).range, "30d");
});

test("the per-account splits go to CPA three at a time, not all at once, and every account still gets its own", async () => {
  // Seen 2026-10-22: one refresh sent ~16 range aggregations to the CPA that serves the chats, and all
  // of them timed out in the same second.
  const keys = Array.from({ length: 10 }, (_, index) => `idx-${index}`);
  let inFlight = 0, most = 0;
  const usage = createCpaUsage({
    getConnection: () => ({ baseUrl: "http://127.0.0.1:8317", managementKey: KEY }), now: () => NOW, logger: { warn() {} },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const auth = parsed.searchParams.get("auth");
      const body = parsed.pathname.endsWith("/rankings") && parsed.searchParams.get("group") === "auth" ? { items: keys.map((key) => agg(key)) }
        : auth ? { items: [agg(`model-of-${auth}`, { cost_usd: 1, unpriced: 0 })] }
        : parsed.pathname.endsWith("/auth-files") ? { files: keys.map((key) => ({ name: `${key}.json`, auth_index: key, provider: "codex" })) }
        : { items: [] };
      if (auth) {
        inFlight += 1; most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      }
      return { ok: true, status: 200, json: async () => body };
    },
  });
  const result = await usage.read({ range: "7d" });
  assert.equal(most, 3, "at most three split reads at a time");
  for (const key of keys) {
    const account = result.accounts.find((row) => row.id === key);
    assert.deepEqual(account.models.map((model) => model.model ?? model.id ?? model.name), [`model-of-${key}`], `${key} keeps its own split`);
  }
});

test("without CPA, without CPA Helper or with a refused key it says why, and the key goes only to loopback", async () => {
  assert.deepEqual(await fixture({ connection: null }).usage.read(), { ok: true, available: false, reason: "CPA is not running" });
  assert.match((await fixture().usage.read()).reason, /CPA Helper is not installed/);
  const refused = fixture({ routes: { "/v0/management/cpa-helper/rankings": { status: 401, body: null } } });
  assert.match((await refused.usage.read()).reason, /refused the management key/);
  const remote = fixture({ connection: { baseUrl: "http://cpa.example.com:8317", managementKey: KEY } });
  assert.equal((await remote.usage.read()).available, false);
  assert.equal(remote.calls.length, 0, "a non-loopback CPA never receives the key");
  const throwing = createCpaUsage({ getConnection: () => { throw new Error("CPA is stopped"); }, fetchImpl: async () => assert.fail("no request") });
  assert.equal((await throwing.read()).available, false);
  const down = createCpaUsage({ getConnection: () => ({ baseUrl: "http://127.0.0.1:8317", managementKey: KEY }), fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.deepEqual(await down.read(), { ok: true, available: false, reason: "CPA did not answer" });
});

test("cpa_usage is a read-only Agent Orchestrator operation served by the AO runtime service, and ships in the backend", async () => {
  const handler = require(path.join(__dirname, "..", "..", "app-handler", "agent-orchestrator", "handler.cjs"));
  assert.equal(handler.isReadOnly("cpa_usage"), true);
  const seen = [];
  await handler.invoke("cpa_usage", { range: "24h" }, { services: {
    agentOrchestratorUpstream: async (operation, args) => { seen.push(["upstream", operation, args]); return { ok: true }; },
    agentOrchestrator: async (operation) => { seen.push(["workflow", operation]); return { ok: true }; },
  } });
  assert.deepEqual(seen, [["upstream", "cpa_usage", { range: "24h" }]]);
  const { BACKEND_MODULES } = require("../electron/backend-bundle.cjs");
  assert.ok(BACKEND_MODULES.includes("cpa-usage.cjs") && BACKEND_MODULES.includes("cpa-model-prices.cjs"));
});

test("a turn's model requests sum to its steps, model time, first-token time, speed, cache hits and tokens", () => {
  const stats = summarizeRecords([
    { latency_ms: 1800, ttft_ms: 600, input_tokens: 7700, cached_tokens: 0, output_tokens: 161 },
    { latency_ms: 2400, ttft_ms: 400, input_tokens: 8000, cached_tokens: 6000, output_tokens: 239 },
    { failed: true, latency_ms: 300, input_tokens: 9000 },
  ]);
  assert.equal(stats.steps, 3);
  assert.equal(stats.failed, 1);
  assert.equal(stats.latencyMs, 4200, "a failed request is a step, not model time");
  assert.equal(stats.ttftMs, 500);
  assert.equal(stats.tokensPerSecond, Math.round((400 / 3200) * 1000), "speed is output over the streaming part");
  assert.equal(stats.cacheHit, 6000 / 15700);
  assert.deepEqual([stats.inputTokens, stats.outputTokens], [15700, 400]);
  assert.deepEqual(summarizeRecords([]), { steps: 0, failed: 0, latencyMs: 0, ttftMs: null, tokensPerSecond: null, cacheHit: null, inputTokens: 0, outputTokens: 0, cachedTokens: 0, lastAt: null, refusal: null });
});

test("a turn's refusal is the run of failed requests since its model last answered, with their HTTP status", () => {
  // Seen live 2026-10-22: a MiMo turn sat on "may be stuck" while CPA refused its requests.
  const at = (seconds) => NOW - 600_000 + seconds * 1000;
  const stats = summarizeRecords([
    // Out of order on purpose: CPA Helper's page order is not the turn's.
    { ts: at(30), failed: true, status_code: 429 },
    { ts: at(10), latency_ms: 900, output_tokens: 20 },
    { ts: at(20), failed: true, status_code: 429 },
    { ts: at(40), failed: true, status_code: 503 },
    { ts: at(5), failed: true, status_code: 429 },
  ]);
  assert.deepEqual(stats.refusal, { streak: 3, status: 503, statuses: { 429: 2, 503: 1 }, since: at(20), lastAt: at(40) },
    "the failure before the success is not part of the run; the newest status leads");
  assert.equal(summarizeRecords([{ ts: at(1), failed: true, status_code: 429 }, { ts: at(2), latency_ms: 10 }]).refusal, null,
    "a model that answered after its failures is not refusing");
  assert.equal(summarizeRecords([{ failed: true, status_code: 429 }]).refusal, null, "records without a time say nothing about order");
  const { recordTime } = require("../electron/cpa-usage.cjs");
  assert.equal(recordTime({ ts: 1_792_600_000 }), 1_792_600_000_000, "seconds");
  assert.equal(recordTime({ ts: 1_792_600_000_123 }), 1_792_600_000_123, "milliseconds");
  assert.equal(recordTime({ ts: "2026-10-22T01:00:00Z" }), Date.parse("2026-10-22T01:00:00Z"), "ISO");
});

test("a turn's stats read CPA Helper's records for its model since it started, without the cpa/ prefix or an effort suffix", async () => {
  const urls = [];
  const usage = createCpaUsage({
    now: () => NOW,
    getConnection: () => ({ baseUrl: "http://127.0.0.1:8317", managementKey: KEY }),
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
      return { ok: true, status: 200, json: async () => ({ items: [{ latency_ms: 1000, ttft_ms: 200, input_tokens: 10, output_tokens: 80 }] }) };
    },
  });
  const stats = await usage.turnStats({ model: "cpa/cline-pass/deepseek-v4.1-flash(high)", from: NOW - 5000 });
  assert.equal(stats.available, true);
  assert.equal(stats.steps, 1);
  const url = new URL(urls[0]);
  assert.equal(url.pathname, "/v0/management/cpa-helper/records");
  assert.equal(url.searchParams.get("model"), "cline-pass/deepseek-v4.1-flash");
  assert.equal(url.searchParams.get("from"), String(NOW - 5000));
  await usage.turnStats({ model: "cpa/cline-pass/deepseek-v4.1-flash(high)", from: NOW - 5000 });
  assert.equal(urls.length, 1, "read again only after a few seconds");
  assert.deepEqual(await usage.turnStats({ model: "", from: NOW }), { ok: true, available: false });
});

test("turn stats read CPA Helper's records three at a time, and the same turn asked twice is read once", async () => {
  // Seen live 2026-10-31: opening a chat read every ended turn's foot at once; 17 record reads went to
  // CPA together during a disk stall, all timed out in the same 2 s, and those feet stayed blank.
  let inFlight = 0, most = 0, reads = 0;
  const usage = createCpaUsage({
    now: () => NOW, logger: { warn() {} },
    getConnection: () => ({ baseUrl: "http://127.0.0.1:8317", managementKey: KEY }),
    fetchImpl: async () => {
      reads += 1; inFlight += 1; most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, status: 200, json: async () => ({ items: [{ latency_ms: 1000, output_tokens: 80 }] }) };
    },
  });
  const turns = Array.from({ length: 10 }, (_, index) => ({ model: "cpa/glm", from: NOW - 100_000 + index * 1000, to: NOW - 99_500 + index * 1000 }));
  const results = await Promise.all([...turns, turns[0]].map((turn) => usage.turnStats(turn)));
  assert.equal(most, 3, "at most three record reads at a time");
  assert.equal(reads, 10, "the turn asked twice shares one read");
  assert.ok(results.every((stats) => stats.available && stats.steps === 1), "every turn still gets its numbers");
});

test("an ended turn's stats stop at its end, say when its last request was, and are kept once settled", async () => {
  const urls = [];
  const usage = createCpaUsage({
    now: () => NOW,
    getConnection: () => ({ baseUrl: "http://127.0.0.1:8317", managementKey: KEY }),
    // A helper that ignores `to`: the request after the turn's end is left out here instead.
    fetchImpl: async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ items: [
        { ts: NOW - 50_000, latency_ms: 4000, output_tokens: 10 },
        { ts: NOW - 70_000, latency_ms: 1000, output_tokens: 10 },
        { ts: NOW - 90_000, latency_ms: 2000, output_tokens: 10 },
      ] }) };
    },
  });
  const ended = { model: "cpa/glm", from: NOW - 100_000, to: NOW - 60_000 };
  const stats = await usage.turnStats(ended);
  assert.equal(new URL(urls[0]).searchParams.get("to"), String(NOW - 60_000));
  assert.equal(stats.steps, 2, "the request after the turn ended is another turn's");
  assert.equal(stats.latencyMs, 3000);
  assert.equal(stats.lastAt, NOW - 70_000);
  await usage.turnStats(ended);
  assert.equal(urls.length, 1, "an ended turn's numbers are not read again");
  const open = await usage.turnStats({ model: "cpa/glm", from: NOW - 100_000 });
  assert.equal(open.steps, 3, "without an end every request since the start counts");
  assert.equal(new URL(urls[1]).searchParams.get("to"), null);
});

test("a long turn's stats read every page of records instead of stopping at the first 500", async () => {
  const record = (index) => ({ id: index, latency_ms: 1000, ttft_ms: 200, input_tokens: 10, output_tokens: 80 });
  const statsFor = async (paged) => {
    const pages = [];
    const usage = createCpaUsage({
      now: () => NOW,
      getConnection: () => ({ baseUrl: "http://127.0.0.1:8317", managementKey: KEY }),
      fetchImpl: async (url) => {
        const page = Number(new URL(String(url)).searchParams.get("page"));
        pages.push(page);
        // 1,203 records: two full pages and a short one. A helper without paging returns page one each time.
        const first = paged ? (page - 1) * 500 : 0;
        const items = Array.from({ length: Math.max(0, Math.min(500, 1203 - first)) }, (_, offset) => record(first + offset));
        return { ok: true, status: 200, json: async () => ({ items }) };
      },
    });
    return { stats: await usage.turnStats({ model: "cpa/cline-pass/deepseek-v4.1-flash", from: NOW - 5000 }), pages };
  };
  const paged = await statsFor(true);
  assert.equal(paged.stats.steps, 1203, "not capped at 500");
  assert.deepEqual(paged.pages, [1, 2, 3], "stops at the short page");
  const unpaged = await statsFor(false);
  assert.equal(unpaged.stats.steps, 500, "a helper that ignores page is counted once, not twice");
  assert.deepEqual(unpaged.pages, [1, 2]);
});
