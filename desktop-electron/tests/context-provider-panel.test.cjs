const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
function load(file, imports = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/features", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: (name) => name.startsWith("react") ? require(name) : imports[name] ?? {} });
  return exports;
}
const usage = load("cpa-usage.ts");
const panel = load("ChatContextMeter.tsx", { "./cpa-usage": usage,
  "./AgentOrchestratorRoleEditor": { cpaProviderOf: (model) => model?.split("/")[1] ?? null, providerName: (provider) => ({ codex: "Codex", claude: "Claude" })[provider] ?? provider },
  "./ao-chat": { contextFraction: (value) => value?.contextWindow ? value.contextUsed / value.contextWindow : null,
    tokensShort: (value) => value === null ? "—" : value >= 1000000 ? "1M" : String(value) } });
const snapshot = { controller: "busy", planLabel: null, mcpServers: [], compactedAt: null, rateLimits: null,
  usage: { contextUsed: 180000, contextWindow: 1000000, inputTokens: 295000, outputTokens: 23500, cachedTokens: 5350000, totalTokens: 318500, cost: 10.61, currency: "USD" } };
const NOW = Date.UTC(2026, 10, 23, 12, 0);
const props = { sessionId: "session", model: "cpa/codex/gpt-fixture", snapshot, detail: null, quota: null, cpaUsage: null, daySpend: null, monthSpend: null,
  canCompact: true, onCompact() {}, now: NOW };
const render = (changes) => renderToStaticMarkup(React.createElement(panel.ContextPanelContent, { ...props, ...changes }));
const codexAccount = (changes = {}) => ({ id: "first", provider: "codex", label: "first@example.com", plan: "plus", state: "ready", disabled: false, paused: false,
  resumesAt: null, error: null, checkedAt: NOW - 60000, session: { usedPercent: 28, resetsAt: NOW + 2 * 3600000 + 15 * 60000, windowSeconds: 18000 },
  week: { usedPercent: 61, resetsAt: null, windowSeconds: 604800 }, credits: { balance: "51249.61", hasCredits: true, unlimited: false, overageReached: false }, ...changes });

