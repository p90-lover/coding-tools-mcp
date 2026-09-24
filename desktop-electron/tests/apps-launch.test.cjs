"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createAppsLaunchCoordinator, normalizeConfig } = require("../electron/apps-launch.cjs");
const { createHandlerRegistry, loadModules } = require("../../app-handler/handler-registry.cjs");
const {
  normalizeLaunchManifest,
  normalizeVisualManifest,
  orderModules,
} = require("../../app-handler/lib/launch-manifest.cjs");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function tempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-launch-"));
  return path.join(dir, "apps-config.json");
}

function service(id, managedInstall, extra = {}) {
  return {
    id,
    enabled: true,
    status: "unknown",
    managedInstall: { state: "installed", bundledRuntime: true, ...managedInstall },
    ...extra,
  };
}

function bootstrapResult(ids, status = "ready") {
  return { components: ids.map((id) => ({ id, status, action: "start", missingCredentials: [], message: null })) };
}

test("module manifests declare launch order and visuals; defaults fill the rest", () => {
  const registry = createHandlerRegistry(loadModules());
  assert.deepEqual(registry.launchOrder(), ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]);
  for (const id of registry.ids()) {
    const launch = registry.launch(id);
    assert.equal(typeof launch.order, "number", id);
    assert.equal(launch.autoStart, true, `${id} auto-starts after the core by default`);
    assert.ok(launch.readyTimeoutMs >= 1_000, id);
    assert.ok(["iframe", "file", "none"].includes(registry.visual(id).embed), id);
  }
  assert.equal(registry.visual("anneal").endpoint, "http://127.0.0.1:5173/");
  assert.equal(registry.launch("codex-router").readyTimeoutMs, 300_000);
  assert.deepEqual(registry.launch("codex-router").dependsOn, ["cpa"]);

  const defaults = normalizeLaunchManifest({});
  assert.equal(defaults.startupPolicy, "auto");
  assert.equal(defaults.installOnStartup, true);
  assert.equal(normalizeVisualManifest({}).embed, "none");
  assert.throws(() => normalizeLaunchManifest({ launch: { startupPolicy: "sometimes" } }), /startupPolicy/);
  assert.throws(() => normalizeVisualManifest({ visual: { endpoint: "http://example.com/" } }), /loopback/);
});

test("dependsOn wins over declared order and ignores unknown modules", () => {
  const ordered = orderModules({
    b: { order: 10, dependsOn: ["a", "ghost"] },
    a: { order: 20, dependsOn: [] },
    c: { order: 5, dependsOn: ["b"] },
  });
  assert.deepEqual(ordered, ["a", "b", "c"]);
});

test("the apps host advertises launch and visual metadata to the renderer", () => {
  const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");
  const listed = createCodingToolsAppsHost({}).list();
  assert.deepEqual(listed.launchOrder, ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]);
  const cpa = listed.modules.find((entry) => entry.id === "cpa");
  assert.equal(cpa.launch.order, 10);
  assert.equal(cpa.visual.embed, "iframe");
  assert.deepEqual(cpa.visual.controls, ["module-lifecycle", "provider-oauth"]);
});

test("plan follows manifest order and skips modules the policy excludes", () => {
  const registry = createHandlerRegistry(loadModules());
  const services = {
    services: [
      service("cpa", { state: "installed" }),
      service("codex-router", { state: "repair-required" }),
      service("commandcode-proxy", { state: "not-installed", bundledRuntime: false }),
      service("paseo", { state: "not-installed", bundledRuntime: true }),
      service("anneal", { state: "installing" }),
    ],
  };
  const coordinator = createAppsLaunchCoordinator({
    registry,
    configPath: tempConfigPath(),
    snapshot: () => services,
    reconcile: async () => bootstrapResult([]),
  });
  const plan = coordinator.plan("startup");
  assert.deepEqual(plan.modules.map((module) => [module.id, module.planned, module.action, module.skipReason]), [
    ["cpa", true, "start", null],
    ["codex-router", true, "repair", null],
    ["commandcode-proxy", false, "skip", "no-bundled-runtime"],
    ["paseo", true, "install", null],
    ["anneal", false, "skip", "install-in-progress"],
  ]);
});

