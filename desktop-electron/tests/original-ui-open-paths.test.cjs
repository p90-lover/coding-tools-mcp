"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  TOOL_IDS,
  IFRAME_TOOL_IDS,
  classifyOriginalUiUnavailable,
  createOriginalUiController,
  loadManifest,
  sectionUrl,
} = require("../electron/original-ui.cjs");
const { attachCpaCodexLongRun } = require("../electron/cpa-codex-long-run.cjs");
const { createUpstreamToolController } = require("../electron/upstream-tools.cjs");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("packaged renderer permits only loopback app frames", () => {
  const html = read("index.html");
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(csp, "renderer CSP is present");
  const frameSources = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith("frame-src "));
  assert.ok(frameSources, "local module iframes must not fall back to default-src 'self'");
  for (const host of ["127.0.0.1", "localhost"]) {
    for (const scheme of ["http", "https"]) {
      assert.ok(frameSources.includes(`${scheme}://${host}:*`), `${scheme}://${host} modules can render`);
    }
  }
  assert.doesNotMatch(frameSources, /(?:^|\s)(?:https?:|\*)(?:\s|$)/);
  assert.doesNotMatch(frameSources, /\[::1\]/, "IPv6 literals are not valid CSP host sources");
});

function service(id, extra = {}) {
  const endpoints = {
    cpa: "http://127.0.0.1:8317/",
    "codex-router": "http://127.0.0.1:4202/",
    paseo: "http://127.0.0.1:6768/",
    anneal: "http://127.0.0.1:5173/",
  };
  return {
    id,
    endpoint: endpoints[id],
    status: "ready",
    pid: 7,
    home: `/tmp/${id}-home`,
    stateDir: `/tmp/${id}-state`,
    managedInstall: { state: "installed" },
    ...extra,
  };
}

function controllerFor(services, extra = {}) {
  return createOriginalUiController({
    longRun: false,
    sleep: async () => {},
    externalServices: {
      snapshot: () => ({ services }),
      inspect: async () => {},
      start: async () => {},
      ...extra,
    },
  });
}

test("original UI catalog retains CPA management and rejects retired manifests", () => {
  assert.deepEqual(TOOL_IDS, ["cpa"]);
  assert.deepEqual(IFRAME_TOOL_IDS, ["cpa"]);
  const cpa = loadManifest("cpa");
  assert.equal(sectionUrl(cpa, cpa.defaultEndpoint, "oauth"), "http://127.0.0.1:8317/management.html#/oauth");
  for (const id of ["paseo", "anneal", "codex-router"]) {
    assert.throws(() => loadManifest(id), /Unknown original UI/);
  }
});

test("original-ui-open attaches to ready CPA Management Center without starting again", async () => {
  const calls = [];
  const controller = controllerFor([service("cpa")], {
    inspect: async (id) => { calls.push(["inspect", id]); },
    start: async (id) => { calls.push(["start", id]); },
    installManagedComponent: async (id) => { calls.push(["install", id]); },
  });
  const cpa = await controller.openEmbedded("cpa", "oauth");
  assert.equal(cpa.embedded, true);
  assert.equal(cpa.originalWindow, false);
  assert.equal(cpa.api.via, "codingTools.apps");
  assert.equal(cpa.api.transport, "in-process");
  assert.equal(cpa.url, "http://127.0.0.1:8317/management.html#/oauth");
  assert.deepEqual(calls, [["inspect", "cpa"]]);
  controller.dispose();
});

test("retired managed Paseo is refused before service lookup or start", async () => {
  const calls = [];
  const controller = controllerFor([service("paseo")], {
    snapshot: () => { calls.push("snapshot"); return { services: [service("paseo")] }; },
    inspect: async () => { calls.push("inspect"); },
    start: async () => { calls.push("start"); },
  });
  await assert.rejects(controller.openEmbedded("paseo", "workspaces"), /Unknown original UI/);
  assert.deepEqual(calls, []);
  controller.dispose();
});

