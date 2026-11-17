"use strict";
// Route resolution for the egress router (electron/egress-routes.cjs).
const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveEgressRoutes, routeToken, routerUrl, noProxyList, normalizeCredentialPolicy, providerType } = require("../electron/egress-routes.cjs");

const profiles = {
  us: { mode: "proxy", profileId: "us", endpoint: { protocol: "http", host: "us.example", port: 10000 }, credentials: { username: "u", password: "secret" }, bypass: [] },
  hk: { mode: "proxy", profileId: "hk", endpoint: { protocol: "socks5", host: "hk.example", port: 1080 }, credentials: null, bypass: [] },
};
const profileRoute = (id) => profiles[id] ?? { mode: "broken", reason: "This route's proxy was removed or turned off" };
const credentials = [{ name: "codex-a@x.json", provider: "codex" }, { name: "codex-b@x.json", provider: "codex" }, { name: "agy-1.json", provider: "antigravity" }];

test("everything follows Global Routing when nothing else is set", () => {
  const { table, describe } = resolveEgressRoutes({ routing: { globalEnabled: true, globalProfileId: "us", providers: [] }, profileRoute, credentials });
  for (const target of ["app", "cpa", "provider:codex", "provider:antigravity", "credential:codex-a@x.json", "credential:agy-1.json"]) {
    assert.equal(table.targets[target].profileId, "us", target);
    assert.equal(table.tokens[routeToken(target)], target, `token for ${target}`);
  }
  assert.equal(describe["credential:codex-a@x.json"].from, "app");
  assert.equal(describe["credential:codex-a@x.json"].route.host, "us.example");
  assert.equal(JSON.stringify(describe).includes("secret"), false, "the Proxy page view never holds a sign-in");
});

test("Global Routing off is direct, for model traffic too", () => {
  const { table } = resolveEgressRoutes({ routing: { globalEnabled: false, globalProfileId: null, providers: [{ providerId: "cpa", inheritGlobal: true }] }, profileRoute, credentials });
  assert.deepEqual(table.targets.app, { mode: "direct" });
  assert.deepEqual(table.targets.cpa, { mode: "direct" });
  assert.deepEqual(table.targets["credential:codex-a@x.json"], { mode: "direct" });
});

test("credential, provider and the model default override the level above; Direct is explicit", () => {
  const routing = { globalEnabled: true, globalProfileId: "us", providers: [
    // As setProviderPolicy saves a proxy: inheritGlobal stays true beside the profileId.
    { providerId: "cpa", inheritGlobal: true, profileId: "hk" },
    { providerId: "codex-oauth", inheritGlobal: false },
  ], credentials: [{ authName: "codex-b@x.json", mode: "profile", profileId: "us" }] };
  const { table, describe } = resolveEgressRoutes({ routing, profileRoute, credentials });
  assert.equal(table.targets.app.profileId, "us");
  assert.equal(table.targets.cpa.profileId, "hk", "all model providers take their own route");
  assert.deepEqual(table.targets["provider:codex"], { mode: "direct" }, "the legacy id codex-oauth is the codex provider");
  assert.deepEqual(table.targets["credential:codex-a@x.json"], { mode: "direct" }, "follows its provider");
  assert.equal(describe["credential:codex-a@x.json"].from, "provider:codex");
  assert.equal(table.targets["credential:codex-b@x.json"].profileId, "us", "its own route wins");
  assert.equal(table.targets["provider:antigravity"].profileId, "hk", "follows the model default");
  assert.equal(describe["credential:agy-1.json"].from, "cpa");
});

test("a route naming a missing proxy is broken, never direct", () => {
  const { table, describe } = resolveEgressRoutes({ routing: { globalEnabled: true, globalProfileId: "gone", providers: [] }, profileRoute, credentials });
  assert.equal(table.targets.app.mode, "broken");
  assert.equal(table.targets["credential:codex-a@x.json"].mode, "broken", "inherits the broken route");
  assert.match(describe.app.route.reason, /removed or turned off/);
  const empty = resolveEgressRoutes({ routing: { globalEnabled: true, globalProfileId: null }, profileRoute }).table;
  assert.equal(empty.targets.app.mode, "broken");
});

test("Browser-tab accounts take their binding, else the App route", () => {
  const { table, describe } = resolveEgressRoutes({ routing: { globalEnabled: true, globalProfileId: "us" }, profileRoute,
    browserBindings: [{ partition: "persist:acct-1", profileId: "hk" }, { partition: "persist:acct-2", profileId: null }] });
  assert.equal(table.targets["browser:persist:acct-1"].profileId, "hk");
  assert.equal(table.targets["browser:persist:acct-2"].profileId, "us");
  assert.equal(describe["browser:persist:acct-2"].from, "app");
});

test("tokens are stable and opaque; router URLs carry only the token and the router key", () => {
  assert.equal(routeToken("app"), "app");
  assert.equal(routeToken("credential:codex-a@x.json"), routeToken("credential:codex-a@x.json"));
  assert.match(routeToken("credential:codex-a@x.json"), /^c-[0-9a-f]{20}$/);
  assert.doesNotMatch(routeToken("credential:codex-a@x.json"), /@|codex/, "no account name in a URL");
  assert.equal(routerUrl({ port: 17900, key: "k".repeat(64), target: "app" }), `http://app:${"k".repeat(64)}@127.0.0.1:17900`);
  assert.throws(() => routerUrl({ port: 0, key: "k", target: "app" }), /no port/);
  assert.equal(noProxyList(), "localhost,127.0.0.1,::1,*.localhost");
});

test("credential policies are validated", () => {
  assert.deepEqual(normalizeCredentialPolicy({ authName: "a.json", mode: "profile", profileId: "us" }), { authName: "a.json", mode: "profile", profileId: "us" });
  assert.deepEqual(normalizeCredentialPolicy({ authName: "a.json", provider: "codex-oauth", mode: "direct" }), { authName: "a.json", provider: "codex", mode: "direct" });
  assert.deepEqual(normalizeCredentialPolicy({ authName: "a.json", mode: "direct", profileId: "us" }), { authName: "a.json", mode: "direct" });
  assert.equal(normalizeCredentialPolicy({ authName: "a.json", mode: "profile" }), null, "a proxy route needs its proxy");
  assert.equal(normalizeCredentialPolicy({ authName: "", mode: "direct" }), null);
  assert.equal(providerType("cliproxyapi-antigravity"), "antigravity");
  assert.equal(providerType("provider-manager"), "provider-manager");
});
