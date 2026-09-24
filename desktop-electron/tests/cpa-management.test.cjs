"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");

test("CPA management APIs use main-process credentials and preserve OAuth state", async (context) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    const pathname = new URL(request.url, "http://localhost").pathname;
    const replies = {
      "/v0/management/auth-files": { files: [{ name: "codex.json", provider: "codex", access_token: "never-export" }] },
      "/v0/management/auth-files/models": { models: [{ id: "example-model" }] },
      "/v0/management/codex-auth-url": { status: "ok", state: "state+with/slash", url: "https://auth.openai.com/authorize?state=example" },
      "/v0/management/get-auth-status": { status: "ok", access_token: "never-export" },
      "/v0/management/oauth-session": { status: "ok" },
      "/v0/management/plugins": { plugins: [{ name: "example", apiKey: "never-export" }] },
    };
    if (!replies[pathname]) response.statusCode = 404;
    response.end(JSON.stringify(replies[pathname] || { error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const host = createCodingToolsAppsHost({ services: {
    loopbackRequest: () => ({
      origin: `http://127.0.0.1:${server.address().port}/`,
      headers: { Authorization: "Bearer inference-only" },
      managementHeaders: { Authorization: "Bearer management-only" },
    }),
  } });

  const files = await host.call("cpa", "authFiles");
  assert.equal(files.result.files[0].name, "codex.json");
  const models = await host.call("cpa", "authFileModels", { name: "codex name&.json" });
  assert.deepEqual(models.result.models, ["example-model"]);
  assert.ok(requests.some((request) => request.path.endsWith("?name=codex%20name%26.json")));
  const login = await host.call("cpa", "oauthStart", { provider: "codex", endpoint: "https://untrusted.example/" });
  assert.equal(login.ok, true);
  assert.equal(login.result.status, "pending");
  const progress = await host.call("cpa", "oauthStatus", { state: login.result.state });
  assert.equal(progress.result.status, "connected");
  const cancelled = await host.call("cpa", "oauthCancel", { state: login.result.state });
  assert.equal(cancelled.result.status, "cancelled");
  assert.ok(requests.some((request) => request.method === "DELETE" && request.path.includes("state%2Bwith%2Fslash")));
  const plugins = await host.call("cpa", "plugins");
  assert.equal(plugins.result.catalog.plugins[0].name, "example");
  assert.ok(requests.every((request) => request.authorization === "Bearer management-only"));
  assert.doesNotMatch(JSON.stringify({ files, models, login, progress, cancelled, plugins }), /never-export|management-only|inference-only/);
  assert.equal(host.isReadOnly("cpa", "oauthStart"), false);
  assert.equal(host.isReadOnly("cpa", "oauthCancel"), false);
  assert.equal(host.isReadOnly("cpa", "oauthStatus"), true);
  const requestCount = requests.length;
  assert.equal((await host.call("cpa", "oauthStart", { provider: "../../config" })).ok, false);
  assert.equal((await host.call("cpa", "oauthStatus", { state: "" })).ok, false);
  assert.equal(requests.length, requestCount);
});

test("CPA management fails closed without management credentials", async () => {
  const host = createCodingToolsAppsHost();
  const result = await host.call("cpa", "plugins");
  assert.equal(result.ok, false);
  assert.match(result.result.reason, /management key is unavailable/);
});