test("retired Anneal is refused before dependency probe or open", async () => {
  assert.equal(
    classifyOriginalUiUnavailable("anneal", "password authentication failed for user postgres").dependency,
    "postgres",
  );
  const calls = [];
  const controller = controllerFor([service("anneal", { status: "error", error: "password authentication failed for user postgres" })], {
    snapshot: () => { calls.push("snapshot"); return { services: [] }; },
    inspect: async () => { calls.push("inspect"); },
    start: async () => { calls.push("start"); },
  });
  await assert.rejects(controller.openEmbedded("anneal", "tasks"), /Unknown original UI/);
  await assert.rejects(controller.openExternalTool("anneal", "tasks"), /Unknown original UI/);
  assert.deepEqual(calls, []);
  controller.dispose();
});

test("CPA long-run wrapper passes CPA open and rejects retired original UIs", async () => {
  const core = controllerFor([service("cpa")]);
  const wrapped = attachCpaCodexLongRun(core, { resumeOnCreate: false });
  const opened = await wrapped.openEmbedded("cpa", "oauth");
  assert.equal(opened.api.via, "codingTools.apps");
  assert.equal(opened.url, "http://127.0.0.1:8317/management.html#/oauth");
  assert.equal(opened.originalWindow, false);
  for (const id of ["paseo", "anneal", "codex-router"]) {
    await assert.rejects(wrapped.openEmbedded(id, "agents"), /Unknown original UI/);
  }
  wrapped.dispose();
});

test("managed upstream open rejects Paseo and Anneal before service or external open", async () => {
  const calls = [];
  const controller = createUpstreamToolController({
    env: {},
    openExternal: () => { calls.push("open"); },
    externalServices: {
      snapshot: () => { calls.push("snapshot"); return { services: [] }; },
      inspect: async () => { calls.push("inspect"); },
      start: async () => { calls.push("start"); },
      upstreamConfiguration: () => { calls.push("configuration"); return null; },
    },
  });
  for (const id of ["paseo", "anneal"]) {
    await assert.rejects(controller.openEmbeddedTool(id, "settings"), /Unknown upstream tool/);
    await assert.rejects(controller.openExternalTool(id, "settings"), /Unknown upstream tool/);
  }
  assert.deepEqual(calls, []);
  controller.dispose();
});

test("CPA embedded frame fills its workspace", () => {
  const styles = read("src/features/original-ui.css");
  const cpa = styles.match(/\.original-ui-surface\[data-tool="cpa"\]\s*\{([^}]+)\}/)?.[1];
  assert.ok(cpa, "CPA has a scoped full-pane sizing rule");
  assert.match(cpa, /height:\s*100%\s*;/);
  assert.match(styles, /\.original-ui-frame-shell iframe\s*\{[^}]*width:\s*100%\s*;[^}]*height:\s*100%\s*;/);
});

test("desktop mounts CPA Management Center through Coding Tools APIs without retired standalone screens", () => {
  const original = read("src/features/OriginalUiSurface.tsx");
  const app = read("src/App.tsx");
  const main = read("electron/main.cjs");
  assert.match(original, /codingTools\?\.apps/);
  assert.match(original, /operation: "inspect"/);
  assert.match(original, /<iframe/);
  assert.match(original, /data-transport="in-process"/);
  assert.match(app, /<OriginalUiSurface[^>]*toolId="cpa"/);
  assert.doesNotMatch(app, /toolId="(?:codex-router|paseo|anneal)"/);
  assert.doesNotMatch(app, /<UpstreamToolSurface/);
  assert.doesNotMatch(app, /<AnnealTasksSurface/);
  assert.match(main, /createCodingToolsAppsHost/);
  assert.match(main, /coding-tools:apps:call/);
  assert.match(main, /originalUiController = createOriginalUiController\(/);
  assert.match(main, /originalUiController\.copyCpaManagementKey\(clipboard\)/);
});
