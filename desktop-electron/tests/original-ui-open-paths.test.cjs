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
const { createUpstreamToolController, sectionUrl: upstreamSectionUrl } = require("../electron/upstream-tools.cjs");

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

test("original UI covers CPA, Codex Router, Paseo, and Anneal loopback manifests", () => {
  assert.deepEqual(TOOL_IDS, ["cpa", "codex-router", "paseo", "anneal"]);
  assert.deepEqual(IFRAME_TOOL_IDS, ["cpa", "paseo", "anneal"]);
  const paseo = loadManifest("paseo");
  const anneal = loadManifest("anneal");
  assert.equal(
    sectionUrl(paseo, paseo.defaultEndpoint, "agents"),
    "http://127.0.0.1:6768/sessions",
  );
  assert.equal(
    sectionUrl(anneal, anneal.defaultEndpoint, "tasks"),
    "http://127.0.0.1:5173/#/tasks",
  );
  assert.equal(
    upstreamSectionUrl(anneal, anneal.defaultEndpoint, "inbox"),
    "http://127.0.0.1:5173/#/inbox",
  );
});

test("original-ui-open attaches to an already-ready headless service without starting again", async () => {
  const calls = [];
  const controller = controllerFor([service("paseo"), service("cpa")], {
    start: async (id) => { calls.push(["start", id]); },
    installManagedComponent: async (id) => { calls.push(["install", id]); },
  });

  const paseo = await controller.openEmbedded("paseo", "sessions");
  const cpa = await controller.openEmbedded("cpa", "oauth");
  assert.equal(paseo.embedded, true);
  assert.equal(paseo.originalWindow, false);
  assert.equal(paseo.api.via, "codingTools.apps");
  assert.equal(paseo.api.transport, "in-process");
  assert.equal(paseo.url, "http://127.0.0.1:6768/sessions");
  assert.equal(cpa.url, "http://127.0.0.1:8317/management.html#/oauth");
  assert.deepEqual(calls, []);
  controller.dispose();
});

test("original-ui-open starts a managed Paseo runtime when the headless API is not ready yet", async () => {
  const calls = [];
  let status = "offline";
  const controller = controllerFor([service("paseo", { status, pid: null })], {
    snapshot: () => ({ services: [service("paseo", { status, pid: status === "ready" ? 11 : null })] }),
    start: async (id) => {
      calls.push(["start", id]);
      status = "ready";
    },
  });

  const opened = await controller.openEmbedded("paseo", "workspaces");
  assert.deepEqual(calls, [["start", "paseo"]]);
  assert.equal(opened.api.via, "codingTools.apps");
  assert.equal(opened.url, "http://127.0.0.1:6768/open-project");
  assert.equal(opened.embedded, true);
  assert.equal(opened.tool.status, "ready");
  controller.dispose();
});

test("Anneal original UI stays in the Coding Tools window when Postgres is down", async () => {
  assert.equal(
    classifyOriginalUiUnavailable("anneal", "password authentication failed for user postgres").dependency,
    "postgres",
  );
  const controller = controllerFor([service("anneal", {
    status: "error",
    pid: null,
    error: "password authentication failed for user postgres",
  })], {
    start: async () => {
      throw new Error("password authentication failed for user postgres");
    },
  });

  const opened = await controller.openEmbedded("anneal", "tasks");
  assert.equal(opened.unavailable, true);
  assert.equal(opened.dependency, "postgres");
  assert.equal(opened.url, "");
  assert.equal(opened.embedded, true);
  assert.equal(opened.api.via, "codingTools.apps");
  assert.match(opened.error, /postgres/i);
  controller.dispose();
});

test("CPA/Codex long-run wrapping still passes Paseo and Anneal open through to the module API host", async () => {
  const core = controllerFor([service("paseo"), service("anneal")]);
  const wrapped = attachCpaCodexLongRun(core, { resumeOnCreate: false });
  const opened = await wrapped.openEmbedded("paseo", "agents");
  assert.equal(opened.api.via, "codingTools.apps");
  assert.equal(opened.url, "http://127.0.0.1:6768/sessions");
  assert.equal(opened.originalWindow, false);
  wrapped.dispose();
});

