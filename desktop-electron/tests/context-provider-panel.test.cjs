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
  "./AgentOrchestratorRoleEditor": { cpaProviderOf: (model) => model?.split("/")[1] ?? null, providerName: (provider) => provider === "codex" ? "Codex" : provider },
  "./ao-chat": { contextFraction: (value) => value?.contextWindow ? value.contextUsed / value.contextWindow : null,
    tokensShort: (value) => value === null ? "—" : value >= 1000000 ? "1M" : String(value) } });
const snapshot = { controller: "busy", planLabel: null, mcpServers: [], compactedAt: null, rateLimits: null,
  usage: { contextUsed: 180000, contextWindow: 1000000, inputTokens: 295000, outputTokens: 23500, cachedTokens: 5350000, totalTokens: 318500, cost: 10.61, currency: "USD" } };
const props = { sessionId: "session", model: "cpa/codex/gpt-fixture", snapshot, detail: null, quota: null, cpaUsage: null, daySpend: null, monthSpend: null, canCompact: true, onCompact() {} };
const render = (changes) => renderToStaticMarkup(React.createElement(panel.ContextPanelContent, { ...props, ...changes }));

test("context panel leads with selectable provider quotas and folds verbose details", () => {
  const account = { id: "first", label: "First account", plan: "max", disabled: false, paused: false, error: null,
    session: { usedPercent: 28, resetsAt: Date.now() + 3600000 }, week: { usedPercent: 61, resetsAt: null }, credits: { balance: "0", hasCredits: false } };
  const html = render({ snapshot: { ...snapshot, planLabel: "Another account's plan" }, quota: { available: true, accounts: [account, { ...account, id: "second", label: "Second account" }] } });
  assert.match(html, /Codex/);
  assert.match(html, /cx-ctx-plan">max/);
  assert.match(html, /aria-label="Quota account"/);
  assert.match(html, /aria-label="5 hours quota used"[^>]*aria-valuenow="28"/);
  assert.match(html, /aria-label="Weekly quota used"[^>]*aria-valuenow="61"/);
  assert.match(html, /18% used/);
  assert.match(html, /<details class="cx-ctx-details"><summary>Context details/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.ok(html.indexOf("5 hours") < html.indexOf("Context window"));
});

test("context panel shows reported limits before a first reply and honors the launched context window", () => {
  const limits = { primaryUsedPercent: 10, secondaryUsedPercent: 20, planLabel: "Max", primaryResetsInSeconds: null, secondaryResetsInSeconds: null };
  const waiting = render({ snapshot: { ...snapshot, usage: null, rateLimits: limits } });
  assert.match(waiting, /5 hours quota used/);
  assert.match(waiting, /Context not reported yet/);
  const launched = render({ launchedWindow: 500000 });
  assert.match(launched, /36% used/);
});

test("context panel distinguishes actual credits, key budgets and unsupported balances", () => {
  const api = { available: false, apiCredits: [{ id: "api-0", provider: "deepseek", service: "deepseek", kind: "credits", label: "DeepSeek", balances: [{ currency: "USD", amount: "12.34" }] }] };
  const html = render({ model: "cpa/deepseek/model", cpaUsage: api });
  assert.match(html, /12.34 USD/);
  const budget = render({ model: "cpa/openrouter/model", cpaUsage: { ...api, apiCredits: [{ ...api.apiCredits[0], provider: "openrouter", service: "openrouter", kind: "key-budget" }] } });
  assert.match(budget, /Key budget/);
  assert.doesNotMatch(budget, />Credits</);
  const unavailable = render({ model: "cpa/anthropic/model", cpaUsage: api });
  assert.match(unavailable, /Not exposed/);
  assert.doesNotMatch(unavailable, /12.34 USD/);
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
