"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const { setImmediate: nextTurn } = require("node:timers/promises");

function jsonSequenceFixture({ provider, route, created, existing = [], models = [] }) {
  const requests = [];
  let authReads = 0;
  let polls = 0;
  const requestJson = async (pathname, options = {}) => {
    const url = new URL(pathname, "http://127.0.0.1:8317/");
    requests.push({ pathname: url.pathname, search: url.search, method: options.method ?? "GET" });
    if (url.pathname === "/v0/management/auth-files") {
      authReads += 1;
      return { files: authReads === 1 ? existing : [...existing, created] };
    }
    if (url.pathname === `/v0/management/${route}`) {
      return { status: "ok", state: "oauth-state", url: "https://login.example.test/oauth" };
    }
    if (url.pathname === "/v0/management/get-auth-status") {
      polls += 1;
      return { status: polls === 1 ? "wait" : "ok" };
    }
    if (url.pathname === "/v0/management/auth-files/models") {
      assert.equal(url.searchParams.get("name"), created.name);
      return { models: models.map((id) => ({ id })) };
    }
    if (url.pathname === "/v0/management/oauth-session" && options.method === "DELETE") {
      return { status: "ok" };
    }
    throw new Error(`Unexpected request ${options.method ?? "GET"} ${url.pathname}`);
  };
  return { requestJson, requests, provider };
}

test("generic CPA OAuth binds the exact newly created Codex auth file", async () => {
  const { startCpaAccountLogin } = require("../electron/cpa-oauth-adapter.cjs");
  const existing = {
    name: "codex-existing.json",
    provider: "codex",
    email: "existing@example.test",
    status: "ready",
  };
  const created = {
    name: "codex-created.json",
    auth_index: "codex-created-index",
    provider: "codex",
    email: "created@example.test",
    status: "ready",
  };
  const fixture = jsonSequenceFixture({
    provider: "codex",
    route: "codex-auth-url",
    existing: [existing],
    created,
    models: ["gpt-5.6-codex", "gpt-5.5-codex"],
  });
  const opened = [];
  let clock = 0;
  const result = await startCpaAccountLogin({
    adapterId: "cpa-codex",
    requestJson: fixture.requestJson,
    openExternal: async (url) => opened.push(url),
    sleep: async (milliseconds) => { clock += Math.max(1, milliseconds); },
    now: () => clock,
    timeoutMs: 10_000,
    pollIntervalMs: 10,
    reservedAuthFileIds: ["codex-existing.json"],
  });

  assert.deepEqual(opened, ["https://login.example.test/oauth"]);
  assert.equal(result.opened, true);
  assert.equal(result.mode, "external");
  assert.equal(result.state, "oauth-state");
  assert.equal(result.authFile.id, "codex-created-index");
  assert.equal(result.authFile.name, "codex-created.json");
  assert.equal(result.authFile.identity, "created@example.test");
  assert.deepEqual(result.models, ["gpt-5.5-codex", "gpt-5.6-codex"]);
  assert.ok(fixture.requests.some((request) => request.pathname.endsWith("/codex-auth-url")));
});

test("Claude uses the anthropic CPA route and provider aliases", async () => {
  const { startCpaAccountLogin } = require("../electron/cpa-oauth-adapter.cjs");
  const created = {
    name: "claude-user.json",
    provider: "claude",
    account: "claude@example.test",
    status: "ready",
  };
  const fixture = jsonSequenceFixture({
    provider: "claude",
    route: "anthropic-auth-url",
    created,
    models: ["claude-opus-4-1"],
  });
  let clock = 0;
  const result = await startCpaAccountLogin({
    adapterId: "cpa-claude",
    requestJson: fixture.requestJson,
    openExternal: async () => undefined,
    sleep: async (milliseconds) => { clock += Math.max(1, milliseconds); },
    now: () => clock,
    timeoutMs: 10_000,
    pollIntervalMs: 10,
  });
  assert.equal(result.authFile.provider, "claude");
  assert.equal(result.authFile.identity, "claude@example.test");
  assert.ok(fixture.requests.some((request) => request.pathname.endsWith("/anthropic-auth-url")));
});