test("managed-app openEmbeddedTool starts Paseo when needed and degrades Anneal without throwing", async () => {
  const calls = [];
  let paseoStatus = "offline";
  const paseo = createUpstreamToolController({
    env: {},
    now: () => "2026-09-19T00:00:00.000Z",
    externalServices: {
      snapshot: () => ({
        services: [service("paseo", { status: paseoStatus, pid: paseoStatus === "ready" ? 9 : null })],
      }),
      inspect: async () => {},
      start: async (id) => {
        calls.push(["start", id]);
        paseoStatus = "ready";
      },
      configure() {},
      upstreamConfiguration: () => ({ endpoint: "http://127.0.0.1:6768/", home: "/tmp/paseo-home" }),
    },
  });
  const opened = await paseo.openEmbeddedTool("paseo", "settings");
  assert.deepEqual(calls, [["start", "paseo"]]);
  assert.equal(opened.api.via, "codingTools.apps");
  assert.equal(opened.url, "http://127.0.0.1:6768/settings");
  assert.equal(opened.embedded, true);
  paseo.dispose();

  const anneal = createUpstreamToolController({
    env: {},
    now: () => "2026-09-19T00:00:00.000Z",
    externalServices: {
      snapshot: () => ({
        services: [service("anneal", {
          status: "error",
          pid: null,
          error: "connection refused 127.0.0.1:5432",
        })],
      }),
      inspect: async () => {},
      start: async () => {
        throw new Error("connection refused 127.0.0.1:5432");
      },
      configure() {},
      upstreamConfiguration: () => ({ endpoint: "http://127.0.0.1:5173/", home: "/tmp/anneal-home" }),
    },
  });
  const degraded = await anneal.openEmbeddedTool("anneal", "inbox");
  assert.equal(degraded.unavailable, true);
  assert.equal(degraded.dependency, "postgres");
  assert.equal(degraded.url, "");
  anneal.dispose();
});

test("CPA and Codex Router embedded frames fill their workspaces", () => {
  const styles = read("src/features/original-ui.css");
  const cpa = styles.match(/\.original-ui-surface\[data-tool="cpa"\]\s*\{([^}]+)\}/)?.[1];
  const router = styles.match(/\.original-ui-surface\[data-tool="codex-router"\]\s*\{([^}]+)\}/)?.[1];
  assert.ok(cpa, "CPA has a scoped full-pane sizing rule");
  assert.ok(router, "Codex Router has a scoped full-pane sizing rule");
  assert.match(cpa, /height:\s*100%\s*;/);
  assert.match(router, /height:\s*100%\s*;/);
  assert.match(styles, /\.original-ui-frame-shell iframe\s*\{[^}]*width:\s*100%\s*;[^}]*height:\s*100%\s*;/);
});

test("desktop screens inspect modules through Coding Tools APIs without auto-opening standalone UIs", () => {
  const original = read("src/features/OriginalUiSurface.tsx");
  const upstream = read("src/features/UpstreamToolSurface.tsx");
  const app = read("src/App.tsx");
  const types = read("src/types.ts");
  const main = read("electron/main.cjs");

  assert.match(original, /codingTools\?\.apps/);
  assert.match(original, /operation: "inspect"/);
  assert.match(original, /data-dependency="postgres"/);
  assert.match(original, /standalone app window is not launched/);
  assert.match(original, /<iframe/);
  assert.match(original, /data-transport="in-process"/);
  assert.match(upstream, /codingTools\?\.apps/);
  assert.match(upstream, /data-dependency="postgres"/);
  assert.match(upstream, /openEmbeddedTool/);
  assert.doesNotMatch(upstream, /startUpstreamTool/);
  assert.match(app, /toolId="cpa"/);
  assert.doesNotMatch(app, /toolId="codex-router"/);
  assert.match(app, /<UpstreamToolSurface/);
  assert.match(app, /PaseoOrchestratorSurface/);
  assert.match(app, /AnnealTasksSurface/);
  assert.match(types, /OriginalUiId = "cpa" \| "codex-router" \| "paseo" \| "anneal"/);
  assert.match(main, /createCodingToolsAppsHost/);
  assert.match(main, /coding-tools:apps:call/);
  assert.match(main, /createLazyFactory\(\(\) => createFiveStackControlPlane/);
});
