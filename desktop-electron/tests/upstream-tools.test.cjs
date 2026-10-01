"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createUpstreamToolController,
  normalizeLoopbackEndpoint,
  sectionUrl,
} = require("../electron/upstream-tools.cjs");

test("upstream endpoints are restricted to explicit loopback hosts", () => {
  assert.equal(normalizeLoopbackEndpoint("http://127.0.0.1:6768"), "http://127.0.0.1:6768/");
  assert.equal(normalizeLoopbackEndpoint("http://[::1]:3000"), "http://[::1]:3000/");
  assert.throws(() => normalizeLoopbackEndpoint("https://example.com"), /127\.0\.0\.1/);
  assert.throws(() => normalizeLoopbackEndpoint("http://user:secret@127.0.0.1:3000"), /credentials/);
  assert.throws(() => normalizeLoopbackEndpoint("file:///tmp/anneal"), /HTTP or HTTPS/);
});

test("retired upstream catalog refuses endpoint changes before touching services", () => {
  const calls = [];
  const controller = createUpstreamToolController({
    env: {},
    externalServices: {
      configure: () => calls.push("configure"),
      snapshot: () => { calls.push("snapshot"); return { services: [] }; },
      upstreamConfiguration: () => { calls.push("configuration"); return null; },
    },
  });
  const snapshot = controller.snapshot();
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.tools, []);
  for (const id of ["paseo", "anneal"]) {
    assert.throws(() => controller.setEndpoint(id, "http://127.0.0.1:7777"), /Unknown upstream tool/);
  }
  assert.deepEqual(calls, []);
  controller.dispose();
});

test("section URLs stay inside the selected loopback service", () => {
  const manifest = {
    id: "anneal",
    sections: ["tasks", "settings"],
    sectionPaths: { tasks: "/tasks", settings: "/settings" },
  };
  assert.equal(
    sectionUrl(manifest, "http://127.0.0.1:3000/", "tasks"),
    "http://127.0.0.1:3000/tasks",
  );
  assert.throws(
    () => sectionUrl(manifest, "http://127.0.0.1:3000/", "secrets"),
    /Unsupported anneal section/,
  );
});

test("Anneal hash routes and Paseo Expo paths stay on loopback", () => {
  const anneal = {
    id: "anneal",
    sections: ["tasks"],
    sectionPaths: { tasks: "#/tasks" },
  };
  const paseo = {
    id: "paseo",
    sections: ["agents", "workspaces"],
    sectionPaths: { agents: "/sessions", workspaces: "/open-project" },
  };
  assert.equal(
    sectionUrl(anneal, "http://127.0.0.1:3000/", "tasks"),
    "http://127.0.0.1:3000/#/tasks",
  );
  assert.equal(
    sectionUrl(paseo, "http://127.0.0.1:6768/", "agents"),
    "http://127.0.0.1:6768/sessions",
  );
  assert.equal(
    sectionUrl(paseo, "http://127.0.0.1:6768/", "workspaces"),
    "http://127.0.0.1:6768/open-project",
  );
});
