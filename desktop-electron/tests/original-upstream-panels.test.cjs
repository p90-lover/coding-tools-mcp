"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
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
  assert.match(surface, /openEmbeddedTool/);
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
