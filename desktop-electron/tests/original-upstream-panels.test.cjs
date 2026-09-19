"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createExternalServicesController,
  projectCommandCodeHealth,
} = require("../electron/external-services.cjs");
const { sectionUrl } = require("../electron/upstream-tools.cjs");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("pinned Paseo and app-managed Anneal manifests open original in-app routes", () => {
  const paseo = JSON.parse(read("vendor/upstream/paseo.json"));
  const anneal = JSON.parse(read("vendor/upstream/anneal.json"));

  assert.deepEqual(paseo.sections, [
    "agents",
    "sessions",
    "workspaces",
    "providers",
    "plugins",
    "voice",
    "settings",
  ]);
  assert.equal(sectionUrl(paseo, paseo.defaultEndpoint, "agents"), "http://127.0.0.1:6768/sessions");
  assert.equal(sectionUrl(paseo, paseo.defaultEndpoint, "sessions"), "http://127.0.0.1:6768/sessions");
  assert.equal(sectionUrl(paseo, paseo.defaultEndpoint, "workspaces"), "http://127.0.0.1:6768/open-project");
  assert.equal(sectionUrl(paseo, paseo.defaultEndpoint, "settings"), "http://127.0.0.1:6768/settings");
  assert.equal(anneal.defaultEndpoint, "http://127.0.0.1:5173/");
  assert.equal(sectionUrl(anneal, anneal.defaultEndpoint, "tasks"), "http://127.0.0.1:5173/#/tasks");
  assert.equal(sectionUrl(anneal, anneal.defaultEndpoint, "inbox"), "http://127.0.0.1:5173/#/inbox");
});

test("UpstreamToolSurface inspects managed modules through Coding Tools APIs without opening original GUIs", () => {
  const surface = read("src/features/UpstreamToolSurface.tsx");
  const styles = read("src/features/upstream-tool.css");
  assert.match(surface, /inspectUpstreamTool\(toolId\)/);
  assert.match(surface, /codingTools\?\.apps/);
  assert.match(surface, /is-immersive/);
  assert.match(surface, /Coding Tools manages Anneal through WSL2 and Docker on Windows/);
  assert.match(surface, /start or inspect the bundled in-app service/);
  assert.doesNotMatch(surface, /user-managed secure local port forward/);
  assert.doesNotMatch(surface, /port-forward/);
  assert.doesNotMatch(surface, /Start pinned source/);
  assert.doesNotMatch(surface, /configure its pinned source directory/);
  assert.doesNotMatch(surface, /Opening the original embedded interface/);
  assert.match(styles, /\.upstream-tool-surface\.is-immersive/);
});

test("CommandCode Proxy panel reproduces the original banner and uses real lifecycle actions", () => {
  const panel = read("src/features/CommandCodeProxySurface.tsx");
  const integrations = read("src/features/ExternalServicesSurface.tsx");
  assert.match(panel, /CommandCode AI Proxy/);
  assert.match(panel, /ANTHROPIC_BASE_URL=/);
  assert.match(panel, /Copy OpenAI base URL/);
  assert.match(panel, /onStart/);
  assert.match(panel, /onCheck/);
  assert.match(panel, /app-managed \(not shown\)/);
  assert.match(integrations, /CommandCodeProxySurface/);
  assert.match(integrations, /onCheck=\{\(\) => void inspect\(\)\}/);
});

test("commandcode inspect projects the original GET / health banner without exposing secrets", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coding-tools-commandcode-health-"));
  const requested = [];
  const controller = createExternalServicesController({
    filePath: path.join(directory, "services.json"),
    keyPath: path.join(directory, "services.key"),
    safeStorage: { isEncryptionAvailable: () => false },
    getHealthHeaders: () => ({ Authorization: "Bearer managed-secret" }),
    fetchImpl: async (url, options) => {
      requested.push({ url: String(url), authorization: options?.headers?.Authorization });
      const pathname = new URL(url, "http://127.0.0.1:9090").pathname;
      if (pathname === "/") {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({
            status: "ok",
            proxy: "commandcode-proxy",
            version: "1.0.0",
            endpoints: { openai_chat: "/v1/chat/completions" },
            user: { email: "user@example.test" },
            credits: 12,
            models: ["deepseek/deepseek-v4-pro"],
            apiKey: "should-not-leak",
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        clone: () => ({ json: async () => ({ data: [{ id: "deepseek/deepseek-v4-pro" }] }) }),
      };
    },
  });

  const result = await controller.inspect("commandcode-proxy");
  assert.equal(result.status, "ready");
  assert.equal(result.health.status, "ok");
  assert.equal(result.health.version, "1.0.0");
  assert.deepEqual(result.health.models, ["deepseek/deepseek-v4-pro"]);
  assert.equal(result.health.user.email, "user@example.test");
  assert.equal(result.health.apiKey, undefined);
  assert.ok(requested.some((entry) => entry.url.endsWith("/v1/models")));
  assert.ok(requested.some((entry) => entry.url.endsWith("/") && !entry.url.endsWith("/v1/models")));
  controller.dispose();
});

test("commandcode health projection drops unknown secret-like fields", () => {
  const health = projectCommandCodeHealth({
    status: "ok",
    proxy: "commandcode-proxy",
    apiKey: "secret",
    PROXY_API_KEY: "secret",
    models: ["glm-5"],
  });
  assert.equal(health.status, "ok");
  assert.equal(health.apiKey, undefined);
  assert.equal(health.PROXY_API_KEY, undefined);
  assert.deepEqual(health.models, ["glm-5"]);
});
