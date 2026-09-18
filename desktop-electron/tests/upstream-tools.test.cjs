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

test("controller exposes the exact pinned Paseo and Anneal manifests", () => {
  const controller = createUpstreamToolController({
    env: {},
    now: () => "2026-09-17T00:00:00.000Z",
  });
  const snapshot = controller.snapshot();
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.tools.map((tool) => tool.id), ["anneal", "paseo"]);

  const anneal = snapshot.tools.find((tool) => tool.id === "anneal");
  const paseo = snapshot.tools.find((tool) => tool.id === "paseo");
  assert.equal(anneal.repository, "mosonlab/anneal");
  assert.equal(anneal.license, "MIT");
  assert.equal(anneal.commit, "e43b72b10ad389f090a0be18eea5d2bcef468f5e");
  assert.equal(paseo.repository, "getpaseo/paseo");
  assert.equal(paseo.license, "Apache-2.0");
  assert.equal(paseo.commit, "1e4ba65c6d75a6b061a1d54141f2f105b5908a96");

  const changed = controller.setEndpoint("paseo", "http://127.0.0.1:7777");
  assert.equal(changed.endpoint, "http://127.0.0.1:7777/");
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
