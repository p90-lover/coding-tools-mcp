"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "../src/features/cpa-provider-usage-bridge.ts"), "utf8");
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
  { exports: exportsObject, Set });
const { attachCpaProviderUsageBridge } = exportsObject;

function fixture(read) {
  let listener;
  const replies = [], embedded = {}, child = { parent: embedded, postMessage: (m, origin) => replies.push({ m, origin }) };
  embedded.parent = embedded;
  const dispose = attachCpaProviderUsageBridge({ host: {
    addEventListener: (_, fn) => { listener = fn; }, removeEventListener: () => { listener = null; },
  }, frame: () => embedded, origin: "http://localhost:9000", read });
  const send = (extra = {}) => listener({ origin: "http://localhost:9000", source: child,
    data: { type: "cpm:usage:read", id: "request-1", range: "7d" }, ...extra });
  return { send, replies, dispose, child };
}

test("only the embedded CPA descendants at the expected origin can read history", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return null; });
  await f.send({ origin: "http://evil.example" });
  await f.send({ source: { parent: null } });
  await f.send({ data: { type: "cpm:usage:read", id: "x", range: "invalid" } });
  assert.equal(calls, 0);
  await f.send();
  assert.equal(calls, 1);
  assert.equal(f.replies[0].origin, "http://localhost:9000");
  f.dispose();
});

test("bridge projects counters, estimates and model names but not private or future fields", async () => {
  const counts = { requests: 1, failed: 0, inputTokens: 10, outputTokens: 2, totalTokens: 12,
    cachedTokens: 0, reasoningTokens: 0, cost: 0, costSource: "estimate", costPartial: false };
  const f = fixture(async () => ({ available: true, range: "7d", apiKey: "secret-key", totals: counts,
    accounts: [{ ...counts, id: "private-auth-id", label: "Account A", provider: "Example", quota: { error: "secret URL" },
      models: [{ ...counts, model: "deepseek-v4.1-flash", provider: "Example", apiKey: "private-model-key" }] }] }));
  await f.send();
  const raw = JSON.stringify(f.replies[0].m);
  assert.match(raw, /Account A/);
  assert.match(raw, /deepseek-v4.1-flash/);
  assert.doesNotMatch(raw, /private|secret|apiKey/);
  assert.equal(f.replies[0].m.usage.accounts[0].quota, null);
  assert.equal(f.replies[0].m.usage.accounts[0].cost, 0);
  f.dispose();
});

test("concurrent duplicates share the pending read and disposal suppresses late replies", async () => {
  let release, calls = 0;
  const f = fixture(() => { calls++; return new Promise((resolve) => { release = resolve; }); });
  const pending = f.send();
  await f.send();
  assert.equal(calls, 1);
  f.dispose(); release(null); await pending;
  assert.equal(f.replies.length, 0);
});

test("backend errors never forward credential-bearing diagnostics", async () => {
  const f = fixture(async () => { throw new Error("https://secret:password@upstream.example"); });
  await f.send();
  assert.doesNotMatch(JSON.stringify(f.replies), /secret|password|upstream/);
  f.dispose();
});

test("supported quotas pass only numbers and safe state, never errors or key names", async () => {
  const f = fixture(async () => ({ available: true, accounts: [
    { models: [], quota: { kind: "codex", paused: true, checkedAt: 1000, error: "secret URL",
      session: { usedPercent: 25, resetsAt: 2000, windowSeconds: 18000, token: "secret" }, week: null } },
    { models: [], quota: { kind: "cline", accounts: [{ name: "private-key-name", lastError: "secret",
      enabled: true, active: false, state: "limited", requests: 4 }] } },
  ] }));
  await f.send();
  const accounts = f.replies[0].m.usage.accounts;
  assert.equal(accounts[0].quota.session.usedPercent, 25);
  assert.equal(accounts[0].quota.error, "Quota refresh unavailable");
  assert.equal(accounts[1].quota.accounts[0].state, "limited");
  assert.doesNotMatch(JSON.stringify(accounts), /secret|private|lastError|token|name/);
  f.dispose();
});

test("the host serves usage to the CPA frame and keeps its own strip until the plugin shows it", () => {
  // CPA Provider Manager does not send cpm:usage:read yet (no branch of it does, 2026-10-31), so the
  // app's strip above CPA stays; removing it first left CPA with no per-account usage at all.
  const ui = fs.readFileSync(path.join(__dirname, "../src/features/OriginalUiSurface.tsx"), "utf8");
  assert.match(ui, /toolId === "cpa" \? <CpaUsagePanel/);
  assert.match(ui, /attachCpaProviderUsageBridge/);
  assert.match(ui, /ref=\{cpaFrame\}/);
});