test("startup waits for the core, then reconciles planned modules in order and persists the outcome", async () => {
  const registry = createHandlerRegistry(loadModules());
  const configPath = tempConfigPath();
  const calls = [];
  const published = [];
  let releaseCore;
  const coreReady = new Promise((resolve) => { releaseCore = resolve; });
  const coordinator = createAppsLaunchCoordinator({
    registry,
    configPath,
    snapshot: () => ({ services: registry.ids().map((id) => service(id, { state: "installed" })) }),
    reconcile: async (input) => {
      calls.push(input);
      return bootstrapResult(input.componentIds);
    },
    publish: (value) => published.push(value.status),
    coreReadyTimeoutMs: 5_000,
  });

  const run = coordinator.runAfterCoreReady([coreReady], { reason: "startup", version: "0.7.0-rc.13" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.getSnapshot().status, "waiting");
  assert.equal(calls.length, 0, "nothing launches before the core is ready");

  releaseCore({ status: "ready" });
  const result = await run;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, "apps-launch:startup");
  assert.deepEqual(calls[0].componentIds, ["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]);
  assert.equal(result.status, "ready");
  assert.ok(result.modules.every((module) => module.status === "ready"));
  assert.ok(published.includes("waiting") && published.includes("running") && published.includes("ready"));

  const persisted = normalizeConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
  assert.equal(persisted.lastLaunch.cpa.status, "ready");
  assert.equal(persisted.lastLaunch.cpa.version, "0.7.0-rc.13");
  assert.equal(persisted.lastLaunch.cpa.reason, "startup");
});

test("a stuck core does not block the integrated apps forever", async () => {
  const registry = createHandlerRegistry(loadModules());
  const calls = [];
  const coordinator = createAppsLaunchCoordinator({
    registry,
    configPath: tempConfigPath(),
    snapshot: () => ({ services: [service("cpa", { state: "installed" })] }),
    reconcile: async (input) => {
      calls.push(input.componentIds);
      return bootstrapResult(input.componentIds);
    },
    coreReadyTimeoutMs: 20,
  });
  const never = new Promise(() => {});
  const result = await coordinator.runAfterCoreReady([never], { reason: "startup" });
  assert.deepEqual(calls, [["cpa"]]);
  assert.equal(result.modules.find((module) => module.id === "cpa").status, "ready");
  assert.ok(result.waitedMs >= 0);
});

test("operator overrides persist across coordinators and change the plan", async () => {
  const registry = createHandlerRegistry(loadModules());
  const configPath = tempConfigPath();
  const snapshot = () => ({ services: registry.ids().map((id) => service(id, { state: "installed" })) });
  const first = createAppsLaunchCoordinator({
    registry,
    configPath,
    snapshot,
    reconcile: async (input) => bootstrapResult(input.componentIds),
  });
  first.configure("anneal", { autoStart: false });
  assert.equal(first.plan("startup").modules.find((module) => module.id === "anneal").skipReason, "auto-start-disabled");

  const second = createAppsLaunchCoordinator({
    registry,
    configPath,
    snapshot,
    reconcile: async (input) => bootstrapResult(input.componentIds),
  });
  const plan = second.plan("startup");
  assert.equal(plan.modules.find((module) => module.id === "anneal").planned, false);
  assert.equal(plan.modules.find((module) => module.id === "paseo").planned, true);
  assert.throws(() => second.configure("nope", { autoStart: true }), /Unknown Coding Tools module/);
});

test("bootstrap failures surface per module instead of throwing", async () => {
  const registry = createHandlerRegistry(loadModules());
  const coordinator = createAppsLaunchCoordinator({
    registry,
    configPath: tempConfigPath(),
    snapshot: () => ({ services: [service("cpa", { state: "installed" }), service("paseo", { state: "installed" })] }),
    reconcile: async () => ({
      components: [
        { id: "cpa", status: "ready", action: "start", missingCredentials: [], message: null },
        { id: "paseo", status: "error", action: "start", missingCredentials: [], message: "daemon exited" },
      ],
    }),
  });
  const result = await coordinator.run({ reason: "manual", ids: ["cpa", "paseo"] });
  assert.equal(result.status, "partial");
  assert.equal(result.modules.find((module) => module.id === "paseo").message, "daemon exited");
  assert.equal(result.modules.find((module) => module.id === "cpa").status, "ready");
});

test("main.cjs launches integrated apps after the core, not in the after-paint hook", () => {
  const main = read("electron/main.cjs");
  const afterPaint = main.slice(main.indexOf("scheduleFullIpcAfterPaint(() => {"), main.indexOf("await providerNetworkReady();"));
  assert.doesNotMatch(afterPaint, /externalServicesController\.start\(/, "no early managed-service autostart");
  assert.doesNotMatch(afterPaint, /startManagedCpa/);
  assert.match(main, /appsLaunchCoordinator\.runAfterCoreReady\(\s*\[runtimeStartupInFlight, devRuntimeStartup, startupAuthenticationRefresh\]/);
  assert.ok(main.indexOf("appsLaunchCoordinator.runAfterCoreReady(") > main.indexOf("runtimeStartupInFlight = (async () => {"));
  assert.match(main, /componentIds: manifestLaunchOrder/);
  assert.match(main, /apps-config\.json/);
  for (const channel of ["launcher:apps-launch-snapshot", "launcher:apps-launch-run", "launcher:apps-launch-configure"]) {
    assert.match(main, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const preload = read("electron/preload.cjs");
  assert.match(preload, /appsLaunchSnapshot/);
  assert.match(preload, /configureAppLaunch/);
  assert.match(preload, /launcher:apps-launch-changed/);
});

test("original UI reads ready timeouts and visual endpoints from module manifests", () => {
  const source = read("electron/original-ui.cjs");
  assert.match(source, /readyWaitMs\(registry, toolId\)/);
  assert.match(source, /moduleVisual\(registry, "anneal"\)\?\.endpoint/);
  assert.match(source, /registry = loadDefaultModuleRegistry\(\)/);
});
