"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const yaml = globalThis.Bun?.YAML ?? require("js-yaml");
const parse = yaml.parse ?? yaml.load;
const stringify = yaml.stringify ?? yaml.dump;
const { runtimeConfiguration } = require("../electron/cpa-managed.cjs");

function fixture(t, saved) {
  const root = fs.mkdtempSync(path.join(__dirname, "../../aiTemp/cpa-provider-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "config.yaml"), typeof saved === "string" ? saved : stringify(saved));
  return root;
}

test("managed restarts preserve legacy API providers alongside OAuth aliases and auth files", (t) => {
  const saved = {
    host: "0.0.0.0", port: 9000, "auth-dir": "other-auth", "proxy-url": "http://old.invalid:1234",
    "remote-management": { "allow-remote": true, "secret-key": "old-management" },
    "claude-api-key": [{ "api-key": "sk-ant-fixture", "base-url": "https://api.example.test",
      models: [{ name: "fixture-api-model", alias: "api-alias" }], "custom-provider-option": true }],
    "openai-compatibility": [{ name: "fixture", "base-url": "https://api.example.test/v1",
      "api-key-entries": [{ "api-key": "sk-fixture" }], models: [{ name: "fixture-second-model" }] }],
    "oauth-model-alias": { codex: [{ name: "fixture-oauth-model", alias: "oauth-alias" }] },
    "oauth-excluded-models": { codex: ["fixture-excluded"] },
  };
  const root = fixture(t, saved);
  fs.mkdirSync(path.join(root, "auth"));
  const authFile = path.join(root, "auth", "fixture.json");
  fs.writeFileSync(authFile, JSON.stringify({ type: "codex", access_token: "fixture-only" }));
  const before = fs.readFileSync(authFile, "utf8");
  const next = runtimeConfiguration(root, "managed-management", "managed-api", "http://127.0.0.1:17894");
  const parsed = parse(next);
  for (const key of ["claude-api-key", "openai-compatibility", "oauth-model-alias", "oauth-excluded-models"]) {
    assert.deepEqual(parsed[key], saved[key]);
  }
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 8317);
  assert.equal(parsed["auth-dir"], path.join(root, "auth"));
  assert.equal(parsed["proxy-url"], "http://127.0.0.1:17894");
  assert.equal(parsed["remote-management"]["allow-remote"], false);
  assert.equal(parsed["remote-management"]["secret-key"], "managed-management");
  assert.deepEqual(parsed["api-keys"], ["managed-api"]);
  assert.equal(fs.readFileSync(authFile, "utf8"), before);
  fs.writeFileSync(path.join(root, "config.yaml"), next);
  assert.deepEqual(parse(runtimeConfiguration(root, "managed-management", "managed-api", "http://127.0.0.1:17894")), parsed);
});

test("v8 provider groups, catalogs and OAuth options survive while managed auth and security stay authoritative", (t) => {
  const saved = {
    "config-version": 8,
    upstream: { "api-keys": { claude: [{ name: "fixture", keys: [{ "api-key": "sk-ant-fixture" }],
      models: [{ name: "fixture-api-model", alias: "api-alias" }], headers: { "X-Fixture": "yes" } }] } },
    oauth: { "auth-dir": "old-auth", "model-alias": { codex: [{ name: "fixture-oauth-model", alias: "oauth-alias" }] },
      "excluded-models": { codex: ["fixture-excluded"] }, providers: { codex: { "disable-cooling": true } } },
    models: { catalog: "fixture-models.json" },
    server: { host: "0.0.0.0", port: 9999 },
    management: { "allow-remote": true }, access: { "api-keys": ["old-client-key"] },
    plugins: { enabled: false },
  };
  const root = fixture(t, saved);
  const next = parse(runtimeConfiguration(root, "managed-management", "managed-api"));
  assert.deepEqual(next.upstream, saved.upstream);
  assert.deepEqual(next.models, saved.models);
  assert.deepEqual(next.oauth, { ...saved.oauth, "auth-dir": path.join(root, "auth") });
  assert.equal(next.server, undefined);
  assert.equal(next.management, undefined);
  assert.equal(next.access, undefined);
  assert.equal(next.plugins.enabled, true);
  assert.equal(next["remote-management"]["allow-remote"], false);
  assert.deepEqual(next["api-keys"], ["managed-api"]);
});

test("malformed saved YAML is never silently replaced", (t) => {
  const saved = "claude-api-key: [broken";
  const root = fixture(t, saved);
  assert.throws(() => runtimeConfiguration(root, "management", "api"), /Saved CPA configuration is invalid/);
  assert.equal(fs.readFileSync(path.join(root, "config.yaml"), "utf8"), saved);
});