test("Gemini imports an existing CPA auth file and never fabricates gemini-auth-url", async () => {
  const { startCpaAccountLogin } = require("../electron/cpa-oauth-adapter.cjs");
  const requests = [];
  const requestJson = async (pathname) => {
    const url = new URL(pathname, "http://127.0.0.1:8317/");
    requests.push(url.pathname);
    if (url.pathname === "/v0/management/auth-files") {
      return {
        files: [{
          name: "gemini-user.json",
          provider: "gemini",
          email: "gemini@example.test",
          status: "ready",
        }],
      };
    }
    if (url.pathname === "/v0/management/auth-files/models") {
      return { models: [{ id: "gemini-2.5-pro" }] };
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  };

  const result = await startCpaAccountLogin({
    adapterId: "cpa-gemini",
    requestJson,
    openExternal: async () => assert.fail("Gemini auth-file import must not open a fabricated OAuth URL"),
    identity: "gemini@example.test",
  });

  assert.equal(result.opened, false);
  assert.equal(result.mode, "import");
  assert.equal(result.authFile.name, "gemini-user.json");
  assert.deepEqual(result.models, ["gemini-2.5-pro"]);
  assert.equal(requests.some((pathname) => pathname.includes("gemini-auth-url")), false);
});

test("timed-out CPA OAuth cancels its management session", async () => {
  const { startCpaAccountLogin } = require("../electron/cpa-oauth-adapter.cjs");
  const requests = [];
  let clock = 0;
  const requestJson = async (pathname, options = {}) => {
    const url = new URL(pathname, "http://127.0.0.1:8317/");
    requests.push({ pathname: url.pathname, method: options.method ?? "GET" });
    if (url.pathname === "/v0/management/auth-files") return { files: [] };
    if (url.pathname === "/v0/management/codex-auth-url") {
      return { status: "ok", state: "timeout-state", url: "https://login.example.test/oauth" };
    }
    if (url.pathname === "/v0/management/get-auth-status") return { status: "wait" };
    if (url.pathname === "/v0/management/oauth-session" && options.method === "DELETE") return { status: "ok" };
    throw new Error(`Unexpected request ${options.method ?? "GET"} ${url.pathname}`);
  };

  await assert.rejects(() => startCpaAccountLogin({
    adapterId: "cpa-codex",
    requestJson,
    openExternal: async () => undefined,
    sleep: async () => { clock += 5; },
    now: () => clock,
    timeoutMs: 10,
    pollIntervalMs: 5,
  }), /timed out/i);

  assert.ok(requests.some((request) => (
    request.pathname === "/v0/management/oauth-session" && request.method === "DELETE"
  )));
});

test("cancelled CPA OAuth stops polling, deletes its session and closes its browser", async () => {
  const { startCpaAccountLogin } = require("../electron/cpa-oauth-adapter.cjs");
  const controller = new AbortController();
  const requests = [];
  let closed = 0;
  const pending = startCpaAccountLogin({
    adapterId: "cpa-antigravity", signal: controller.signal, timeoutMs: 40, pollIntervalMs: 1,
    requestJson: async (pathname, options = {}) => {
      requests.push([pathname, options.method]);
      if (pathname.endsWith("/auth-files")) return { files: [] };
      if (pathname.includes("antigravity-auth-url")) return { status: "ok", state: "cancel-state", url: "https://accounts.google.com/o/oauth2/auth" };
      if (options.method === "DELETE") return { status: "ok" };
      return { status: "wait" };
    },
    openExternal: async (_url, options) => {
      assert.equal(options?.signal, controller.signal);
      return { close: () => { closed += 1; } };
    },
  });
  await nextTurn();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(closed, 1);
  assert.equal(requests.filter(([pathname, method]) => pathname.includes("cancel-state") && method === "DELETE").length, 1);
});

test("cancel during OAuth initiation still deletes the session returned by CPA without opening a browser", async () => {
  const { startCpaAccountLogin } = require("../electron/cpa-oauth-adapter.cjs");
  const controller = new AbortController();
  const deleted = [];
  let finish;
  const pending = startCpaAccountLogin({
    adapterId: "cpa-antigravity", signal: controller.signal,
    requestJson: async (pathname, options = {}) => {
      if (pathname.endsWith("/auth-files")) return { files: [] };
      if (pathname.includes("antigravity-auth-url")) return new Promise((resolve, reject) => {
        finish = () => resolve({ status: "ok", state: "started-after-cancel", url: "https://accounts.google.com/o/oauth2/auth" });
        options.signal?.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
      if (options.method === "DELETE") { deleted.push(pathname); return {}; }
      assert.fail("no polling after cancellation");
    },
    openExternal: async () => assert.fail("cancelled initiation cannot open a browser"),
  });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await nextTurn();
  controller.abort();
  finish();
  await rejected;
  assert.deepEqual(deleted, ["/v0/management/oauth-session?state=started-after-cancel"]);
});

test("a browser-open failure also disposes the CPA OAuth session", async () => {
  const { startCpaAccountLogin } = require("../electron/cpa-oauth-adapter.cjs");
  const fixture = jsonSequenceFixture({ provider: "codex", route: "codex-auth-url", created: { name: "new.json", provider: "codex" } });
  await assert.rejects(startCpaAccountLogin({
    adapterId: "cpa-codex", requestJson: fixture.requestJson,
    openExternal: async () => { throw new Error("proxy unavailable"); },
  }), /proxy unavailable/);
  assert.ok(fixture.requests.some(entry => entry.pathname.endsWith("/oauth-session") && entry.method === "DELETE"));
});

// CommandCode Go and CommandCode accounts are Provider Manager account kinds: Provider Manager's
// login is told which kind to sign in to, and CPA lists the new account as a provider-manager file
// that Provider Manager's kinds route names.
const KINDS_PATH = "/v0/management/cpa-provider-manager/api/kinds";

function providerManagerFixture({ kind, existing = [], models = [] }) {
  const requests = [];
  const created = { name: `${kind}-user.json`, provider: "provider-manager", type: "provider-manager", email: "user@example.test", status: "ready" };
  const unrelated = { name: "grok-user.json", provider: "provider-manager", type: "provider-manager", email: "grok@example.test", status: "ready" };
  let authReads = 0;
  const requestJson = async (pathname, options = {}) => {
    const url = new URL(pathname, "http://127.0.0.1:8317/");
    requests.push({ pathname: url.pathname, search: url.search, method: options.method ?? "GET" });
    if (url.pathname === "/v0/management/auth-files") {
      authReads += 1;
      return { files: authReads === 1 ? [...existing, unrelated] : [...existing, unrelated, created] };
    }
    if (url.pathname === KINDS_PATH) {
      return { files: { ...Object.fromEntries(existing.map((file) => [file.name, kind])), [created.name]: kind, [unrelated.name]: "grok" } };
    }
    if (url.pathname === "/v0/management/provider-manager-auth-url") {
      return { status: "ok", state: "oauth-state", url: "https://login.example.test/oauth" };
    }
    if (url.pathname === "/v0/management/get-auth-status") return { status: "ok" };
    if (url.pathname === "/v0/management/auth-files/models") {
      assert.equal(url.searchParams.get("name"), created.name);
      return { models: models.map((id) => ({ id })) };
    }
    throw new Error(`Unexpected request ${options.method ?? "GET"} ${url.pathname}`);
  };
  return { requestJson, requests, created };
}

for (const [adapterId, kind] of [
  ["cpa-commandcode-go", "commandcode-go"],
  ["cpa-commandcode-studio", "commandcode"],
]) {
  test(`${adapterId} logs in through Provider Manager's ${kind} kind and binds that auth file`, async () => {
    const { startCpaAccountLogin } = require("../electron/cpa-oauth-adapter.cjs");
    const fixture = providerManagerFixture({ kind, models: [`${kind}/test-model`] });
    let clock = 0;
    const opened = [];
    const result = await startCpaAccountLogin({
      adapterId,
      requestJson: fixture.requestJson,
      openExternal: async (url) => { opened.push(url); },
      sleep: async (milliseconds) => { clock += milliseconds; },
      now: () => clock,
      timeoutMs: 10_000,
      pollIntervalMs: 10,
    });
    assert.deepEqual(opened, ["https://login.example.test/oauth"]);
    assert.equal(result.authFile.provider, kind, "the account is listed under its kind's provider id");
    assert.equal(result.authFile.name, fixture.created.name, "the new file of this kind, not another kind's account");
    assert.deepEqual(result.models, [`${kind}/test-model`]);
    const login = fixture.requests.filter((request) => request.pathname === "/v0/management/provider-manager-auth-url");
    assert.deepEqual(login.map((request) => request.search), [`?kind=${kind}&is_webui=true`]);
    assert.equal(fixture.requests.some((request) => /\/commandcode(?:-go)?-auth-url$/.test(request.pathname)), false,
      "the retired plugins' login routes are gone");
  });
}

test("a kind route's login URL adds is_webui to its own query", async () => {
  const { CPA_LOGIN_ADAPTERS, startCpaAccountLogin } = require("../electron/cpa-oauth-adapter.cjs");
  assert.equal(CPA_LOGIN_ADAPTERS["cpa-commandcode-go"].route, "provider-manager-auth-url?kind=commandcode-go");
  assert.equal(CPA_LOGIN_ADAPTERS["cpa-commandcode-studio"].route, "provider-manager-auth-url?kind=commandcode");
  const urls = [];
  await assert.rejects(startCpaAccountLogin({
    adapterId: "cpa-commandcode-go",
    requestJson: async (pathname) => {
      urls.push(pathname);
      if (pathname === "/v0/management/auth-files") return { files: [] };
      return { status: "error" };
    },
    openExternal: async () => assert.fail("a refused login opens nothing"),
  }), /CPA did not start commandcode-go authentication/);
  assert.deepEqual(urls, ["/v0/management/auth-files", "/v0/management/provider-manager-auth-url?kind=commandcode-go&is_webui=true"]);
});

test("a kind's account listed before the login is not taken as the new one", async () => {
  const { startCpaAccountLogin } = require("../electron/cpa-oauth-adapter.cjs");
  const earlier = { name: "commandcode-go-earlier.json", provider: "provider-manager", type: "provider-manager", email: "earlier@example.test", status: "ready" };
  const fixture = providerManagerFixture({ kind: "commandcode-go", existing: [earlier] });
  const result = await startCpaAccountLogin({
    adapterId: "cpa-commandcode-go", requestJson: fixture.requestJson, openExternal: async () => undefined,
    sleep: async () => undefined, now: () => 0, timeoutMs: 10_000, pollIntervalMs: 10,
  });
  assert.equal(result.authFile.name, fixture.created.name);
  assert.equal(result.authFile.provider, "commandcode-go");
  // Each listing (before and after the login) has its kinds named once.
  assert.equal(fixture.requests.filter((request) => request.pathname === KINDS_PATH).length, 2);
});
