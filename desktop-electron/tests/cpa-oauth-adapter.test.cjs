"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");

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