test("CPA's Codex models (listed as OpenAI's) show the serving account's 5-hour and weekly limits, credits and the routing pool", () => {
  const limited = codexAccount({ id: "second", label: "second@example.com", state: "limited", paused: true, resumesAt: NOW + 45 * 60000 });
  const html = render({ model: "cpa/openai/gpt-fixture", snapshot: { ...snapshot, planLabel: "Another account's plan" },
    quota: { available: true, accounts: [codexAccount(), limited, codexAccount({ id: "off", label: "off@example.com", state: "disabled", disabled: true }),
      { ...codexAccount({ id: "c1", provider: "claude", label: "claude@example.com" }) }] } });
  assert.match(html, /<strong>Codex<\/strong>/, "an OpenAI-owned model on a Codex sign-in is Codex's");
  assert.match(html, /cx-ctx-plan">plus/);
  assert.match(html, /1\/2 ready/, "only this provider's enabled accounts count");
  assert.match(html, /class="is-disabled" aria-pressed="false"[^>]*><i><\/i>off</, "a switched-off account keeps its chip");
  assert.match(html, /aria-label="5 hours quota used"[^>]*aria-valuenow="28"/);
  assert.match(html, /<small>2h 15m<\/small>/, "a short reset beside its meter");
  assert.match(html, /aria-label="Weekly quota used"[^>]*aria-valuenow="61"/);
  assert.match(html, /51,249.61/);
  assert.match(html, /role="group" aria-label="Quota account"/);
  assert.match(html, /class="is-ready" aria-pressed="true"[^>]*><i><\/i>first</);
  assert.match(html, /class="is-limited" aria-pressed="false" title="second@example.com · plus · Back [^"]+"/);
  assert.doesNotMatch(html, /claude@example/);
  assert.match(html, /18% used/);
  assert.match(html, /<details class="cx-ctx-details"><summary>Details/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.ok(html.indexOf("5 hours") < html.indexOf("Context window"));
});

test("Claude sign-in accounts show their limits too, and a pool with nobody ready says when one is back", () => {
  const out = (id, minutes) => codexAccount({ id, provider: "claude", label: `${id}@example.com`, plan: "max", state: "limited", paused: true,
    resumesAt: NOW + minutes * 60000, session: { usedPercent: 100, resetsAt: NOW + minutes * 60000, windowSeconds: 18000 }, credits: null });
  const html = render({ model: "cpa/anthropic/claude-fixture", quota: { available: true, accounts: [out("a", 90), out("b", 30)] } });
  assert.match(html, /<strong>Claude<\/strong>/);
  assert.match(html, /cx-ctx-pool is-out[^>]*>0\/2 ready/);
  assert.match(html, /All accounts at limit · first back in 30m/);
  assert.doesNotMatch(html, /Credits/);
  const unseen = render({ model: "cpa/claude/claude-fixture", quota: { available: true, accounts: [out("a", 90), { ...out("c", 0), state: "ready", session: null, week: null, resumesAt: null }] } });
  assert.match(unseen, /Limits show after this account&#x27;s next reply/, "CPA knows an account's limits once it served a request");
  assert.match(render({ quota: { available: false, reason: "CPA is not running" } }), /CPA is not running/);
  assert.match(render({}), /Checking limits…/);
});

test("the pool counts every account CPA has, not only the ones the reader lists", () => {
  const listed = Array.from({ length: 12 }, (_, at) => codexAccount({ id: `a${at}`, label: `a${at}@example.com` }));
  const html = render({ quota: { available: true, accounts: listed, pools: { codex: { total: 14, enabled: 14, ready: 12, resumesAt: null } } } });
  assert.match(html, /cx-ctx-pool"[^>]*>12\/14 ready/, "two failing accounts past the list still count");
  assert.match(html, /class="is-more" title="[^"]*2 more not listed">\+8</, "6 chips shown, 6 listed and 2 unlisted behind +8");
  const out = codexAccount({ id: "a", state: "limited", paused: true, resumesAt: NOW + 90 * 60000 });
  const back = render({ quota: { available: true, accounts: [out], pools: { codex: { total: 3, enabled: 2, ready: 0, resumesAt: NOW + 20 * 60000 } } } });
  assert.match(back, /cx-ctx-pool is-out[^>]*>0\/2 ready/);
  assert.match(back, /All accounts at limit · first back in 20m/, "the soonest account back may be one not listed");
});

test("context panel shows reported limits before a first reply and honors the launched context window", () => {
  const limits = { primaryUsedPercent: 10, secondaryUsedPercent: 20, planLabel: "Max", primaryResetsInSeconds: null, secondaryResetsInSeconds: null };
  const waiting = render({ snapshot: { ...snapshot, usage: null, rateLimits: limits } });
  assert.match(waiting, /5 hours quota used/);
  assert.match(waiting, /Context not reported yet/);
  const launched = render({ launchedWindow: 500000 });
  assert.match(launched, /36% used/);
  // Codex reports 95% of the window it was told and compacts against that, so its own number shows.
  const codex = render({ launchedWindow: 400000, snapshot: { ...snapshot, usage: { ...snapshot.usage, contextUsed: 190000, contextWindow: 380000 } } });
  assert.match(codex, /50% used/);
  // Claude Code over ACP says 200K for a model it does not know: the launched window stands.
  const unknown = render({ launchedWindow: 1000000, snapshot: { ...snapshot, usage: { ...snapshot.usage, contextWindow: 200000 } } });
  assert.match(unknown, /18% used/);
  const native = render({ model: "gpt-fixture" });
  assert.doesNotMatch(native, /cx-ctx-provider/, "a model not on CPA has no provider card to fill");
});

test("context panel distinguishes actual credits, key budgets and unsupported balances", () => {
  const api = { available: false, apiCredits: [{ id: "api-0", provider: "deepseek", service: "deepseek", kind: "credits", label: "DeepSeek", balances: [{ currency: "USD", amount: "12.34" }] }] };
  const html = render({ model: "cpa/deepseek/model", cpaUsage: api });
  assert.match(html, /12.34 USD/);
  const budget = render({ model: "cpa/openrouter/model", cpaUsage: { ...api, apiCredits: [{ ...api.apiCredits[0], provider: "openrouter", service: "openrouter", kind: "key-budget" }] } });
  assert.match(budget, /Key budget/);
  assert.doesNotMatch(budget, />Credits</);
  const unavailable = render({ model: "cpa/anthropic/model", cpaUsage: api, quota: { available: true, accounts: [] } });
  assert.match(unavailable, /Not exposed/, "a Claude API key without sign-in accounts has no plan limits");
  assert.doesNotMatch(unavailable, /12.34 USD/);
});

test("Cline Pass keys show as the routing pool", () => {
  const keys = [{ name: "key-1", enabled: true, active: true, requests: 3, lastUsedAt: null, lastError: null, state: "ok" },
    { name: "key-2", enabled: true, active: false, requests: 1, lastUsedAt: null, lastError: "429", state: "limited" },
    { name: "key-3", enabled: false, active: false, requests: 0, lastUsedAt: null, lastError: null, state: "disabled" }];
  const html = render({ model: "cpa/cline-pass/model", cpaUsage: { available: true, accounts: [{ id: "cline", quota: { kind: "cline", reported: false, mode: "roundrobin", accounts: keys } }] } });
  assert.match(html, /1\/2 keys ready/);
  assert.match(html, /aria-label="Cline keys"/);
  assert.match(html, /class="is-limited" title="key-2 · limited · 429"/);
});

test("resets read as a countdown today, a weekday this week and a date after", () => {
  assert.equal(panel.resetShort(NOW + 45 * 60000, NOW), "45m");
  assert.equal(panel.resetShort(NOW + 3 * 3600000, NOW), "3h");
  assert.equal(panel.resetShort(NOW + 3 * 3600000 + 60000, NOW), "3h 1m");
  assert.match(panel.resetShort(NOW + 3 * 86400000, NOW), /^[A-Z][a-z]{2} \d{1,2}\s?[AP]M$/);
  assert.match(panel.resetShort(NOW + 9 * 86400000, NOW), /^[A-Z][a-z]{2} \d{1,2}$/);
  assert.equal(panel.resetShort(NOW - 1, NOW), "");
  assert.equal(panel.planProviderOf("OpenAI"), "codex");
  assert.equal(panel.planProviderOf("deepseek"), null);
});

const { apiCreditTargets, readApiCredits, createCpaUsage } = require("../electron/cpa-usage.cjs");
const config = { "api-keys": { "openai-compatibility": [
  { name: "deepseek", "base-url": "https://api.deepseek.com/v1", keys: [{ "api-key": "fixture-deepseek" }] },
  { name: "openrouter", "base-url": "https://openrouter.ai/api/v1", keys: [{ "api-key": "fixture-router" }] },
  { name: "foreign", "base-url": "https://example.test/v1", keys: [{ "api-key": "must-not-send" }] },
] } };
test("API credit requests use allowlisted hosts, reject masked keys and never return secrets", async () => {
  assert.equal(apiCreditTargets(config).length, 2);
  assert.equal(apiCreditTargets({ "api-keys": { deepseek: [{ keys: [{ "api-key": "****" }] }] } }).length, 0);
  const calls = [];
  const rows = await readApiCredits(config, async (url, init) => {
    calls.push([url, init]);
    return { ok: true, json: async () => url.includes("deepseek") ? { balance_infos: [{ currency: "USD", total_balance: "12.34" }] } : { data: { limit_remaining: 0 } } };
  });
  assert.deepEqual(rows.map((row) => row.balances), [[{ currency: "USD", amount: "12.34" }], [{ currency: "USD", amount: "0" }]]);
  assert.equal(rows[1].kind, "key-budget");
  assert.ok(calls.every(([url, init]) => url.startsWith("https://") && init.redirect === "error"));
  assert.doesNotMatch(JSON.stringify(rows), /fixture-|must-not-send|api-key/);
  const bad = await readApiCredits(config, async () => ({ ok: false, status: 403 }));
  assert.ok(bad.every((row) => row.balances.length === 0 && /403/.test(row.reason)));
  const unknown = await readApiCredits(config, async () => ({ ok: true, json: async () => ({ data: { limit_remaining: null } }) }));
  assert.equal(unknown[1].balances.length, 0);
});

test("API credits work without CPA Helper usage history and are cached with the usage read", async () => {
  let upstream = 0;
  const reader = createCpaUsage({ getConnection: () => ({ baseUrl: "http://127.0.0.1:8317", managementKey: "fixture-management" }), logger: { warn() {} },
    fetchImpl: async (url) => {
      if (url.endsWith("/config")) return { ok: true, status: 200, json: async () => config };
      if (url.startsWith("https://")) { upstream++; return { ok: true, json: async () => ({ balance_infos: [{ currency: "USD", total_balance: "9.00" }] }) }; }
      return { ok: false, status: 404 };
    } });
  const result = await reader.read({ range: "7d" });
  assert.equal(result.available, false);
  assert.equal(result.apiCredits[0].balances[0].amount, "9.00");
  await reader.read({ range: "7d" });
  assert.equal(upstream, 2);
});
