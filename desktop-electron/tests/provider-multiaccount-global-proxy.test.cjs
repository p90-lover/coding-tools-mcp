"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadTypeScriptModule(relativePath) {
  const filename = path.join(__dirname, "..", relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  const module = { exports: {} };
  const localRequire = (specifier) => {
    throw new Error(`unexpected runtime dependency ${specifier} in ${relativePath}`);
  };
  Function("require", "module", "exports", compiled.outputText)(
    localRequire,
    module,
    module.exports,
  );
  return module.exports;
}

function account(overrides = {}) {
  return {
    id: "codex-main",
    providerId: "codex-oauth",
    label: "Codex main",
    identity: "main@example.test",
    auth: "oauth",
    status: "connected",
    enabled: true,
    isDefault: false,
    models: ["codex"],
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function profile(id, host, protocol = "http") {
  return {
    id,
    name: id,
    enabled: true,
    endpoint: { protocol, host, port: protocol.startsWith("socks") ? 1080 : 8080 },
    scopes: ["all"],
    bypass: ["localhost", "127.0.0.1", "::1"],
  };
}

test("provider accounts support multiple logins, one default, fallback, and archive without deletion", () => {
  const manager = loadTypeScriptModule("src/providers/provider-account-manager.ts");
  let state = manager.createProviderAccountState([
    account({ id: "codex-main", isDefault: true }),
    account({ id: "codex-backup", label: "Codex backup", identity: "backup@example.test" }),
  ]);

  state = manager.setDefaultProviderAccount(state, "codex-oauth", "codex-backup");
  assert.equal(state.accounts.find((item) => item.id === "codex-main").isDefault, false);
  assert.equal(state.accounts.find((item) => item.id === "codex-backup").isDefault, true);
  assert.equal(manager.selectProviderAccount(state, "codex-oauth").id, "codex-backup");

  state = manager.archiveProviderAccount(
    state,
    "codex-backup",
    "2026-09-16T01:00:00.000Z",
  );
  assert.equal(state.accounts.length, 2, "archive must preserve the account record");
  assert.equal(
    state.accounts.find((item) => item.id === "codex-backup").archivedAt,
    "2026-09-16T01:00:00.000Z",
  );
  assert.equal(manager.selectProviderAccount(state, "codex-oauth").id, "codex-main");
});

test("proxy routing resolves account then provider then global saved profiles", () => {
  const proxy = loadTypeScriptModule("src/network/proxy-manager.ts");
  const state = {
    global: null,
    globalEnabled: true,
    globalProfileId: "global",
    profiles: [
      profile("global", "global.proxy.test"),
      profile("provider", "provider.proxy.test", "socks4"),
      profile("account", "account.proxy.test", "socks5"),
    ],
    providers: [{
      providerId: "codex-oauth",
      inheritGlobal: true,
      profileId: "provider",
    }],
    accounts: [{
      accountId: "codex-main",
      providerId: "codex-oauth",
      inheritProvider: true,
      inheritGlobal: true,
      profileId: "account",
    }],
  };

  assert.equal(proxy.resolveProxy("codex-oauth", state, "codex-main").endpoint.host, "account.proxy.test");
  assert.equal(proxy.resolveProxy("codex-oauth", state, "codex-backup").endpoint.host, "provider.proxy.test");
  assert.equal(proxy.resolveProxy("claude-oauth", state, "claude-main").endpoint.host, "global.proxy.test");
  assert.equal(proxy.validateProxy(profile("socks4", "proxy.test", "socks4")), true);
  assert.equal(
    proxy.shouldProxyUrl("wss://api.example.test/socket", "websocket", profile("ws", "proxy.test")),
    true,
  );
  assert.equal(
    proxy.shouldProxyUrl("http://127.0.0.1:43110/mcp", "local-control", profile("local", "proxy.test")),
    false,
  );
});

test("renderer and Electron IPC expose the Provider Hub and global proxy controls", () => {
  const read = (relativePath) => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
  const main = read("src/main.tsx");
  const integration = read("src/providers/ProviderHubIntegration.tsx");
  const types = read("src/types.ts");
  const preload = read("electron/preload.cjs");
  const bootstrap = read("electron/provider-bootstrap.cjs");
  const wrapper = read("electron/main-with-provider.cjs");
  const styles = read("src/providers/provider-manager.css");
  const packageJson = JSON.parse(read("package.json"));

  assert.match(types, /Surface[^;]+"providers"/s);
  assert.match(main, /ProviderHubIntegration/);
  assert.match(integration, /ProviderManagerSurface/);
  assert.match(integration, /archiveProviderAccount/);
  assert.match(integration, /archiveProxyProfile/);
  assert.match(preload, /providerSnapshot/);
  assert.match(preload, /saveProviderAccount/);
  assert.match(preload, /saveProxyProfile/);
  assert.match(preload, /setGlobalProxyRouting/);
  assert.match(bootstrap, /createProviderNetworkStore/);
  assert.match(bootstrap, /launcher:provider-snapshot/);
  assert.match(bootstrap, /launcher:proxy-global-routing/);
  assert.match(wrapper, /installProviderNetwork/);
  assert.equal(packageJson.main, "electron/main-with-provider.cjs");
  assert.match(styles, /\.provider-manager/);
});
