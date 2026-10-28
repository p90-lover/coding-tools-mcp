"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const yaml = globalThis.Bun?.YAML ?? require("js-yaml");
const parse = yaml.parse ?? yaml.load;
const stringify = yaml.stringify ?? yaml.dump;
const { refreshConfiguration, runtimeConfiguration } = require("../electron/cpa-managed.cjs");

function fixture(t, saved) {
  const root = fs.mkdtempSync(path.join(__dirname, "../../aiTemp/cpa-provider-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "config.yaml"), typeof saved === "string" ? saved : stringify(saved));
  return root;
}

test("managed restarts preserve legacy API providers alongside OAuth aliases and auth files", (t) => {
  const saved = {
    "config-version": 2,
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
  assert.equal(parsed["config-version"], 8);
  for (const key of ["claude-api-key", "openai-compatibility", "oauth-model-alias", "oauth-excluded-models"]) {
    assert.deepEqual(parsed[key], saved[key]);
  }
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 8317);
  assert.equal(parsed["auth-dir"], path.join(root, "auth"));
  assert.equal(parsed["proxy-url"], "http://127.0.0.1:17894");
  assert.equal(parsed["remote-management"]["allow-remote"], false);
  assert.equal(parsed["remote-management"]["secret-key"], "managed-management");
  assert.equal(parsed["api-keys"], undefined, "legacy client keys are not upstream credentials");
  assert.deepEqual(parsed.access["api-keys"], ["managed-api"]);
  assert.equal(fs.readFileSync(authFile, "utf8"), before);
  fs.writeFileSync(path.join(root, "config.yaml"), next);
  assert.deepEqual(parse(runtimeConfiguration(root, "managed-management", "managed-api", "http://127.0.0.1:17894")), parsed);
});

test("a route CPA 8 saved as requests.proxy-url is replaced, not kept beside the managed one", (t) => {
  const root = fixture(t, { "config-version": 8,
    requests: { "proxy-url": "http://old.invalid:1234", "request-retry": 3 } });
  const parsed = parse(runtimeConfiguration(root, "managed-management", "managed-api", "http://127.0.0.1:17891"));
  assert.equal(parsed["proxy-url"], "http://127.0.0.1:17891");
  assert.deepEqual(parsed.requests, { "request-retry": 3 }, "other request settings stay");
  const onlyRoute = fixture(t, { "config-version": 8, requests: { "proxy-url": "http://old.invalid:1234" } });
  const direct = parse(runtimeConfiguration(onlyRoute, "managed-management", "managed-api", ""));
  assert.equal(direct.requests, undefined, "a removed route leaves no grouped one behind");
  assert.equal(direct["proxy-url"], undefined);
});

test("v8 provider groups, catalogs and OAuth options survive while managed auth and security stay authoritative", (t) => {
  const saved = {
    "config-version": 8,
    // CPA v8.0.32 config.example.yaml: upstream credentials live at api-keys.<provider>.
    "api-keys": { claude: [{ name: "fixture", keys: [{ "api-key": "sk-ant-fixture" }],
      models: [{ name: "fixture-api-model", alias: "api-alias" }], headers: { "X-Fixture": "yes" } }],
    "openai-compatibility": [{ name: "fixture-compatible", "base-url": "https://api.example.test/v1",
      keys: [{ "api-key": "sk-compatible-fixture" }] }] },
    oauth: { "auth-dir": "old-auth", "model-alias": { codex: [{ name: "fixture-oauth-model", alias: "oauth-alias" }] },
      "excluded-models": { codex: ["fixture-excluded"] }, providers: { codex: { "disable-cooling": true } } },
    models: { catalog: "fixture-models.json" },
    server: { host: "0.0.0.0", port: 9999 },
    management: { "allow-remote": true }, access: { "api-keys": ["old-client-key"] },
    plugins: { enabled: false },
  };
  const root = fixture(t, saved);
  const next = parse(runtimeConfiguration(root, "managed-management", "managed-api"));
  assert.deepEqual(next["api-keys"], saved["api-keys"]);
  assert.deepEqual(next.models, saved.models);
  assert.deepEqual(next.oauth, { ...saved.oauth, "auth-dir": path.join(root, "auth") });
  assert.equal(next.server, undefined);
  assert.equal(next.management, undefined);
  assert.deepEqual(next.access, { "api-keys": ["managed-api"] });
  assert.equal(next.plugins.enabled, true);
  assert.equal(next["remote-management"]["allow-remote"], false);
});

test("fresh CPA v8 config keeps client keys out of the upstream provider namespace", (t) => {
  const root = fixture(t, "");
  const next = parse(runtimeConfiguration(root, "managed-management", "managed-api"));
  assert.equal(next["config-version"], 8);
  assert.equal(next["api-keys"], undefined);
  assert.deepEqual(next.access, { "api-keys": ["managed-api"] });
});

test("provider additions and deletions survive update refresh and the next managed restart", (t) => {
  const claude = { name: "first", keys: [{ "api-key": "sk-ant-first-fixture" }] };
  const added = { name: "second", keys: [{ "api-key": "sk-ant-second-fixture" }] };
  const gemini = { name: "gemini", keys: [{ "api-key": "gemini-fixture" }] };
  const saved = { "config-version": 8, "api-keys": { claude: [claude], gemini: [gemini] },
    access: { "api-keys": ["old-client-key"] } };
  const root = fixture(t, saved);
  const file = path.join(root, "config.yaml");
  for (const expected of [saved["api-keys"], { claude: [claude, added], gemini: [gemini] }, { claude: [] }, {}]) {
    const changed = parse(fs.readFileSync(file, "utf8"));
    changed["api-keys"] = expected;
    changed.access["api-keys"] = ["stale-client-key"];
    fs.writeFileSync(file, stringify(changed));
    assert.equal(refreshConfiguration(root, "managed-management", "managed-api"), "written");
    const refreshed = parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(refreshed["api-keys"], expected);
    assert.deepEqual(refreshed.access, { "api-keys": ["managed-api"] });
    const restarted = runtimeConfiguration(root, "managed-management", "managed-api");
    assert.deepEqual(parse(restarted), refreshed);
    fs.writeFileSync(file, restarted);
    assert.equal(refreshConfiguration(root, "managed-management", "managed-api"), "unchanged");
  }
});

test("malformed saved YAML or provider maps are never silently replaced", (t) => {
  const root = fixture(t, "");
  const file = path.join(root, "config.yaml");
  for (const saved of ["claude-api-key: [broken", "api-keys: invalid", "api-keys:\n  claude: invalid"]) {
    fs.writeFileSync(file, saved);
    assert.throws(() => refreshConfiguration(root, "management", "api"), /Saved CPA configuration is invalid/);
    assert.equal(fs.readFileSync(file, "utf8"), saved);
  }
});
