"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createOriginalUiController } = require("../electron/original-ui.cjs");
const { createUpstreamToolController } = require("../electron/upstream-tools.cjs");

function service(id, { status = "offline", installState = "not-installed", error = null } = {}) {
  return {
    id,
    endpoint: id === "anneal" ? "http://127.0.0.1:5173/" : "http://127.0.0.1:6768/",
    status,
    pid: status === "ready" ? 7 : null,
    error,
    enabled: true,
    home: `C:/managed/${id}`,
    sourceConfigured: installState !== "not-installed",
    managedInstall: { state: installState },
  };
}

for (const installState of ["not-installed", "repair-required", "error"]) {
  test(`original read-only open does not mutate an Anneal ${installState} install`, async () => {
    const lifecycle = [];
    const current = service("anneal", { status: "offline", installState });
    const controller = createOriginalUiController({
      longRun: false,
      externalServices: {
        snapshot: () => ({ services: [current] }),
        inspect: async () => {},
        start: async () => { lifecycle.push("start"); throw Error("unexpected navigation start"); },
        installManagedComponent: async () => { lifecycle.push("install"); throw Error("unexpected navigation install"); },
        repairManagedComponent: async () => { lifecycle.push("repair"); throw Error("unexpected navigation repair"); },
      },
    });

    const opened = await controller.openEmbedded("anneal", "tasks");

    assert.deepEqual(lifecycle, []);
    assert.equal(opened.unavailable, true);
    assert.equal(opened.tool.status, "offline");
    assert.equal(opened.dependency, null);
    assert.equal(opened.url, "");
    controller.dispose();
  });
}

test("original ready open remains read-only and returns its embedded URL", async () => {
  const lifecycle = [];
  const controller = createOriginalUiController({
    longRun: false,
    externalServices: {
      snapshot: () => ({ services: [service("anneal", { status: "ready", installState: "installed" })] }),
      inspect: async () => {},
      start: async () => { lifecycle.push("start"); },
    },
  });

  const opened = await controller.openEmbedded("anneal", "tasks");

  assert.deepEqual(lifecycle, []);
  assert.equal(opened.unavailable, undefined);
  assert.equal(opened.url, "http://127.0.0.1:5173/#/tasks");
  controller.dispose();
});

for (const installState of ["not-installed", "repair-required", "error"]) {
  test(`upstream read-only open does not mutate an Anneal ${installState} install`, async () => {
    const lifecycle = [];
    const current = service("anneal", { status: "offline", installState });
    const controller = createUpstreamToolController({
      env: {},
      externalServices: {
        snapshot: () => ({ services: [current] }),
        inspect: async () => {},
        start: async () => {
          lifecycle.push("start");
          throw new Error("navigation must not start Anneal");
        },
        configure() {},
        upstreamConfiguration: () => ({ endpoint: current.endpoint, home: current.home }),
      },
    });

    const opened = await controller.openEmbeddedTool("anneal", "tasks");

    assert.deepEqual(lifecycle, []);
    assert.equal(opened.unavailable, true);
    assert.equal(opened.tool.status, "offline");
    assert.equal(opened.dependency, null);
    assert.equal(opened.url, "");
    controller.dispose();
  });
}

test("upstream ready open remains read-only and returns its embedded URL", async () => {
  const lifecycle = [];
  const current = service("anneal", { status: "ready", installState: "installed" });
  const controller = createUpstreamToolController({
    env: {},
    externalServices: {
      snapshot: () => ({ services: [current] }),
      inspect: async () => {},
      start: async () => { lifecycle.push("start"); },
      configure() {},
      upstreamConfiguration: () => ({ endpoint: current.endpoint, home: current.home }),
    },
  });

  const opened = await controller.openEmbeddedTool("anneal", "tasks");

  assert.deepEqual(lifecycle, []);
  assert.equal(opened.unavailable, undefined);
  assert.equal(opened.url, "http://127.0.0.1:5173/#/tasks");
  controller.dispose();
});
