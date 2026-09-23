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

function route(overrides = {}) {
  return {
    enabled: true,
    endpoint: { protocol: "http", host: "127.0.0.1", port: 7890 },
    scopes: ["all"],
    bypass: ["*.internal.test"],
    ...overrides,
  };
}

test("proxy routing never sends loopback control traffic externally", () => {
  const proxy = loadTypeScriptModule("src/network/proxy-manager.ts");
  const configured = route();

  assert.equal(proxy.shouldProxyUrl("http://127.0.0.1:43110/mcp", "local-control", configured), false);
  assert.equal(proxy.shouldProxyUrl("http://localhost:43110/mcp", "browser", configured), false);
  assert.equal(proxy.shouldProxyUrl("https://api.example.test/v1", "provider", configured), true);
  assert.equal(proxy.shouldProxyUrl("https://service.internal.test/v1", "provider", configured), false);
  assert.equal(proxy.validateProxy(configured), true);
});

test("provider proxy overrides are bounded and explicit", () => {
  const proxy = loadTypeScriptModule("src/network/proxy-manager.ts");
  const global = route();
  const override = route({ endpoint: { protocol: "socks5", host: "proxy.example.test", port: 1080 } });

  assert.equal(proxy.resolveProxy("direct-provider", {
    global,
    providers: [{ providerId: "direct-provider", inheritGlobal: false }],
  }), null);
  assert.deepEqual(proxy.resolveProxy("custom-provider", {
    global,
    providers: [{ providerId: "custom-provider", inheritGlobal: true, override }],
  }), override);
});

test("provider catalog contains every approved built-in surface", () => {
  const providers = loadTypeScriptModule("src/providers/provider-types.ts");
  const ids = providers.DEFAULT_PROVIDERS.map((provider) => provider.id);
  assert.deepEqual(ids, [
    "codex-oauth",
    "claude-oauth",
    "gemini-oauth",
    "chatgpt-web",
    "ai-studio-reverse-proxy",
    "gemini-reverse-proxy",
    "aistudio-to-api",
    "cliproxyapi-antigravity",
    "commandcode-proxy",
  ]);
  assert.equal(providers.DEFAULT_PROVIDERS.every((provider) => provider.paseoEnabled && provider.annealEnabled), true);
  assert.deepEqual(providers.DEFAULT_PROVIDERS.find((provider) => provider.id === "chatgpt-web")?.models, ["chatgpt-web/high"]);
});

test("Traditional Chinese locale covers the rc.2 control center", () => {
  const locale = loadTypeScriptModule("src/i18n/locales/zh-TW.ts").default;
  for (const key of [
    "providers",
    "agents",
    "orchestrators",
    "tasks",
    "annealMonitor",
    "networkProxy",
    "customOrchestrator",
    "useAsSubagent",
    "resolvedPlan",
    "webTasks",
  ]) {
    assert.equal(typeof locale[key], "string", `missing zh-TW key ${key}`);
    assert.notEqual(locale[key].trim(), "", `empty zh-TW key ${key}`);
  }
});
